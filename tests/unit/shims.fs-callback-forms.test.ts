/**
 * Node's callback-shaped `fs` members, which this shim now derives from its promise members.
 *
 * WHY THIS FILE EXISTS. `npm run build` with a `vite.config.js` died with `TypeError: fs__default.unlink is not a function` AFTER vite had loaded and
 * bundled the config correctly: vite writes the bundle to a temp `.mjs`, imports it, and deletes the temp file in a `finally` with `fs.unlink(tmp, cb)`.
 * The shim had `unlinkSync` and `promises.unlink` and no `unlink`, so a real project's build stopped on a member Node has had since forever.
 *
 * WHAT IS BEING PINNED. Every case here checks a property the derived forms could get wrong in a way the sync tests would miss: that the callback is
 * invoked (exactly once), that it receives the result in Node's position, that a missing file arrives as `ENOENT` in the callback's error argument
 * rather than as a thrown exception, and that a RELATIVE path is rewritten against the program's cwd before it reaches the VFS.
 */

import { describe, expect, it } from "vitest";

import { createFsShim } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";

/** A shim rooted at /app, holding one file, which is the shape a program sees after it has written its first file. */
const sandbox = () => {
  const vfs = new FileSystem();
  vfs.mkdirSync("/app", { recursive: true });
  vfs.writeFileSync("/app/notes.txt", "hello");
  return { vfs, fs: createFsShim(vfs, { cwd: "/app" }) };
};

/** Waits for a Node-style callback, so a form that never calls back fails the test instead of hanging it. */
const hears = <T>(invoke: (callback: (error: unknown, result?: T) => void) => void): Promise<{ error: unknown; result: T | undefined }> =>
  new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("the callback form never called back")), 1_000);
    invoke((error, result) => {
      clearTimeout(deadline);
      resolve({ error, result });
    });
  });

describe("callback fs.unlink", () => {
  it("removes the file and calls back with no error", async () => {
    const { vfs, fs } = sandbox();

    const { error } = await hears((callback) => fs.unlink("/app/notes.txt", callback));

    expect(error).toBeNull();
    expect(() => vfs.statSync("/app/notes.txt")).toThrow();
  });

  it("reports a missing file through the error argument instead of throwing", async () => {
    const { fs } = sandbox();

    const { error } = await hears((callback) => fs.unlink("/app/absent.txt", callback));

    // Node's contract for every callback member: the failure is the callback's first argument, the call itself does not throw.
    expect(error).toMatchObject({ code: "ENOENT", syscall: "unlink", path: "/app/absent.txt" });
  });

  it("rewrites a relative path against the program's cwd", async () => {
    const { vfs, fs } = sandbox();

    await hears((callback) => fs.unlink("notes.txt", callback));

    expect(() => vfs.statSync("/app/notes.txt")).toThrow();
  });
});

describe("callback fs.readFile / fs.writeFile", () => {
  it("answers with bytes when no encoding is given, as Node's Buffer does", async () => {
    const { fs } = sandbox();

    const { result } = await hears<Uint8Array>((callback) => fs.readFile("/app/notes.txt", callback));

    expect(Buffer.from(result as Uint8Array).toString("utf8")).toBe("hello");
  });

  it("answers with a string when the second argument is an encoding", async () => {
    const { fs } = sandbox();

    const { result } = await hears<string>((callback) => fs.readFile("/app/notes.txt", "utf8", callback));

    expect(result).toBe("hello");
  });

  it("accepts the encoding as an options object in the middle position", async () => {
    const { fs } = sandbox();

    const { result } = await hears<string>((callback) => fs.readFile("/app/notes.txt", { encoding: "utf8" }, callback));

    expect(result).toBe("hello");
  });

  it("writes, and calls back with no second argument, which is what promisify(writeFile) resolves on", async () => {
    const { vfs, fs } = sandbox();

    const { error, result } = await hears((callback) => fs.writeFile("/app/new.txt", "written", callback));

    expect(error).toBeNull();
    expect(result).toBeUndefined();
    expect(vfs.readFileSync("/app/new.txt", "utf8")).toBe("written");
  });
});

