/**
 * `fs.watch` inside a real execution: does a program that is only waiting on a watcher stay alive?
 *
 * This is the test the feature actually needed. Without the loop treating an open watcher as a live handle, everything below
 * still "works" in isolation and prints nothing here, because the loop empties the instant the timer queue runs dry: the
 * process exits, the watch never delivers, and the failure looks like a broken watcher rather than a broken loop.
 *
 * The polling behind `fs.watch` runs on REAL timers, deliberately. A watch interval measured in virtual milliseconds would
 * never fire, since virtual time only advances while the timer queue is running, and an empty queue is exactly the condition
 * being waited on.
 */

import { describe, expect, it } from "vitest";
import { FileSystem } from "../../src/vfs/index.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";

const run = async (files: Record<string, string>): Promise<{ stdout: string; stop: string }> => {
  const vfs = new FileSystem();
  for (const [path, source] of Object.entries(files)) vfs.writeFileSync(path, source);
  const runtime = new InProcessRuntime(vfs);
  const result = await runtime.run("/main.js", { argv: ["node", "/main.js"] });
  return { stdout: result.stdout, stop: result.scheduler.stop };
};

describe("an open watcher keeps the process alive", () => {
  it("receives a change made after the timer queue has emptied, then exits", async () => {
    const { stdout, stop } = await run({
      "/main.js": `
        const fs = require("fs");
        fs.mkdirSync("/app");
        const watcher = fs.watch("/app", (eventType, filename) => {
          console.log("event", eventType, filename);
          watcher.close();
        });
        setTimeout(() => fs.writeFileSync("/app/main.js", "written"), 5);
      `,
    });

    // The event arrives only if the loop stayed alive past the point where it had nothing left to run.
    expect(stdout).toContain("event change main.js");
    // And it still ends on its own once the watcher is closed, rather than waiting for the real-time guard.
    expect(stop).toBe("queue-empty");
  });

  it("does not keep a process alive once the watcher is closed", async () => {
    const { stdout, stop } = await run({
      "/main.js": `
        const fs = require("fs");
        fs.mkdirSync("/app");
        const watcher = fs.watch("/app", () => console.log("should not fire"));
        watcher.close();
        setTimeout(() => fs.writeFileSync("/app/late.js", "written"), 5);
        console.log("closed");
      `,
    });

    expect(stdout).toContain("closed");
    expect(stdout).not.toContain("should not fire");
    expect(stop).toBe("queue-empty");
  });

  it("refuses by name when the runtime cannot watch at all", async () => {
    const vfs = new FileSystem();
    // A port that is not locally watchable, standing in for one with no watch source: the refusal must be typed, not silent.
    const port = {
      readFileSync: (path: string) => vfs.readFileSync(path),
      writeFileSync: (path: string, data: string | Uint8Array) => vfs.writeFileSync(path, data),
      mkdirSync: (path: string, options?: { recursive?: boolean }) => vfs.mkdirSync(path, options ?? {}),
      readdirSync: (path: string) => vfs.readdirSync(path),
      statSync: (path: string) => vfs.statSync(path),
      unlinkSync: (path: string) => vfs.unlinkSync(path),
      rmdirSync: (path: string) => vfs.rmdirSync(path),
      renameSync: (from: string, to: string) => vfs.renameSync(from, to),
      readFile: async (path: string) => vfs.readFile(path),
      writeFile: async (path: string, data: string | Uint8Array) => vfs.writeFile(path, data),
      mkdir: async (path: string, options?: { recursive?: boolean }) => vfs.mkdir(path, options ?? {}),
      readdir: async (path: string) => vfs.readdir(path),
      unlink: async (path: string) => vfs.unlink(path),
    };
    vfs.writeFileSync(
      "/main.js",
      `
        const fs = require("fs");
        try { fs.watch("/app"); console.log("no refusal"); }
        catch (error) { console.log("refused", error.code); }
      `,
    );
    const runtime = new InProcessRuntime(port as never);
    const result = await runtime.run("/main.js", { argv: ["node", "/main.js"] });
    expect(result.stdout).toContain("refused ENOSYS");
  });
});
