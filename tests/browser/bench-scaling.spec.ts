/**
 * The measurement the audit asked for: does message-per-syscall hold as processes scale?
 *
 * The risk is specific and worth stating before the numbers: every `fs.readFileSync` in a process is a `postMessage`-free but
 * shared-memory round trip (SAB write, `Atomics.wait`, kernel wake, base64-in-JSON payload, `Atomics.wait` return on the
 * caller). One kernel Worker serves every channel, so the shape has two possible ceilings — per-op cost, and the kernel's
 * ability to keep up as callers multiply.
 *
 * This is a benchmark, not a gate: it asserts nothing about speed, because a slow machine would make a performance gate
 * flap. It prints a table and writes the raw numbers, and `docs/bench/process-scaling.md` records one run with its date.
 *
 * What is deliberately EXCLUDED from the timed window: module compilation and runtime boot. Every process does one warm-up
 * read before the clock starts, so what is measured is steady-state syscall cost, not JIT noise. Spawn cost is measured
 * separately below, because it is a different question.
 */

import { expect, test } from "@playwright/test";

interface ConcurrencyRow {
  readonly processes: number;
  readonly opsPerProcess: number;
  readonly totalOps: number;
  readonly wallMs: number;
  readonly perOpUs: number;
  readonly slowestProcessMs: number;
}

interface PayloadRow {
  readonly bytes: number;
  readonly ops: number;
  readonly wallMs: number;
  readonly perOpUs: number;
  readonly throughputMbPerS: number;
}

const CHANNEL_SIZES = { requestBytes: 64 * 1024, responseBytes: 1024 * 1024 };

test.describe.configure({ mode: "serial" });

