/**
 * The runtime, booted inside each process Worker by the host.
 *
 * Everything here is real: a kernel Worker owning the filesystem, a `ProcessHost` spawning process Workers from the static
 * entry, and programs that the loader and shims run for real. No fixture Worker is pretending to be a process.
 *
 * Two claims. First, a process is an argv, not a module: the host is told `["node", "/work.js"]` and the program comes out
 * of the kernel's filesystem. Second, processes run at the same time, which is measured against a single-process baseline
 * rather than an absolute duration, because absolute timings only say how fast this machine is.
 *
 * The work is CPU-bound on purpose. The runtime hands a program a *virtual* clock, so `Date.now()` does not advance while
 * the program holds the thread: a busy-wait on it never ends, which is a real hazard (the process model can terminate it,
 * and the second test does), but it is not a usable measurement tool.
 */

import { expect, test } from "@playwright/test";

const KERNEL = `
  let fs = null;
  const served = [];
  self.onmessage = async (event) => {
    try {
      const message = event.data;
      const urls = message.moduleUrls;
      const { FileSystem } = await import(urls.vfs);
      if (message.type === "seed") {
        fs = new FileSystem();
        for (const [path, text] of message.files) fs.writeFileSync(path, text);
        self.postMessage({ type: "seeded" });
        return;
      }
      if (message.type === "serve") {
        const { serveChannelAsync } = await import(urls.channel);
        const { createFsSyscallHandler } = await import(urls.fsSyscalls);
        const end = await serveChannelAsync({ buffer: message.buffer, sizes: message.sizes });
        const handler = createFsSyscallHandler(fs);
        const deadline = Date.now() + message.lifetimeMs;
        // A kernel keeps serving across idle gaps: a process that is compiling has not died, it is just not asking yet.
        while (Date.now() < deadline && !end.closed()) {
          await end.serveOne((request) => {
            served.push(request.op);
            self.postMessage({ type: "op", op: request.op, path: request.path, count: served.length });
            return handler(request);
          }, { timeoutMs: 250 });
        }
        self.postMessage({ type: "stopped", count: served.length });
      }
    } catch (error) {
      self.postMessage({ type: "fatal", reason: String((error && error.stack) || error) });
    }
  };
`;

/**
 * Fixed CPU work with no clock and no I/O. The iteration count is a constant rather than a duration so that "slow" and
 * "concurrent" mean the same thing on every machine.
 *
 * Sized large deliberately: at a few million iterations the compile and JIT warm-up of the first run dominate the timing,
 * and the ratio then measures warm-up rather than concurrency.
 */
const WORK = (label: string): string =>
  [
    `let total = 0;`,
    `for (let i = 0; i < 120000000; i += 1) total += Math.sqrt(i);`,
    `console.log("${label} finished", total > 0);`,
  ].join("\n");

const SPINNER = "while (true) { /* deliberate: only termination can stop this */ }";

