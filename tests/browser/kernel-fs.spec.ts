/**
 * The real runtime, inside a process Worker, with its filesystem in the kernel.
 *
 * This is the Phase 1 claim in one test: a program runs in its own Worker, every filesystem call it makes crosses to a
 * *different* Worker that owns the VFS, and the program's output is unchanged. Nothing here is faked: real module
 * Workers, real SharedArrayBuffer, real `Atomics.wait`, real loader and real shims.
 */

import { expect, test } from "@playwright/test";

test("a program in its own Worker reads files from the kernel over the syscall channel", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(async () => {
    const moduleUrls = {
      channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
      remoteFs: new URL("/src/process/remote-fs.ts", location.origin).href,
      fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
      vfs: new URL("/src/vfs/index.ts", location.origin).href,
      runtime: new URL("/src/runtime/in-process.ts", location.origin).href,
    };
    const sizes = { requestBytes: 64 * 1024, responseBytes: 64 * 1024 };
    const allocation = (await import(moduleUrls.channel)).allocateChannel(sizes);

    const kernelSource = `
      self.onmessage = async (event) => {
       try {
        const { buffer, sizes, moduleUrls } = event.data;
        const { serveChannelAsync } = await import(moduleUrls.channel);
        const { createFsSyscallHandler } = await import(moduleUrls.fsSyscalls);
        const { FileSystem } = await import(moduleUrls.vfs);

        const fs = new FileSystem();
        fs.writeFileSync("/main.js", 'const fs = require("fs");\\nconsole.log("read:", fs.readFileSync("/data.txt", "utf8"));\\n');
        fs.writeFileSync("/data.txt", "served by the kernel");

        const end = await serveChannelAsync({ buffer, sizes });
        const handler = createFsSyscallHandler(fs);
        // A kernel keeps serving until it is shut down; it does not stop because one idle window elapsed. The window is
        // short so shutdown is responsive, and the loop keeps going while there is life left in the deadline.
        const ops = [];
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (!(await end.serveOne((request) => { ops.push(request.op); return handler(request); }, { timeoutMs: 250 }))) break;
        }
        self.postMessage({ ops, closed: end.closed(), waitedUntil: Date.now() > deadline });
       } catch (error) {
        self.postMessage({ ops: [], fatal: String((error && error.stack) || error) });
       }
      };
    `;

    const processSource = `
      self.onmessage = async (event) => {
        const { buffer, sizes, moduleUrls } = event.data;
        const { SyscallClient } = await import(moduleUrls.channel);
        const { createRemoteFileSystem } = await import(moduleUrls.remoteFs);
        const { InProcessRuntime } = await import(moduleUrls.runtime);

        const client = new SyscallClient({ buffer, sizes });
        const fs = createRemoteFileSystem(client, { timeoutMs: 4000 });
        try {
          const runtime = new InProcessRuntime(fs);
          const result = await runtime.run("/main.js");
          self.postMessage({ ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
        } catch (error) {
          self.postMessage({ ok: false, error: String((error && error.message) || error) });
        }
      };
    `;

    const runWorker = (source: string, role: string): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), { type: "module" });
        const settle = (value: Record<string, unknown>): void => {
          worker.terminate();
          resolve(value);
        };
        worker.onmessage = (message) => settle(message.data as Record<string, unknown>);
        worker.onerror = (error) => settle({ ok: false, error: `worker error: ${error.message}` });
        worker.postMessage({ buffer: allocation.buffer, sizes, moduleUrls, role });
        setTimeout(() => settle({ ok: false, error: "worker did not answer in time" }), 20_000);
      });

    const kernel = runWorker(kernelSource, "kernel");
    const process = runWorker(processSource, "process");
    const [kernelResult, processResult] = await Promise.all([kernel, process]);
    return { kernel: kernelResult, process: processResult };
  });

  expect(outcome.process.error).toBeUndefined();
  expect(outcome.process.stderr).toBe("");
  expect(outcome.process.exitCode).toBe(0);
  expect(outcome.process.stdout).toContain("read: served by the kernel");
  // The kernel saw the reads, which is what makes this a bridge rather than a local filesystem.
  expect(outcome.kernel.ops as string[]).toContain("read");
  expect((outcome.kernel.ops as string[]).length).toBeGreaterThanOrEqual(2);
});
