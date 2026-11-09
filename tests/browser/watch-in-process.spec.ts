/**
 * `fs.watch` through a real process: user code inside a process Worker, watching a filesystem it does not own.
 *
 * The program below is ordinary user code. It requires `fs`, calls `fs.watch`, and waits. Everything between that call and the
 * kernel's registry is exercised: the shim resolves the path, the process-side watcher polls over the syscall channel, the
 * kernel matches the change against a watch it owns, and the answer travels back.
 *
 * The write is made by the KERNEL's thread, not by the watching process, so this cannot pass by a process hearing itself.
 */

import { expect, test } from "@playwright/test";

const KERNEL = `
  let fs = null;
  let registry = null;
  // Each branch imports what it needs from the URLs on its own message: a shared top-level import broke the moment a caller
  // sent a message without them, which is exactly what happened to the first version of this fixture.
  self.onmessage = async (event) => {
    try {
      const message = event.data;
      if (message.type === "seed") {
        const { FileSystem } = await import(message.moduleUrls.vfs);
        fs = new FileSystem();
        for (const [path, text] of message.files) fs.writeFileSync(path, text);
        self.postMessage({ type: "seeded" });
        return;
      }
      if (message.type === "mkdir") {
        fs.mkdirSync(message.path);
        self.postMessage({ type: "ok" });
        return;
      }
      if (message.type === "write") {
        fs.writeFileSync(message.path, message.data);
        self.postMessage({ type: "ok" });
        return;
      }
      if (message.type === "stats") {
        // The kernel's own view of what is being watched. A watch left behind by a dead process shows up here.
        self.postMessage({ type: "stats", watchers: registry === null ? -1 : registry.size });
        return;
      }
      if (message.type === "serve") {
        const { serveChannelAsync } = await import(message.moduleUrls.channel);
        const { createFsSyscallHandler } = await import(message.moduleUrls.fsSyscalls);
        const { WatchRegistry } = await import(message.moduleUrls.watchRegistry);
        if (registry === null) {
          registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind });
          fs.subscribe((change) => registry.notify(change));
        }
        const end = await serveChannelAsync({ buffer: message.buffer, sizes: message.sizes });
        const handler = createFsSyscallHandler(fs, { watches: registry, owner: message.owner });
        const deadline = Date.now() + message.lifetimeMs;
        // A kernel serves across idle gaps: a process that is thinking has not died, it is just not asking yet.
        while (Date.now() < deadline && !end.closed()) {
          await end.serveOne((request) => handler(request), { timeoutMs: 250 });
        }
        self.postMessage({ type: "stopped" });
      }
    } catch (error) {
      self.postMessage({ type: "fatal", reason: String((error && error.stack) || error) });
    }
  };
`;

const WATCHER_PROGRAM = `
  const fs = require("fs");
  const watcher = fs.watch("/app", (eventType, filename) => {
    console.log("saw", eventType, filename);
    watcher.close();
  });
  console.log("watching");
`;

test("a process watches a filesystem it does not own, and hears a kernel-side write", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ kernelSource, program }) => {
      const moduleUrls = {
        channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
        fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
        vfs: new URL("/src/vfs/index.ts", location.origin).href,
        watchRegistry: new URL("/src/process/watch-registry.ts", location.origin).href,
      };
      const { ProcessHost } = await import(new URL("/src/process/process-host.ts", location.origin).href);

      const kernel = new Worker(URL.createObjectURL(new Blob([kernelSource], { type: "text/javascript" })), {
        type: "module",
      });
      const messages: Array<Record<string, unknown>> = [];
      kernel.onmessage = (event) => messages.push(event.data as Record<string, unknown>);

      const waitFor = (type: string): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const began = Date.now();
          const check = (): void => {
            const index = messages.findIndex((message) => message.type === type);
            if (index >= 0) {
              const [found] = messages.splice(index, 1);
              resolve(found as Record<string, unknown>);
              return;
            }
            if (Date.now() - began > 8000) {
              reject(new Error(`kernel never sent "${type}"; it sent ${JSON.stringify(messages)}`));
              return;
            }
            setTimeout(check, 10);
          };
          check();
        });

      kernel.postMessage({ type: "seed", moduleUrls, files: Object.entries({ "/watch.js": program }) });
      await waitFor("seeded");
      kernel.postMessage({ type: "mkdir", path: "/app" });
      await waitFor("ok");

      const output: Record<number, string> = {};
      const host = new ProcessHost({
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const started = host.start({ argv: ["node", "/watch.js"] });
      kernel.postMessage({
        type: "serve",
        moduleUrls,
        owner: `pid-${started.pid}`,
        buffer: started.allocation.buffer,
        sizes: started.allocation.sizes,
        lifetimeMs: 60000,
      });

      // Wait until the program is actually watching before writing, so the test cannot pass on a lucky ordering.
      const watchingBy = Date.now() + 8000;
      while (!(output[started.pid] ?? "").includes("watching")) {
        if (Date.now() > watchingBy) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const wasWatching = (output[started.pid] ?? "").includes("watching");

      kernel.postMessage({ type: "write", path: "/app/main.js", data: "written by the kernel" });

      const exit = await new Promise<{ state: string; exitCode?: number }>((resolve) => {
        const began = Date.now();
        const tick = (): void => {
          const entry = host.table.get(started.pid) as { state: string; exitCode?: number };
          if (["exited", "failed", "killed"].includes(entry.state)) resolve(entry);
          else if (Date.now() - began > 8000) resolve({ state: "timeout" });
          else setTimeout(tick, 10);
        };
        tick();
      });

      // After the process has gone, ask the kernel what it thinks it is still watching.
      kernel.postMessage({ type: "stats", moduleUrls });
      const stats = await waitFor("stats");
      const fatal = messages.find((message) => message.type === "fatal");
      kernel.terminate();

      return {
        wasWatching,
        exit,
        output,
        watchers: stats.watchers,
        fatal,
        // Returned so a failure explains itself instead of arriving as a bare timeout.
        seen: messages.slice(0, 8),
      };
    },
    { kernelSource: KERNEL, program: WATCHER_PROGRAM },
  );

  expect(outcome.fatal).toBeUndefined();
  expect(outcome.wasWatching).toBe(true);
  expect(outcome.exit.state).toBe("exited");
  expect(outcome.exit.exitCode).toBe(0);
  // The event names the file the kernel wrote, and it arrived through the channel.
  expect(Object.values(outcome.output).join("")).toContain("saw change main.js");
  // No phantom watch survives the process that owned it.
  expect(outcome.watchers).toBe(0);
});
