import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOTAL_BYTES,
  FileSystem,
  MAX_FILE_SIZE,
  VFSInvalidEncodingError,
  VFSInvalidPathError,
  VFSIsADirectoryError,
  VFSNotEmptyError,
  VFSNotFoundError,
  VFSNotADirectoryError,
  VFSPathExistsError,
  VFSQuotaExceededError,
} from "../../src/vfs/index.js";
import { normalizeVfsPath } from "../../src/vfs/path.js";

describe("path normalization", () => {
  it("resolves . and .. segments", () => {
    expect(normalizeVfsPath("/a/b/../c")).toBe("/a/c");
    expect(normalizeVfsPath("/./a")).toBe("/a");
    expect(normalizeVfsPath("/a/./b/./c")).toBe("/a/b/c");
    expect(normalizeVfsPath("/a/b/c/../../d")).toBe("/a/d");
  });

  it("collapses .. at the root, matching POSIX", () => {
    expect(normalizeVfsPath("/..")).toBe("/");
    expect(normalizeVfsPath("/../../a")).toBe("/a");
  });

  it("converts windows separators to POSIX", () => {
    expect(normalizeVfsPath("\\a\\b\\..\\c")).toBe("/a/c");
    expect(normalizeVfsPath("C:\\tmp\\x.txt")).toBe("/C:/tmp/x.txt");
  });

  it("makes relative paths absolute from the VFS root", () => {
    expect(normalizeVfsPath("a/b")).toBe("/a/b");
    expect(normalizeVfsPath("./x")).toBe("/x");
  });

  it("collapses duplicate separators and trailing separators", () => {
    expect(normalizeVfsPath("/a//b///c")).toBe("/a/b/c");
    expect(normalizeVfsPath("/a/b/")).toBe("/a/b");
    expect(normalizeVfsPath("///")).toBe("/");
    expect(normalizeVfsPath("/")).toBe("/");
  });

  it("rejects the empty path", () => {
    expect(() => normalizeVfsPath("")).toThrow(VFSInvalidPathError);
    expect(() => normalizeVfsPath("")).toThrowError(/must be a non-empty string/);
  });
});

describe("writeFile / readFile round-trip", () => {
  it("round-trips strings as UTF-8 bytes", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/notes/hello.txt", "héllo wörld");
    expect(await fs.readFile("/notes/hello.txt", "utf8")).toBe("héllo wörld");
    const raw = await fs.readFile("/notes/hello.txt");
    expect(raw).toBeInstanceOf(Uint8Array);
  });

  it("round-trips binary data byte-for-byte", async () => {
    const fs = new FileSystem();
    const input = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 42]);
    await fs.writeFile("/blob.bin", input);
    const out = await fs.readFile("/blob.bin");
    expect([...(out as Uint8Array)]).toEqual([...input]);
  });

  it("returns copies: mutating a read buffer cannot corrupt the VFS", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/a.bin", new Uint8Array([1, 2, 3]));
    const first = (await fs.readFile("/a.bin")) as Uint8Array;
    first.set([9, 9, 9], 0);
    const second = (await fs.readFile("/a.bin")) as Uint8Array;
    expect([...second]).toEqual([1, 2, 3]);
  });

  it("does not alias a caller's input buffer", async () => {
    const fs = new FileSystem();
    const input = new Uint8Array([1, 2, 3]);
    await fs.writeFile("/alias.bin", input);
    input.set([7, 7, 7], 0);
    const out = (await fs.readFile("/alias.bin")) as Uint8Array;
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("overwrites existing files and reports current size", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/f.txt", "first");
    await fs.writeFile("/f.txt", "second");
    expect(await fs.readFile("/f.txt", "utf8")).toBe("second");
    expect((await fs.stat("/f.txt")).size).toBe("second".length);
  });

  it("rejects non-file non-Uint8Array data", async () => {
    const fs = new FileSystem();
    await expect(
      fs.writeFile("/bad.txt", 42 as unknown as string),
    ).rejects.toThrow(TypeError);
  });

  it("throws EISDIR when the target is a directory or the root", async () => {
    const fs = new FileSystem();
    await expect(fs.writeFile("/", "x")).rejects.toThrow(VFSIsADirectoryError);
    await fs.mkdir("/d");
    await expect(fs.writeFile("/d", "x")).rejects.toThrow(VFSIsADirectoryError);
  });

  it("throws ENOTDIR when a path component is a file", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/blocker.txt", "x");
    await expect(fs.writeFile("/blocker.txt/child.txt", "y")).rejects.toThrow(VFSNotADirectoryError);
    await expect(fs.readFile("/blocker.txt/child.txt")).rejects.toThrow(VFSNotADirectoryError);
    await expect(fs.readdir("/blocker.txt/x")).rejects.toThrow(VFSNotADirectoryError);
  });

  it("throws ENOENT when reading a missing file", async () => {
    const fs = new FileSystem();
    await expect(fs.readFile("/missing.txt")).rejects.toThrow(VFSNotFoundError);
    await expect(fs.readFile("/missing.txt")).rejects.toThrowError(/ENOENT/);
  });

  it("throws EISDIR when reading a directory", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/d/f.txt", "x");
    await expect(fs.readFile("/d")).rejects.toThrow(VFSIsADirectoryError);
  });

  it("rejects unsupported encodings at runtime", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/e.txt", "x");
    await expect(
      fs.readFile("/e.txt", "base64" as unknown as "utf8"),
    ).rejects.toThrow(VFSInvalidEncodingError);
  });
});

