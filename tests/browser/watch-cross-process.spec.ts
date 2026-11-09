/**
 * `fs.watch` with real processes: one Worker watches, a different Worker writes, a third Worker owns the filesystem.
 *
 * This is the claim the registry design rests on and the one a unit test cannot make: the watching process is blocked inside
 * `Atomics.wait` most of the time, cannot be pushed to, and still receives the event. The write happens in another process
 * through its own channel, so the change is observed by the kernel rather than reported by the writer.
 *
 * The second test is the one that would rot silently in production: a process that exits holding a watch must leave nothing
 * behind, because a watch feeding a dead channel is a leak that looks like a working feature.
 */

import { expect, test } from "@playwright/test";

interface WatchOutcome {
  readonly events: Array<{ kind: string; filename: string }>;
  readonly drainedEvents: Array<{ kind: string; filename: string }>;
  readonly statsAfterExit: Array<{ owner: string; watches: number; pending: number }>;
  readonly watcherCount: number;
}

test("a process receives a filesystem change made by another process", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");

  const outcome: WatchOutcome = await page.evaluate(async () => {
    const moduleUrls = {
      channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
      remoteFs: new URL("/src/process/remote-fs.ts", location.origin).href,
      remoteWatch: new URL("/src/process/remote-watch.ts", location.origin).href,
      fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
      watchRegistry: new URL("/src/process/watch-registry.ts", location.origin).href,
      vfs: new URL("/src/vfs/index.ts", location.origin).href,
    };
    const sizes = { requestBytes: 64 * 1024, responseBytes: 256 * 1024 };

    const kernelSource = `
      self.onmessage = async (event) => {
        try {
          const { channels, moduleUrls } = event.data;
          const { serveChannelAsync } = await import(moduleUrls.channel);
          const { createFsSyscallHandler } = await import(moduleUrls.fsSyscalls);
          const { WatchRegistry } = await import(moduleUrls.watchRegistry);
          const { FileSystem } = await import(moduleUrls.vfs);

          const fs = new FileSystem();
          fs.mkdirSync("/app");
          // THE SEAM: the registry listens to the filesystem itself, so any mutation is observed by the kernel regardless of
          // which process caused it, and the writer needs no cooperation at all.
          const registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind });
          fs.subscribe((change) => registry.notify(change));

          const ends = [];
          for (const channel of channels) {
            // One handler per process, with the owner bound by the kernel: a process cannot name its own identity.
            const handler = createFsSyscallHandler(fs, { watches: registry, owner: channel.id });
            ends.push({
              id: channel.id,
              header: new Int32Array(channel.buffer, 0, 16),
              end: await serveChannelAsync(channel, undefined),
              handler,
            });
          }

          let stopping = false;
          self.onmessage = (message) => {
            const data = message.data || {};
            if (data.stop) { stopping = true; return; }
            if (data.exited) {
              // A process leaving must not leave its watches behind.
              const removed = registry.stopAll(data.exited);
              self.postMessage({ kind: "exited", id: data.exited, removed });
            }
            if (data.stats) {
              self.postMessage({ kind: "stats", stats: registry.stats(), watcherCount: fs.watcherCount });
            }
          };

          while (!stopping) {
            let served = false;
            for (const entry of ends) {
              if (Atomics.load(entry.header, 0) === 1) {
                await entry.end.serveOne(entry.handler, { timeoutMs: 50 });
                served = true;
              }
            }
            if (served) continue;
            const waits = [];
            for (const entry of ends) {
              const state = Atomics.load(entry.header, 0);
              if (state === 3) continue;
              const wait = Atomics.waitAsync(entry.header, 0, state, 1000);
              waits.push(wait.async ? wait.value : Promise.resolve("changed"));
            }
            if (waits.length > 0) await Promise.race(waits);
          }
          self.postMessage({ kind: "stopped" });
        } catch (error) {
          self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
        }
      };
    `;

    const watcherSource = `
      self.onmessage = async (event) => {
        try {
          const { buffer, sizes, moduleUrls } = event.data;
          const { SyscallClient } = await import(moduleUrls.channel);
          const { createRemoteWatcher } = await import(moduleUrls.remoteWatch);

          const client = new SyscallClient({ buffer, sizes });
          const events = [];
          const watcher = createRemoteWatcher({
            transport: { call: (request, options) => client.call(request, options) },
            path: "/app",
            // Real timers here: this is the delivery cadence, not something the test needs to control.
            scheduler: { schedule: (tick, ms) => { const id = setTimeout(tick, ms); return () => clearTimeout(id); } },
            intervalMs: 10,
          });
          watcher.on("change", (kind, filename) => { events.push({ kind, filename }); });
          watcher.on("rename", (kind, filename) => { events.push({ kind, filename }); });

          self.onmessage = (message) => {
            const data = message.data || {};
            if (data.report) self.postMessage({ kind: "report", events: events.splice(0) });
            if (data.close) { watcher.close(); self.postMessage({ kind: "closed" }); }
          };
          self.postMessage({ kind: "watching" });
        } catch (error) {
          self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
        }
      };
    `;

    const writerSource = `
      self.onmessage = async (event) => {
        try {
          const { buffer, sizes, moduleUrls, writes } = event.data;
          const { SyscallClient } = await import(moduleUrls.channel);
          const { createRemoteFileSystem } = await import(moduleUrls.remoteFs);
          const client = new SyscallClient({ buffer, sizes });
          const fs = createRemoteFileSystem(client, { timeoutMs: 5000 });
          for (let i = 0; i < writes; i += 1) fs.writeFileSync("/app/main.js", "version " + i);
          self.postMessage({ kind: "written", writes });
        } catch (error) {
          self.postMessage({ kind: "fatal", error: String((error && error.stack) || error) });
        }
      };
    `;

    const blobUrl = (source: string): string => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const urls = { kernel: blobUrl(kernelSource), watcher: blobUrl(watcherSource), writer: blobUrl(writerSource) };
    const { allocateChannel } = await import(moduleUrls.channel);

    const allocate = (): { buffer: SharedArrayBuffer; sizes: { requestBytes: number; responseBytes: number } } => {
      const allocation = allocateChannel(sizes);
      return { buffer: allocation.buffer, sizes: allocation.sizes };
    };

    const watcherChannel = allocate();
    const writerChannel = allocate();
    const channels = [
      { id: "watcher", buffer: watcherChannel.buffer, sizes: watcherChannel.sizes },
      { id: "writer", buffer: writerChannel.buffer, sizes: writerChannel.sizes },
    ];

    /** Messages are queued per worker as they arrive, so a reply that lands before a waiter exists is not lost. */
    const inbox = (worker: Worker): {
      waitFor: (kind: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
      all: () => Array<Record<string, unknown>>;
    } => {
      const received: Array<Record<string, unknown>> = [];
      const waiters: Array<{ kind: string; resolve: (message: Record<string, unknown>) => void }> = [];
      worker.onmessage = (message: MessageEvent) => {
        const data = message.data as Record<string, unknown>;
        const index = waiters.findIndex((waiter) => waiter.kind === data.kind);
        if (index >= 0) {
          // A message claimed by a waiter is DELIVERED, not also queued. Queuing it as well meant a later wait for the same
          // kind found the earlier message and returned it: the second "report" came back as the first, so a test compared
          // a report with itself. Removal here is the fix; the `findIndex` + `splice` in `waitFor` covers the other order.
          const [waiter] = waiters.splice(index, 1);
          waiter?.resolve(data);
          return;
        }
        received.push(data);
      };
      worker.onerror = (event: ErrorEvent) => {
        received.push({ kind: "worker-error", error: event.message });
      };
      return {
        all: () => [...received],
        /**
         * Wait for a message of `kind` and CONSUME it.
         *
         * Consuming is the whole point: an earlier version looked the message up without removing it, so a second wait for
         * "report" instantly returned the FIRST report. The test then compared a report against itself and looked like a
         * watcher bug, which cost a debugging round.
         */
        waitFor: (kind: string, timeoutMs = 20_000) =>
          new Promise((resolve, reject) => {
            const index = received.findIndex((message) => message.kind === kind);
            if (index >= 0) {
              const [existing] = received.splice(index, 1);
              resolve(existing as Record<string, unknown>);
              return;
            }
            const waiter = { kind, resolve };
            waiters.push(waiter);
            setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) {
                waiters.splice(index, 1);
                reject(new Error(`timed out waiting for "${kind}"`));
              }
            }, timeoutMs);
          }),
      };
    };

    const kernel = new Worker(urls.kernel, { type: "module" });
    const kernelInbox = inbox(kernel);
    kernel.postMessage({ channels, moduleUrls });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const watcher = new Worker(urls.watcher, { type: "module" });
    const watcherInbox = inbox(watcher);
    const watching = watcherInbox.waitFor("watching");
    watcher.postMessage({ buffer: watcherChannel.buffer, sizes: watcherChannel.sizes, moduleUrls });
    await watching;

    const writer = new Worker(urls.writer, { type: "module" });
    const writerInbox = inbox(writer);
    const written = writerInbox.waitFor("written");
    writer.postMessage({ buffer: writerChannel.buffer, sizes: writerChannel.sizes, moduleUrls, writes: 5 });
    await written;

    // Give the watcher a couple of poll intervals to drain, which is the documented delivery latency.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reported = watcherInbox.waitFor("report");
    watcher.postMessage({ report: true });
    const report = await reported;

    // Then ask again once the queue has had time to refill. If anything were still pending, this second report would carry
    // it; an empty second report is the drain-to-quiescence check.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const drained = watcherInbox.waitFor("report");
    watcher.postMessage({ report: true });
    const secondReport = await drained;

    const closed = watcherInbox.waitFor("closed");
    watcher.postMessage({ close: true });
    await closed;

    const statsAfterExit = kernelInbox.waitFor("stats");
    kernel.postMessage({ exited: "watcher" });
    kernel.postMessage({ stats: true });
    const statsMessage = await statsAfterExit;

    watcher.terminate();
    writer.terminate();
    kernel.postMessage({ stop: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    kernel.terminate();

    return {
      events: (report.events ?? []) as Array<{ kind: string; filename: string }>,
      drainedEvents: (secondReport.events ?? []) as Array<{ kind: string; filename: string }>,
      statsAfterExit: (statsMessage.stats ?? []) as Array<{ owner: string; watches: number; pending: number }>,
      watcherCount: (statsMessage.watcherCount ?? -1) as number,
    };
  });

  /**
   * What is asserted here is the invariant that actually holds, not the one I first wrote down.
   *
   * The kernel coalesces per path, so five writes that all land between two polls arrive as one event. But a poll CAN land
   * mid-burst — the writer's five writes are five separate syscall round trips, so on a slower machine the watcher drains
   * between them — and then two events are correct, not a bug. Asserting "exactly one" made this test depend on scheduling
   * luck: it passed locally and failed in CI, which is the flakiest possible way to be wrong.
   *
   * The honest invariant is per-write: every event names the file that changed, every event is a `change` (nothing here
   * creates or renames), and there are never MORE events than writes, because an event cannot be invented. Coalescing itself
   * is proven deterministically in tests/unit/watch-registry.test.ts, where the poll is driven by hand.
   */
  expect(outcome.events.length).toBeGreaterThanOrEqual(1);
  expect(outcome.events.length).toBeLessThanOrEqual(5);
  for (const event of outcome.events) {
    expect(event).toEqual({ kind: "change", filename: "main.js" });
  }
  // Nothing left pending after the burst: the watcher drained rather than falling behind.
  expect(outcome.drainedEvents).toEqual([]);
  // After the watcher closed and exited, nothing is watching: this is the phantom-watcher check.
  expect(outcome.statsAfterExit).toEqual([]);
  expect(outcome.watcherCount).toBe(1); // the kernel's own subscription remains; it is not a process watch
});