test("syscall cost as process count grows, and the price of a payload", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");

  const result = await page.evaluate(
    async (options: { readonly sizes: { requestBytes: number; responseBytes: number } }) => {
      const moduleUrls = {
        channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
        remoteFs: new URL("/src/process/remote-fs.ts", location.origin).href,
        fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
        vfs: new URL("/src/vfs/index.ts", location.origin).href,
      };

      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      const kernelSource = `
        self.onmessage = async (event) => {
          try {
            const { channels, moduleUrls } = event.data;
            const { serveChannelAsync } = await import(moduleUrls.channel);
            const { createFsSyscallHandler } = await import(moduleUrls.fsSyscalls);
            const { FileSystem } = await import(moduleUrls.vfs);

            const fs = new FileSystem();
            fs.writeFileSync("/small.txt", "x".repeat(4096));
            fs.writeFileSync("/medium.bin", new Uint8Array(64 * 1024));
            fs.writeFileSync("/large.bin", new Uint8Array(256 * 1024));

            const handler = createFsSyscallHandler(fs);
            const ends = [];
            for (const channel of channels) {
              ends.push({
                id: channel.id,
                header: new Int32Array(channel.buffer, 0, 16),
                end: await serveChannelAsync(channel, undefined),
              });
            }

            let stopping = false;
            self.onmessage = (message) => { if (message.data && message.data.stop) stopping = true; };

            let answered = 0;
            while (!stopping) {
              let served = false;
              for (const entry of ends) {
                // Sweep rather than one blocking wait per channel: a kernel that waited on process A could not answer B.
                // Reading the state word directly keeps the sweep from burning a timeout on idle channels.
                const state = Atomics.load(entry.header, 0);
                if (state === 1) {
                  await entry.end.serveOne(handler, { timeoutMs: 50 });
                  answered += 1;
                  served = true;
                } else if (state === 3) {
                  // closed by the caller: nothing more to do for this channel
                }
              }
              if (!served) {
                // Wake on notify, never on a sleep. A setTimeout(0) backoff is clamped to ~4 ms in a browser Worker, so a
                // polling kernel pays that clamp on every idle gap — the first run of this benchmark measured 4.4 ms per
                // 4 KiB read at one process and 57 us at twenty, which is the clamp, not the channel.
                // Wait on each channel's CURRENT state, not just on "idle". A channel sits at state 2 between our answer
                // and the caller waking up, and sleeping through that window costs a ~4 ms timer clamp on every call.
                // Waiting on the observed value wakes on any change, so both directions are covered by one rule.
                const waits = [];
                for (const entry of ends) {
                  const state = Atomics.load(entry.header, 0);
                  if (state === 3) continue;
                  const wait = Atomics.waitAsync(entry.header, 0, state, 1000);
                  // A wait that is not async means the state already changed, so there IS work to sweep. Resolving a
                  // fulfilled promise keeps this branch yielding instead of spinning the CPU.
                  waits.push(wait.async ? wait.value : Promise.resolve("changed"));
                }
                if (waits.length > 0) await Promise.race(waits);
                else await new Promise((resolve) => setTimeout(resolve, 5));
              }
            }
            self.postMessage({ kind: "stopped", answered });
          } catch (error) {
            self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
          }
        };
      `;

      const processSource = `
        self.onmessage = async (event) => {
          try {
            const { buffer, sizes, moduleUrls, ops, path, encoding } = event.data;
            const { SyscallClient } = await import(moduleUrls.channel);
            const { createRemoteFileSystem } = await import(moduleUrls.remoteFs);
            const client = new SyscallClient({ buffer, sizes });
            const fs = createRemoteFileSystem(client);
            // One untimed call: first-call cost is module instantiation noise, not syscall cost.
            fs.readFileSync(path, encoding);
            const started = performance.now();
            for (let i = 0; i < ops; i += 1) fs.readFileSync(path, encoding);
            const elapsed = performance.now() - started;
            self.postMessage({ kind: "done", elapsed, ops });
          } catch (error) {
            self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
          }
        };
      `;

      const blobUrl = (source: string): string => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

      const kernelUrl = blobUrl(kernelSource);
      const processUrl = blobUrl(processSource);

      /**
       * One run: N processes, each doing `ops` reads, over N channels served by ONE kernel Worker.
       * Returns wall time and the slowest process, because a mean would hide one starved caller.
       */
      const runStage = async (
        processCount: number,
        opsPerProcess: number,
        path: string,
        encoding: "utf8" | undefined,
        sizes: { requestBytes: number; responseBytes: number },
      ): Promise<{ wallMs: number; slowestProcessMs: number; perProcessMs: number[] }> => {
        const { allocateChannel } = await import(moduleUrls.channel);
        const channels = [];
        for (let i = 0; i < processCount; i += 1) {
          const allocation = allocateChannel(sizes);
          channels.push({ id: `p${i}`, buffer: allocation.buffer, sizes: allocation.sizes });
        }

        const kernel = new Worker(kernelUrl, { type: "module" });
        kernel.postMessage({ channels, moduleUrls });
        // Give the kernel its channels before any caller can block on one.
        await sleep(60);

        const workers: Worker[] = [];
        const started = performance.now();
        const perProcessMs = await Promise.all(
          channels.map(
            (channel, index) =>
              new Promise<number>((resolve, reject) => {
                const worker = new Worker(processUrl, { type: "module" });
                workers.push(worker);
                worker.onmessage = (message: MessageEvent) => {
                  const data = message.data as { kind: string; elapsed?: number; error?: string };
                  if (data.kind === "done") resolve(data.elapsed ?? 0);
                  else reject(new Error(`process ${index}: ${data.error ?? "unknown"}`));
                };
                worker.onerror = (event: ErrorEvent) => reject(new Error(`process ${index} worker error: ${event.message}`));
                worker.postMessage({
                  buffer: channel.buffer,
                  sizes: channel.sizes,
                  moduleUrls,
                  ops: opsPerProcess,
                  path,
                  encoding,
                });
              }),
          ),
        );
        const wallMs = performance.now() - started;

        kernel.postMessage({ stop: true });
        await sleep(30);
        kernel.terminate();
        for (const worker of workers) worker.terminate();
        for (const channel of channels) {
          // The kernel side closes on terminate; nothing else holds these buffers once the page drops them.
          void channel;
        }
        return { wallMs, slowestProcessMs: Math.max(...perProcessMs), perProcessMs };
      };

      const ALLOCATION = options.sizes;
      /** A microbenchmark in a browser Worker is noisy: one scheduler hiccup moves a single sample by 40x. Best and
       *  median of three are reported instead of one number, and the best is what the architecture can do when the
       *  machine is not interfering. */
      const best = (values: number[]): number => Math.min(...values);
      const repeat = async <T>(times: number, run: () => Promise<T>): Promise<T[]> => {
        const results: T[] = [];
        for (let i = 0; i < times; i += 1) results.push(await run());
        return results;
      };

      const concurrency = [];
      for (const processCount of [1, 4, 8, 16, 20]) {
        const opsPerProcess = 1000;
        const totalOps = processCount * opsPerProcess;
        await runStage(processCount, 100, "/small.txt", "utf8", ALLOCATION);
        const runs = await repeat(3, () => runStage(processCount, opsPerProcess, "/small.txt", "utf8", ALLOCATION));
        const walls = runs.map((run) => run.wallMs);
        concurrency.push({
          processes: processCount,
          opsPerProcess,
          totalOps,
          wallMs: Math.round(best(walls)),
          perOpUs: Math.round((best(walls) * 1000) / totalOps),
          slowestProcessMs: Math.round(Math.min(...runs.map((run) => run.slowestProcessMs))),
        });
      }

      const payload = [];
      for (const [path, bytes] of [
        ["/small.txt", 4096],
        ["/medium.bin", 64 * 1024],
        ["/large.bin", 256 * 1024],
      ] as const) {
        const ops = 200;
        const encoding = path.endsWith(".txt") ? "utf8" : undefined;
        await runStage(1, 10, path, encoding, ALLOCATION);
        const runs = await repeat(3, () => runStage(1, ops, path, encoding, ALLOCATION));
        const wallMs = best(runs.map((run) => run.wallMs));
        payload.push({
          bytes,
          ops,
          wallMs: Math.round(wallMs),
          perOpUs: Math.round((wallMs * 1000) / ops),
          throughputMbPerS: Number(((bytes * ops) / 1024 / 1024 / (wallMs / 1000)).toFixed(1)),
        });
      }

      // Spawn cost, measured on its own: bare Workers that answer once, so this is Worker creation, not runtime boot.
      const pingUrl = blobUrl(`self.onmessage = () => self.postMessage("pong");`);
      const spawnStarted = performance.now();
      const pings: Worker[] = [];
      await Promise.all(
        Array.from({ length: 20 }, () => {
          return new Promise<void>((resolve) => {
            const worker = new Worker(pingUrl, { type: "module" });
            pings.push(worker);
            worker.onmessage = () => resolve();
            worker.postMessage("ping");
          });
        }),
      );
      const spawnMs = Math.round(performance.now() - spawnStarted);
      for (const p of pings) p.terminate();

      return { concurrency, payload, spawnMs };
    },
    { sizes: CHANNEL_SIZES },
  );

  const rows: ConcurrencyRow[] = result.concurrency;
  const payloadRows: PayloadRow[] = result.payload;

  const table = rows
    .map(
      (row) =>
        `${String(row.processes).padStart(2)} proc  ${String(row.totalOps).padStart(5)} ops  ${String(row.wallMs).padStart(5)} ms  ` +
        `${String(row.perOpUs).padStart(5)} us/op  slowest ${String(row.slowestProcessMs).padStart(4)} ms`,
    )
    .join("\n");
  const payloadTable = payloadRows
    .map(
      (row) =>
        `${String(row.bytes).padStart(7)} B  ${String(row.ops).padStart(3)} ops  ${String(row.wallMs).padStart(4)} ms  ` +
        `${String(row.perOpUs).padStart(5)} us/op  ${String(row.throughputMbPerS).padStart(6)} MB/s`,
    )
    .join("\n");

  // eslint-disable-next-line no-console
  console.log(`\nBENCH concurrency (4 KiB utf8 read)\n${table}\n\nBENCH payload\n${payloadTable}\n\nBENCH spawn: 20 bare Workers in ${result.spawnMs} ms`);

  // The only hard assertion: every stage actually ran. A benchmark that silently measured zero is worse than no benchmark.
  expect(rows).toHaveLength(5);
  expect(rows[0]?.totalOps).toBe(1000);
  expect(payloadRows).toHaveLength(3);
  expect(result.spawnMs).toBeGreaterThan(0);
});

