/**
 * Binary payloads surviving a real process boundary, in both directions, on the framed wire.
 *
 * The codec has unit tests and the channel has unit tests, but neither can tell you whether 4 KiB written by one process
 * Worker arrives byte-identical in another. That path crosses four boundaries the unit tests stub: the `fs` shim in the
 * writer's Worker, the writer's channel into the kernel, the kernel's VFS, and the reader's channel back out. The earlier
 * protocol carried these bytes as base64 inside JSON; this test is the one that would have caught it if the framing lost a
 * byte, an offset, or a body.
 *
 * The pattern is deterministic and non-repeating, so a shifted or truncated copy cannot compare equal by luck. Both processes
 * recompute it independently, so the comparison is against the same expectation rather than against the other process's
 * output.
 */

import { expect, test } from "@playwright/test";

const KERNEL = `
  let fs = null;
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
      if (message.type === "size") {
        // The kernel's own view: proves the bytes reached the VFS, not merely that they made a round trip.
        self.postMessage({ type: "size", size: fs.statSync(message.path).size });
        return;
      }
      if (message.type === "serve") {
        const { serveChannelAsync } = await import(message.moduleUrls.channel);
        const { createFsSyscallHandler } = await import(message.moduleUrls.fsSyscalls);
        // Started without awaiting, so a second process can be served while the first is still running. Awaiting here was
        // enough for one process and silently serialised everything behind it.
        void (async () => {
          const end = await serveChannelAsync({ buffer: message.buffer, sizes: message.sizes });
          const handler = createFsSyscallHandler(fs, { owner: message.owner });
          const deadline = Date.now() + message.lifetimeMs;
          while (Date.now() < deadline && !end.closed()) {
            await end.serveOne((request) => handler(request), { timeoutMs: 250 });
          }
        })();
      }
    } catch (error) {
      self.postMessage({ type: "fatal", reason: String((error && error.stack) || error) });
    }
  };
`;

const WRITER = `
  const fs = require("fs");
  const length = 4096;
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) data[index] = (index * 31 + 7) & 255;
  fs.writeFileSync("/app/blob.bin", data);
  const back = fs.readFileSync("/app/blob.bin");
  let same = back.length === length;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum = (sum + back[index]) & 0xffff;
    if (back[index] !== ((index * 31 + 7) & 255)) same = false;
  }
  console.log("writer", same, back.length, sum);
`;

const READER = `
  const fs = require("fs");
  const length = 4096;
  const back = fs.readFileSync("/app/blob.bin");
  let same = back.length === length;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum = (sum + back[index]) & 0xffff;
    if (back[index] !== ((index * 31 + 7) & 255)) same = false;
  }
  console.log("reader", same, back.length, sum);
`;

/** The same expectation the programs compute, so the test does not take their word for it. */
const expectedSum = (length: number): number => {
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum = (sum + ((index * 31 + 7) & 255)) & 0xffff;
  return sum;
};

test("a 4 KiB binary payload written by one process arrives byte-identical in another", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ kernelSource, writer, reader }) => {
      const moduleUrls = {
        channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
        fsSyscalls: new URL("/src/process/fs-syscalls.ts", location.origin).href,
        vfs: new URL("/src/vfs/index.ts", location.origin).href,
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

      kernel.postMessage({ type: "seed", moduleUrls, files: Object.entries({ "/writer.js": writer, "/reader.js": reader }) });
      await waitFor("seeded");
      kernel.postMessage({ type: "mkdir", path: "/app" });
      await waitFor("ok");

      const output: Record<number, string> = {};
      const host = new ProcessHost({
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const waitForExit = (pid: number): Promise<{ state: string; exitCode?: number }> =>
        new Promise((resolve) => {
          const began = Date.now();
          const tick = (): void => {
            const entry = host.table.get(pid) as { state: string; exitCode?: number };
            if (["exited", "failed", "killed"].includes(entry.state)) resolve(entry);
            else if (Date.now() - began > 12000) resolve({ state: "timeout" });
            else setTimeout(tick, 10);
          };
          tick();
        });

      const startServed = (argv: string[]): number => {
        const started = host.start({ argv });
        kernel.postMessage({
          type: "serve",
          moduleUrls,
          owner: `pid-${started.pid}`,
          buffer: started.allocation.buffer,
          sizes: started.allocation.sizes,
          lifetimeMs: 30000,
        });
        return started.pid;
      };

      const writerPid = startServed(["node", "/writer.js"]);
      const writerExit = await waitForExit(writerPid);
      const writerOutput = output[writerPid] ?? "";

      // The writer has exited and its channel is closed; the bytes must still be in the kernel's filesystem.
      kernel.postMessage({ type: "size", path: "/app/blob.bin", moduleUrls });
      const size = await waitFor("size");

      const readerPid = startServed(["node", "/reader.js"]);
      const readerExit = await waitForExit(readerPid);
      const readerOutput = output[readerPid] ?? "";

      const fatal = messages.find((message) => message.type === "fatal");
      kernel.terminate();

      return { writerExit, writerOutput, readerExit, readerOutput, size: size.size, fatal, seen: messages.slice(0, 8) };
    },
    { kernelSource: KERNEL, writer: WRITER, reader: READER },
  );

  const sum = expectedSum(4096);

  expect(outcome.fatal).toBeUndefined();
  expect(outcome.writerExit).toMatchObject({ state: "exited", exitCode: 0 });
  expect(outcome.writerOutput).toContain(`writer true 4096 ${sum}`);
  // The kernel's size is a second, independent witness: the body was not merely echoed back to its writer.
  expect(outcome.size).toBe(4096);
  expect(outcome.readerExit).toMatchObject({ state: "exited", exitCode: 0 });
  expect(outcome.readerOutput).toContain(`reader true 4096 ${sum}`);
});