describe("mkdir / readdir / stat", () => {
  it("mkdir creates explicit entries; non-recursive requires the parent to exist", async () => {
    const fs = new FileSystem();
    await expect(fs.mkdir("/a/b/c")).rejects.toThrow(VFSNotFoundError);
    // Non-recursive mkdir also requires the IMMEDIATE parent to exist.
    await fs.mkdir("/a", { recursive: true });
    await expect(fs.mkdir("/a/b/c")).rejects.toThrow(VFSNotFoundError);
    await fs.mkdir("/a/b/c", { recursive: true });
    expect((await fs.stat("/a")).kind).toBe("dir");
    expect((await fs.stat("/a/b")).kind).toBe("dir");
    expect((await fs.stat("/a/b/c")).kind).toBe("dir");
  });

  it("mkdir is EEXIST for files and existing dirs; recursive no-ops on dirs", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/f.txt", "x");
    await expect(fs.mkdir("/f.txt")).rejects.toThrow(VFSPathExistsError);
    await fs.mkdir("/d");
    await expect(fs.mkdir("/d")).rejects.toThrow(VFSPathExistsError);
    await fs.mkdir("/d", { recursive: true }); // no-op, resolves
  });

  it("readdir lists sorted direct children, including derived and empty dirs", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/z.txt", "x");
    await fs.writeFile("/a/deep/file.txt", "x"); // derived dir "a"
    await fs.mkdir("/m"); // explicit empty dir
    await expect(fs.readdir("/")).resolves.toEqual(["a", "m", "z.txt"]);
  });

  it("readdir of a file is ENOTDIR; of a missing dir is ENOENT", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/f.txt", "x");
    await expect(fs.readdir("/f.txt")).rejects.toThrow(VFSNotADirectoryError);
    await expect(fs.readdir("/nope")).rejects.toThrow(VFSNotFoundError);
  });

  it("stat reports file fields and preserves createdAt across overwrite", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/s.txt", "one");
    const before = await fs.stat("/s.txt");
    await fs.writeFile("/s.txt", "longer content");
    const after = await fs.stat("/s.txt");
    expect(after.kind).toBe("file");
    expect(after.size).toBe("longer content".length);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.modifiedAt).toBeGreaterThanOrEqual(before.modifiedAt);
  });

  it("stat sees derived directories with epoch timestamps", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/d/f.txt", "x");
    const derived = await fs.stat("/d");
    expect(derived.kind).toBe("dir");
    expect(derived.size).toBe(0);
    expect(derived.createdAt).toBe(0);
    // mkdir on an existing (derived) directory is EEXIST, same as explicit dirs.
    await expect(fs.mkdir("/d")).rejects.toThrow(VFSPathExistsError);
  });

  it("stat of a missing path is ENOENT", async () => {
    const fs = new FileSystem();
    await expect(fs.stat("/missing")).rejects.toThrow(VFSNotFoundError);
  });

  it("stat and readdir see the root as a directory", async () => {
    const fs = new FileSystem();
    expect((await fs.stat("/")).kind).toBe("dir");
    await expect(fs.readdir("/")).resolves.toEqual([]);
  });
});

