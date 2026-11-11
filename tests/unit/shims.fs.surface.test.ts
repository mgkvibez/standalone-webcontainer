/**
 * The fs members docs/audit/api-surface-p0.md added, pinned so the suite catches a regression without real Node as judge.
 *
 * Every assertion has a matching case in tools/differential/api-cases.ts that runs the same shape in real Node AND here. The differential
 * proves the ANSWER matches Node; these keep a later edit from silently changing it in the gate's own lane.
 */

import { describe, expect, it } from "vitest";

import { createFsShim, FS_CONSTANTS, Stats } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";

const shim = (options: { cwd?: string; vfs?: FileSystem } = {}) => {
  const vfs = options.vfs ?? new FileSystem();
  return { vfs, fs: createFsShim(vfs, options.cwd === undefined ? {} : { cwd: options.cwd }) };
};

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_THROW";
};

describe("fs.rmSync", () => {
  it("removes a tree and every file in it", () => {
    const { vfs, fs } = shim();
    fs.mkdirSync("/d");
    fs.writeFileSync("/d/a.txt", "x");
    fs.mkdirSync("/d/nested");
    fs.writeFileSync("/d/nested/b.txt", "y");

    fs.rmSync("/d", { recursive: true, force: true });

    expect(() => vfs.statSync("/d")).toThrow();
  });

  it("refuses a directory without recursive, as Node does", () => {
    const { fs } = shim();
    fs.mkdirSync("/d");
    expect(codeOf(() => fs.rmSync("/d"))).toBe("EISDIR");
  });

  it("treats a missing path as an error unless force is set", () => {
    const { fs } = shim();
    expect(codeOf(() => fs.rmSync("/gone"))).toBe("ENOENT");
    expect(() => fs.rmSync("/gone", { recursive: true, force: true })).not.toThrow();
  });

  it("removes a plain file", () => {
    const { fs } = shim();
    fs.writeFileSync("/a.txt", "x");
    fs.rmSync("/a.txt");
    expect(fs.existsSync("/a.txt")).toBe(false);
  });
});

describe("fs.appendFileSync", () => {
  it("appends to what is already there", () => {
    const { fs } = shim();
    fs.writeFileSync("/a.txt", "1");
    fs.appendFileSync("/a.txt", "2");
    fs.appendFileSync("/a.txt", "3");
    expect(fs.readFileSync("/a.txt", "utf8")).toBe("123");
  });

  it("creates the file when it is absent", () => {
    const { fs } = shim();
    fs.appendFileSync("/fresh.txt", "made");
    expect(fs.readFileSync("/fresh.txt", "utf8")).toBe("made");
  });

  it("appends bytes without decoding them", () => {
    const { fs } = shim();
    fs.writeFileSync("/b.bin", new Uint8Array([0]));
    fs.appendFileSync("/b.bin", new Uint8Array([255, 1]));
    expect([...(fs.readFileSync("/b.bin") as Uint8Array)]).toEqual([0, 255, 1]);
  });
});

describe("fs.copyFileSync", () => {
  it("copies the bytes, leaving the source alone", () => {
    const { fs } = shim();
    fs.writeFileSync("/a.txt", "copy-me");
    fs.copyFileSync("/a.txt", "/b.txt");
    fs.writeFileSync("/a.txt", "changed");
    expect(fs.readFileSync("/b.txt", "utf8")).toBe("copy-me");
  });

  it("honours COPYFILE_EXCL, the only mode bit it publishes", () => {
    const { fs } = shim();
    fs.writeFileSync("/a.txt", "x");
    fs.writeFileSync("/b.txt", "y");
    expect(codeOf(() => fs.copyFileSync("/a.txt", "/b.txt", FS_CONSTANTS.COPYFILE_EXCL))).toBe("EEXIST");
    expect(fs.readFileSync("/b.txt", "utf8")).toBe("y");
  });
});