describe("callback fs.mkdir / fs.rmdir / fs.rename / fs.rm / fs.access", () => {
  it("mkdir creates a directory, recursively when asked", async () => {
    const { vfs, fs } = sandbox();

    const { error } = await hears((callback) => fs.mkdir("/app/deep/inner", { recursive: true }, callback));

    expect(error).toBeNull();
    expect(vfs.statSync("/app/deep/inner").kind).toBe("dir");
  });

  it("rmdir removes a directory that still holds files when recursive is set", async () => {
    const { vfs, fs } = sandbox();
    vfs.mkdirSync("/app/tree/nested", { recursive: true });
    vfs.writeFileSync("/app/tree/nested/leaf.txt", "x");

    const { error } = await hears((callback) => fs.rmdir("/app/tree", { recursive: true }, callback));

    expect(error).toBeNull();
    expect(() => vfs.statSync("/app/tree")).toThrow();
  });

  it("rmdir refuses a non-empty directory without recursive, as Node does", async () => {
    const { vfs, fs } = sandbox();
    vfs.mkdirSync("/app/full", { recursive: true });
    vfs.writeFileSync("/app/full/leaf.txt", "x");

    const { error } = await hears((callback) => fs.rmdir("/app/full", callback));

    expect(error).toMatchObject({ syscall: "rmdir" });
    expect(vfs.statSync("/app/full").kind).toBe("dir");
  });

  it("rename moves a file, rewriting both paths", async () => {
    const { vfs, fs } = sandbox();

    const { error } = await hears((callback) => fs.rename("notes.txt", "/app/renamed.txt", callback));

    expect(error).toBeNull();
    expect(vfs.readFileSync("/app/renamed.txt", "utf8")).toBe("hello");
    expect(() => vfs.statSync("/app/notes.txt")).toThrow();
  });

  it("rm removes a tree with recursive and reports a missing path as success with force", async () => {
    const { vfs, fs } = sandbox();
    vfs.mkdirSync("/app/cache/a", { recursive: true });
    vfs.writeFileSync("/app/cache/a/b.bin", "x");

    const removed = await hears((callback) => fs.rm("/app/cache", { recursive: true }, callback));
    const forced = await hears((callback) => fs.rm("/app/cache", { recursive: true, force: true }, callback));

    expect(removed.error).toBeNull();
    expect(forced.error).toBeNull();
    expect(() => vfs.statSync("/app/cache")).toThrow();
  });

  it("access resolves for a present file and reports ENOENT for a missing one", async () => {
    const { fs } = sandbox();

    const present = await hears((callback) => fs.access("/app/notes.txt", callback));
    const missing = await hears((callback) => fs.access("/app/absent.txt", callback));

    expect(present.error).toBeNull();
    expect(missing.error).toMatchObject({ code: "ENOENT" });
  });
});

describe("the promise forms the callback forms are derived from", () => {
  it("exposes rmdir and rename, so both shapes exist for the same operations", async () => {
    const { vfs, fs } = sandbox();
    vfs.mkdirSync("/app/gone", { recursive: true });

    await fs.promises.rename("/app/notes.txt", "/app/kept.txt");
    await fs.promises.rmdir("/app/gone", { recursive: true });

    expect(vfs.readFileSync("/app/kept.txt", "utf8")).toBe("hello");
    expect(() => vfs.statSync("/app/gone")).toThrow();
  });

  it("keeps `this` inside the promise members that call their siblings", async () => {
    const { fs } = sandbox();

    // `lstat`, `realpath` and `access` all delegate through `this.stat`; a bare method reference would lose that and throw.
    await expect(fs.promises.lstat("/app/notes.txt")).resolves.toMatchObject({ size: 5 });
    await expect(fs.promises.realpath("/app/notes.txt")).resolves.toBe("/app/notes.txt");
    await expect(fs.promises.access("/app/notes.txt")).resolves.toBeUndefined();
  });
});