describe("unlink", () => {
  it("removes files and frees their space", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/gone.txt", "bye");
    await fs.unlink("/gone.txt");
    await expect(fs.readFile("/gone.txt")).rejects.toThrow(VFSNotFoundError);
  });

  it("is ENOENT for missing paths", async () => {
    const fs = new FileSystem();
    await expect(fs.unlink("/nope.txt")).rejects.toThrow(VFSNotFoundError);
  });

  it("is EISDIR for explicit and derived directories", async () => {
    const fs = new FileSystem();
    await fs.mkdir("/d");
    await expect(fs.unlink("/d")).rejects.toThrow(VFSIsADirectoryError);
    await fs.writeFile("/d2/f.txt", "x");
    await expect(fs.unlink("/d2")).rejects.toThrow(VFSIsADirectoryError); // derived
  });
});

describe("rename", () => {
  it("moves a file", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/a.txt", "data");
    await fs.rename("/a.txt", "/b.txt");
    await expect(fs.readFile("/b.txt", "utf8")).resolves.toBe("data");
    await expect(fs.readFile("/a.txt")).rejects.toThrow(VFSNotFoundError);
  });

  it("is a no-op success when from === to", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/same.txt", "x");
    await fs.rename("/same.txt", "/same.txt");
    await expect(fs.readFile("/same.txt", "utf8")).resolves.toBe("x");
  });

  it("overwrites an existing target file (POSIX)", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/src.txt", "new");
    await fs.writeFile("/dst.txt", "old-old");
    await fs.rename("/src.txt", "/dst.txt");
    await expect(fs.readFile("/dst.txt", "utf8")).resolves.toBe("new");
    await expect(fs.readFile("/src.txt")).rejects.toThrow(VFSNotFoundError);
  });

  it("moves whole subtrees via prefix scan", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/proj/src/main.ts", "a");
    await fs.writeFile("/proj/src/lib/util.ts", "b");
    await fs.writeFile("/proj/README.md", "c");
    await fs.rename("/proj", "/renamed");
    expect(await fs.readdir("/renamed")).toEqual(["README.md", "src"]);
    expect(await fs.readFile("/renamed/src/lib/util.ts", "utf8")).toBe("b");
    await expect(fs.readdir("/proj")).rejects.toThrow(VFSNotFoundError);
  });

  it("overwrites an empty target directory with a directory", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/d1/f.txt", "x");
    await fs.mkdir("/d2");
    await fs.rename("/d1", "/d2");
    await expect(fs.readFile("/d2/f.txt", "utf8")).resolves.toBe("x");
  });

  it("is EISDIR moving a file onto a directory", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/f.txt", "x");
    await fs.mkdir("/d");
    await expect(fs.rename("/f.txt", "/d")).rejects.toThrow(VFSIsADirectoryError);
  });

  it("is ENOTEMPTY overwriting a non-empty directory", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/d1/f.txt", "x");
    await fs.writeFile("/d2/keep.txt", "y");
    await expect(fs.rename("/d1", "/d2")).rejects.toThrow(VFSNotEmptyError);
  });

  it("is ENOTDIR moving a directory onto a file", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/d/f.txt", "x");
    await fs.writeFile("/target.txt", "y");
    await expect(fs.rename("/d", "/target.txt")).rejects.toThrow(VFSNotADirectoryError);
  });

  it("is EINVAL moving into the source's own subtree, and for the root", async () => {
    const fs = new FileSystem();
    await fs.writeFile("/a/f.txt", "x");
    await expect(fs.rename("/a", "/a/inside")).rejects.toThrow(VFSInvalidPathError);
    await expect(fs.rename("/", "/elsewhere")).rejects.toThrow(VFSInvalidPathError);
    await expect(fs.rename("/a", "/")).rejects.toThrow(VFSInvalidPathError);
  });

  it("is ENOENT when the source does not exist", async () => {
    const fs = new FileSystem();
    await expect(fs.rename("/ghost", "/anywhere")).rejects.toThrow(VFSNotFoundError);
  });
});