test("the host boots the real runtime in each process Worker, and they run at the same time", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ kernelSource, programs }) => {
      const urls = {
        channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
        fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
        vfs: new URL("/src/vfs/index.ts", location.origin).href,
      };
      const { ProcessHost } = await import(new URL("/src/process/process-host.ts", location.origin).href);

      const kernel = new Worker(URL.createObjectURL(new Blob([kernelSource], { type: "text/javascript" })), {
        type: "module",
      });
      const kernelMessages: { type: string; op?: string; path?: string; count?: number; reason?: string }[] = [];
      const kernelSays = (type: string): Promise<void> =>
        new Promise((resolve) => {
          const check = (): void => {
            if (kernelMessages.some((message) => message.type === type)) resolve();
            else setTimeout(check, 10);
          };
          check();
        });
      kernel.onmessage = (event) => kernelMessages.push(event.data);

      kernel.postMessage({ type: "seed", moduleUrls: urls, files: Object.entries(programs) });
      await kernelSays("seeded");

      const output: Record<number, string> = {};
      const host = new ProcessHost({
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const terminal = (pid: number): Promise<{ state: string; exitCode?: number }> =>
        new Promise((resolve) => {
          const started = Date.now();
          const tick = (): void => {
            const entry = host.table.get(pid) as { state: string; exitCode?: number };
            if (["exited", "failed", "killed"].includes(entry.state)) resolve(entry);
            else if (Date.now() - started > 30000) resolve({ state: "timeout" });
            else setTimeout(tick, 10);
          };
          tick();
        });

      const start = (argv: string[]): number => {
        const started = host.start({ argv });
        kernel.postMessage({
          type: "serve",
          moduleUrls: urls,
          buffer: started.allocation.buffer,
          sizes: started.allocation.sizes,
          lifetimeMs: 60000,
        });
        return started.pid;
      };

      // The pair first, the single run second: the second run benefits from a warm JIT, which makes the baseline smaller
      // and the concurrency assertion stricter rather than easier.
      const pairBegan = Date.now();
      const a = start(["node", "/work.js"]);
      const b = start(["node", "/work.js"]);
      const [first, second] = await Promise.all([terminal(a), terminal(b)]);
      const pair = Date.now() - pairBegan;

      const singleBegan = Date.now();
      const solo = start(["node", "/work.js"]);
      const third = await terminal(solo);
      const single = Date.now() - singleBegan;

      const opsServed = kernelMessages.filter((message) => message.type === "op").length;
      const fatal = kernelMessages.find((message) => message.type === "fatal");
      kernel.terminate();

      return { first, second, third, pair, single, output, opsServed, fatal };
    },
    { kernelSource: KERNEL, programs: { "/work.js": WORK("work") } },
  );

  expect(outcome.fatal).toBeUndefined();
  for (const entry of [outcome.first, outcome.second, outcome.third]) {
    expect(entry.state).toBe("exited");
    expect(entry.exitCode).toBe(0);
  }
  expect(Object.values(outcome.output).join("")).toContain("work finished");
  // The filesystem really was in the kernel: every read crossed the channel.
  expect(outcome.opsServed).toBeGreaterThan(0);
  // Two concurrent processes doing the same fixed work should cost well under twice one process doing it.
  expect(outcome.pair).toBeLessThan(outcome.single * 1.7);
});

test("killing a real process stops its program, and leaves the host usable", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ kernelSource, programs }) => {
      const urls = {
        channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
        fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
        vfs: new URL("/src/vfs/index.ts", location.origin).href,
      };
      const { ProcessHost } = await import(new URL("/src/process/process-host.ts", location.origin).href);

      const kernel = new Worker(URL.createObjectURL(new Blob([kernelSource], { type: "text/javascript" })), {
        type: "module",
      });
      const seen: { type: string }[] = [];
      kernel.onmessage = (event) => seen.push(event.data);
      kernel.postMessage({ type: "seed", moduleUrls: urls, files: Object.entries(programs) });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const output: Record<number, string> = {};
      const host = new ProcessHost({
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });
      const start = (argv: string[]): number => {
        const started = host.start({ argv });
        kernel.postMessage({
          type: "serve",
          moduleUrls: urls,
          buffer: started.allocation.buffer,
          sizes: started.allocation.sizes,
          lifetimeMs: 60000,
        });
        return started.pid;
      };
      const terminal = (pid: number): Promise<{ state: string; exitCode?: number }> =>
        new Promise((resolve) => {
          const began = Date.now();
          const tick = (): void => {
            const entry = host.table.get(pid) as { state: string; exitCode?: number };
            if (["exited", "failed", "killed"].includes(entry.state)) resolve(entry);
            else if (Date.now() - began > 30000) resolve({ state: "timeout" });
            else setTimeout(tick, 10);
          };
          tick();
        });

      const spinner = start(["node", "/spin.js"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const killed = host.kill(spinner, "test kill");
      const killedEntry = await terminal(spinner);

      // The host must still work afterwards: a kill that poisons the table is worse than no kill at all.
      const after = start(["node", "/work.js"]);
      const afterEntry = await terminal(after);

      kernel.terminate();
      return { killed, killedEntry, afterEntry, output };
    },
    { kernelSource: KERNEL, programs: { "/spin.js": SPINNER, "/work.js": WORK("work") } },
  );

  expect(outcome.killed).toBe(true);
  expect(outcome.killedEntry.state).toBe("killed");
  expect(outcome.afterEntry.state).toBe("exited");
  expect(outcome.afterEntry.exitCode).toBe(0);
  expect(Object.values(outcome.output).join("")).toContain("work finished");
});
