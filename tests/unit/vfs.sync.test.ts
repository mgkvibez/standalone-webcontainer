import { describe, expect, it } from "vitest";

import { FileSystem } from "../../src/vfs/index.js";

/**
 * The sync seam exists because CommonJS `require()` cannot await: ADR-0002 #2
 * says sync APIs block only the worker, and #7 makes `fs` the first shim with
 * `readFileSync`/`writeFileSync` as its most-used surface. These tests exist to
 * prove the sync path is the SAME path as the async one, not a parallel
 * implementation that can drift.
 */
describe("FileSystem sync seam", () => {
  it("round-trips a string through writeFileSync and readFileSync", () => {
    const fs = new FileSystem();
    fs.writeFileSync("/a.txt", "hello");
    expect(fs.readFileSync("/a.txt", "utf8")).toBe("hello");
  });

  it("returns bytes when no encoding is given, matching async readFile", async () => {
    const fs = new FileSystem();
    fs.writeFileSync("/b.bin", "abc");
    const sync = fs.readFileSync("/b.bin");
    const asyncBytes = await fs.readFile("/b.bin");
    expect(sync).toBeInstanceOf(Uint8Array);
    expect(Array.from(sync as Uint8Array)).toEqual(Array.from(asyncBytes as Uint8Array));
  });

  it("is visible to the async API in both directions", async () => {
    const fs = new FileSystem();
    fs.writeFileSync("/c.txt", "sync-written");
    expect(await fs.readFile("/c.txt", "utf8")).toBe("sync-written");

    await fs.writeFile("/d.txt", "async-written");
    expect(fs.readFileSync("/d.txt", "utf8")).toBe("async-written");
  });

  it("keeps derived-parent creation, so /x/y/z.txt works without mkdir", () => {
    const fs = new FileSystem();
    fs.writeFileSync("/x/y/z.txt", "nested");
    expect(fs.readFileSync("/x/y/z.txt", "utf8")).toBe("nested");
  });

  it("refuses to write a file over a directory, like the async path", () => {
    const fs = new FileSystem();
    fs.writeFileSync("/dir.txt", "a");
    expect(() => fs.writeFileSync("/dir.txt/child.txt", "b")).toThrow(/not a directory|ENOTDIR/i);
  });

  it("reports a missing file as an error rather than returning undefined", () => {
    const fs = new FileSystem();
    expect(() => fs.readFileSync("/nope.txt")).toThrow();
  });
});