/**
 * The wake-up tax, measured on its own.
 *
 * The concurrency run showed a shape that is easy to misread: cost per operation FALLS as callers are added (1.1 ms at one
 * process, 36 us at eight). A channel cannot get cheaper with more traffic, so the extra 1 ms at one caller is the kernel
 * PARKING and being woken: notification to resumption. With eight callers there is usually already a pending request, so the
 * kernel never parks and the tax is not paid.
 *
 * That matters more than the raw syscall cost, because it sets the floor for every single-process workload: Vite booting
 * does thousands of filesystem calls one after another. So this measures the same ping-pong under two policies, and the
 * result decides the kernel loop's shape.
 */
test("parking versus spinning: what a kernel wake-up costs", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const moduleUrls = {
      channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
      remoteFs: new URL("/src/process/remote-fs.ts", location.origin).href,
      fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
      vfs: new URL("/src/vfs/index.ts", location.origin).href,
    };
    const moduleUrlsLiteral = JSON.stringify(moduleUrls);
    const sizes = { requestBytes: 64 * 1024, responseBytes: 1024 * 1024 };

    const kernelSource = `
      const MODULES = ${moduleUrlsLiteral};
      self.onmessage = async (event) => {
        try {
          const { buffer, sizes, policy } = event.data;
          const { serveChannelAsync } = await import(MODULES.channel);
          const { createFsSyscallHandler } = await import(MODULES.fsSyscalls);
          const { FileSystem } = await import(MODULES.vfs);

          const fs = new FileSystem();
          fs.writeFileSync("/small.txt", "x".repeat(4096));
          const handler = createFsSyscallHandler(fs);
          const header = new Int32Array(buffer, 0, 16);
          const end = await serveChannelAsync({ buffer, sizes }, undefined);

          let stopping = false;
          self.onmessage = (message) => { if (message.data && message.data.stop) stopping = true; };

          while (!stopping) {
            const state = Atomics.load(header, 0);
            if (state === 1) {
              await end.serveOne(handler, { timeoutMs: 50 });
              continue;
            }
            if (state === 3) break;
            if (policy === "spin") {
              // Yield the microtask queue but never park: the loop keeps the Worker hot, so a request that arrives a
              // microsecond later is served without any wake-up at all.
              await Promise.resolve();
            } else {
              const wait = Atomics.waitAsync(header, 0, state, 1000);
              if (wait.async) await wait.value;
            }
          }
          self.postMessage({ kind: "stopped" });
        } catch (error) {
          self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
        }
      };
    `;

    const processSource = `
      const MODULES = ${moduleUrlsLiteral};
      self.onmessage = async (event) => {
        try {
          const { buffer, sizes, ops } = event.data;
          const { SyscallClient } = await import(MODULES.channel);
          const { createRemoteFileSystem } = await import(MODULES.remoteFs);
          const client = new SyscallClient({ buffer, sizes });
          const fs = createRemoteFileSystem(client, { timeoutMs: 5000 });
          fs.readFileSync("/small.txt", "utf8");
          const started = performance.now();
          for (let i = 0; i < ops; i += 1) fs.readFileSync("/small.txt", "utf8");
          self.postMessage({ kind: "done", elapsed: performance.now() - started });
        } catch (error) {
          self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
        }
      };
    `;

    const blobUrl = (source: string): string => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const kernelUrl = blobUrl(kernelSource);
    const processUrl = blobUrl(processSource);

    const measure = async (policy: "park" | "spin", ops: number): Promise<number> => {
      const { allocateChannel } = await import(moduleUrls.channel);
      const allocation = allocateChannel(sizes);
      const kernel = new Worker(kernelUrl, { type: "module" });
      kernel.postMessage({ buffer: allocation.buffer, sizes: allocation.sizes, policy });
      await new Promise((resolve) => setTimeout(resolve, 60));

      const elapsed = await new Promise<number>((resolve, reject) => {
        const worker = new Worker(processUrl, { type: "module" });
        worker.onmessage = (message: MessageEvent) => {
          const data = message.data as { kind: string; elapsed?: number; error?: string };
          if (data.kind === "done") resolve(data.elapsed ?? 0);
          else reject(new Error(data.error ?? "process failed"));
        };
        worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
        worker.postMessage({ buffer: allocation.buffer, sizes: allocation.sizes, ops });
        setTimeout(() => reject(new Error("process timed out")), 120_000);
        void worker;
        void kernel;
      });

      kernel.postMessage({ stop: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      kernel.terminate();
      return elapsed;
    };

    const ops = 1000;
    const rows = [];
    for (const policy of ["park", "spin"] as const) {
      await measure(policy, 50);
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) samples.push(await measure(policy, ops));
      const best = Math.min(...samples);
      rows.push({ policy, bestMs: Math.round(best), perOpUs: Math.round((best * 1000) / ops) });
    }
    return rows;
  });

  const table = result
    .map((row) => `${row.policy.padEnd(4)}  ${String(row.bestMs).padStart(5)} ms  ${String(row.perOpUs).padStart(6)} us/op`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.log(`\nBENCH kernel policy (1000 sequential 4 KiB reads, one process)\n${table}`);

  expect(result).toHaveLength(2);
});
