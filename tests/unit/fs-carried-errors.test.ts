/**
 * A failure that crossed the syscall channel is a filesystem condition, not a bug in the shim.
 *
 * The mapper used to rethrow anything that was not a `VFSError`, and the process lane's failures arrive as `SyscallRejectedError`, so in a Worker an
 * `ENOENT` was not an error a program could catch: it unwound through `fs.stat` and killed the caller. Vite's config resolver asks for a
 * `/tsconfig.json` that does not exist, so the whole config parse was abandoned and its dependency optimizer never ran.
 *
 * The last test is the one that keeps the fix honest: an error with no POSIX code is still a shim bug and must still be raised, because a mapper that
 * swallows everything is how a real defect becomes a silent `ENOENT`.
 */

import { describe, expect, it } from "vitest";
import { FileSystem } from "../../src/vfs/index.js";
import { createFsShim } from "../../src/shims/fs.js";
import type { FileSystemPort, VfsStatsPort } from "../../src/vfs/port.js";

/** The shape the syscall channel reconstitutes: a name and a POSIX code, and no `VFSError` in its ancestry. */
const carried = (code: string): Error =>
  Object.assign(new Error(`${code}: no such file or directory, '/tsconfig.json'`), { name: "SyscallRejectedError", code });

const portThatFailsWith = (failure: unknown): FileSystemPort => {
  const vfs = new FileSystem();
  return {
    readFileSync: (path, encoding) => vfs.readFileSync(path, encoding),
    writeFileSync: (path, data, options) => vfs.writeFileSync(path, data, options),
    mkdirSync: (path, options) => vfs.mkdirSync(path, options),
    readdirSync: (path) => vfs.readdirSync(path),
    statSync: (): VfsStatsPort => {
      throw failure;
    },
    unlinkSync: (path) => vfs.unlinkSync(path),
    rmdirSync: (path) => vfs.rmdirSync(path),
    renameSync: (from, to) => vfs.renameSync(from, to),
    readFile: async (path, encoding) => vfs.readFileSync(path, encoding),
    writeFile: async (path, data, options) => vfs.writeFileSync(path, data, options),
    mkdir: async (path, options) => vfs.mkdirSync(path, options),
    readdir: async (path) => vfs.readdirSync(path),
    unlink: async (path) => vfs.unlinkSync(path),
  };
};

describe("an error carried across the boundary", () => {
  it("reaches an async caller's callback instead of unwinding out of fs.stat", async () => {
    const fs = createFsShim(portThatFailsWith(carried("ENOENT")));
    const heard: unknown[] = [];
    expect(() => {
      fs.stat("/tsconfig.json", (error) => heard.push(error));
    }).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).toHaveLength(1);
    const error = heard[0] as { code?: string; syscall?: string; path?: string; name?: string };
    expect(error.code).toBe("ENOENT");
    expect(error.syscall).toBe("stat");
    expect(error.path).toBe("/tsconfig.json");
    expect(error.name).toBe("Error");
  });

  it("is a Node error from the sync form too, so `catch` sees the code a caller branches on", () => {
    const fs = createFsShim(portThatFailsWith(carried("EACCES")));
    try {
      fs.statSync("/tsconfig.json");
      expect.unreachable("statSync should have thrown");
    } catch (error) {
      const coded = error as { code?: string; errno?: number; syscall?: string };
      expect(coded.code).toBe("EACCES");
      expect(coded.syscall).toBe("stat");
      expect(typeof coded.errno).toBe("number");
    }
  });

  it("still raises an error carrying no POSIX code, which is a shim bug and not a filesystem condition", async () => {
    const fs = createFsShim(portThatFailsWith(new Error("cannot read properties of undefined")));
    expect(() => fs.statSync("/tsconfig.json")).toThrow("cannot read properties of undefined");
    let heard: unknown;
    expect(() => {
      fs.stat("/tsconfig.json", (error) => {
        heard = error;
      });
    }).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect((heard as Error).message).toBe("cannot read properties of undefined");
  });
});