describe("fs.accessSync", () => {
  it("passes on a path that exists and reports ENOENT on one that does not", () => {
    const { fs } = shim();
    fs.writeFileSync("/here.txt", "x");
    expect(() => fs.accessSync("/here.txt")).not.toThrow();
    expect(codeOf(() => fs.accessSync("/gone.txt"))).toBe("ENOENT");
  });

  it("accepts a mode and ignores it, because this VFS has no permission bits", () => {
    const { fs } = shim();
    fs.writeFileSync("/here.txt", "x");
    expect(() => fs.accessSync("/here.txt", FS_CONSTANTS.W_OK)).not.toThrow();
  });
});

describe("fs.mkdtempSync", () => {
  it("creates an empty directory carrying the prefix", () => {
    const { fs } = shim();
    const dir = fs.mkdtempSync("/run-");
    expect(dir.startsWith("/run-")).toBe(true);
    expect(dir.length).toBeGreaterThan("/run-".length);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("creates two different directories from one prefix", () => {
    const { fs } = shim();
    expect(fs.mkdtempSync("/t-")).not.toBe(fs.mkdtempSync("/t-"));
  });

  it("reports the path in the CALLER's shape, as Node does", () => {
    // A relative prefix must come back relative: the caller joins the answer onto its own base, and an absolutised path would put the project
    // root in the middle of the result.
    const seeded = new FileSystem();
    seeded.mkdirSync("/app");
    const { fs } = shim({ cwd: "/app", vfs: seeded });
    expect(fs.mkdtempSync("run-").startsWith("run-")).toBe(true);
    expect(fs.mkdtempSync("./tmp-").startsWith("./tmp-")).toBe(true);
  });
});

describe("fs.truncateSync", () => {
  it("shortens a file to a length", () => {
    const { fs } = shim();
    fs.writeFileSync("/t.txt", "hello world");
    fs.truncateSync("/t.txt", 5);
    expect(fs.readFileSync("/t.txt", "utf8")).toBe("hello");
  });

  it("extends it with zero bytes, which is the same operation in Node", () => {
    const { fs } = shim();
    fs.writeFileSync("/t.txt", "ab");
    fs.truncateSync("/t.txt", 4);
    expect([...(fs.readFileSync("/t.txt") as Uint8Array)]).toEqual([97, 98, 0, 0]);
  });

  it("defaults to zero", () => {
    const { fs } = shim();
    fs.writeFileSync("/t.txt", "abc");
    fs.truncateSync("/t.txt");
    expect(fs.readFileSync("/t.txt", "utf8")).toBe("");
  });
});

describe("fs.lstatSync and fs.Stats", () => {
  it("answers about the path itself, the same answer as stat without links", () => {
    const { fs } = shim();
    fs.writeFileSync("/l.txt", "abc");
    const stats = fs.lstatSync("/l.txt");
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.size).toBe(3);
    expect(stats.isSymbolicLink()).toBe(false);
  });

  it("is an instance of the exported class, which is what `instanceof` callers check", () => {
    const { fs } = shim();
    fs.writeFileSync("/s.txt", "x");
    expect(fs.statSync("/s.txt")).toBeInstanceOf(Stats);
    expect(fs.lstatSync("/s.txt")).toBeInstanceOf(fs.Stats);
  });

  it("reports a missing path as ENOENT under the lstat syscall", () => {
    const { fs } = shim();
    expect(codeOf(() => fs.lstatSync("/gone"))).toBe("ENOENT");
  });
});

describe("the fs/promises twins", () => {
  it("append, copy, truncate and mkdtemp answer like the sync forms", async () => {
    const { fs } = shim();
    fs.writeFileSync("/p.txt", "a");
    await fs.promises.appendFile("/p.txt", "b");
    await fs.promises.copyFile("/p.txt", "/q.txt");
    await fs.promises.truncate("/q.txt", 1);
    expect(fs.readFileSync("/p.txt", "utf8")).toBe("ab");
    expect(fs.readFileSync("/q.txt", "utf8")).toBe("a");
    const made = await fs.promises.mkdtemp("/pm-");
    expect(fs.statSync(made).isDirectory()).toBe(true);
  });
});

describe("fs.constants", () => {
  it("carries Node's values for the names it publishes", () => {
    expect(FS_CONSTANTS).toEqual({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 });
  });

  it("does not publish O_* flags, because open() takes string flags here", () => {
    expect(Object.keys(FS_CONSTANTS).some((name) => name.startsWith("O_"))).toBe(false);
  });
});