describe("quota and LRU eviction (ADR-0002 #4)", () => {
  it("exports the specified caps as constants", () => {
    expect(MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(512 * 1024 * 1024);
  });

  it("throws VFSQuotaExceededError past the per-file cap", async () => {
    const fs = new FileSystem({ maxFileSize: 100 });
    await fs.writeFile("/ok.txt", "a".repeat(100)); // exactly at the limit passes
    await expect(fs.writeFile("/big.txt", "a".repeat(101))).rejects.toThrow(VFSQuotaExceededError);
    const err = await fs.writeFile("/big.txt", "a".repeat(101)).then(
      () => {
        throw new Error("expected VFSQuotaExceededError");
      },
      (e: unknown) => e as VFSQuotaExceededError,
    );
    expect(err.code).toBe("EFBIG");
    expect(err.attemptedBytes).toBe(101);
    expect(err.limit).toBe(100);
  });

  it("measures the cap in UTF-8 bytes, not characters", async () => {
    const fs = new FileSystem({ maxFileSize: 10 });
    await fs.writeFile("/u.txt", "ééé"); // 3 chars, 6 bytes: fits
    await expect(fs.writeFile("/u2.txt", "éééééé")).rejects.toThrow(VFSQuotaExceededError); // 12 bytes
  });

  it("evicts least-recently-used files to satisfy the whole-VFS cap", async () => {
    const fs = new FileSystem({ maxFileSize: 500, maxTotalBytes: 1000 });
    await fs.writeFile("/a.txt", "A".repeat(400)); // counter 1
    await fs.writeFile("/b.txt", "B".repeat(400)); // counter 2; total 800
    await fs.readFile("/a.txt", "utf8"); // touch a: counter 3
    await fs.writeFile("/c.txt", "C".repeat(400)); // needs 400: total 1200 > 1000
    // LRU order is now b (2) before a (3): b is evicted, total 400+400=800.
    await expect(fs.readFile("/b.txt")).rejects.toThrow(VFSNotFoundError);
    await expect(fs.readFile("/a.txt", "utf8")).resolves.toBe("A".repeat(400));
    await expect(fs.readFile("/c.txt", "utf8")).resolves.toBe("C".repeat(400));
  });

  it("evicts every candidate before an oversized write still fails per-file", async () => {
    const fs = new FileSystem({ maxFileSize: 500, maxTotalBytes: 1000 });
    await fs.writeFile("/a.txt", "A".repeat(500));
    await fs.writeFile("/b.txt", "B".repeat(500)); // evicts a; total 500
    await expect(fs.writeFile("/c.txt", "C".repeat(501))).rejects.toThrow(VFSQuotaExceededError);
  });

  it("rejects invalid capacity configurations", () => {
    expect(() => new FileSystem({ maxFileSize: 100, maxTotalBytes: 50 })).toThrow(RangeError);
    expect(() => new FileSystem({ maxFileSize: 0 })).toThrow(RangeError);
  });
});

describe("concurrency (worker-safe async-first surface)", () => {
  it("resolves concurrent writes to distinct paths without loss", async () => {
    const fs = new FileSystem();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => fs.writeFile(`/cc/f${i}.txt`, `data-${i}`)),
    );
    const names = await fs.readdir("/cc");
    expect(names.length).toBe(20);
    expect(await fs.readFile("/cc/f7.txt", "utf8")).toBe("data-7");
  });

  it("resolves concurrent writes to the same path deterministically (last wins)", async () => {
    const fs = new FileSystem();
    await Promise.all([fs.writeFile("/c/p.txt", "first"), fs.writeFile("/c/p.txt", "second")]);
    expect(await fs.readFile("/c/p.txt", "utf8")).toBe("second");
  });

  it("tolerates interleaved reads during concurrent writes", async () => {
    const fs = new FileSystem();
    const reads = Array.from({ length: 10 }, (_, i) =>
      fs.readFile(`/mix/f${i}.txt`, "utf8").catch((e: unknown) => {
        // Reads may legitimately race ahead of their write; ENOENT is the
        // only tolerable failure, anything else must surface.
        if (e instanceof VFSNotFoundError) return "tolerated";
        throw e;
      }),
    );
    const writes = Array.from({ length: 10 }, (_, i) => fs.writeFile(`/mix/f${i}.txt`, `w${i}`));
    await Promise.all([...writes, ...reads]);
    expect(await fs.readdir("/mix").then((n) => n.length)).toBe(10);
  });
});
