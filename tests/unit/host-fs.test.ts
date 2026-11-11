/**
 * The host `fs` object a Go runtime calls into, pinned without 12 MB of wasm.
 *
 * Every assertion here comes from Go's own `src/syscall/fs_js.go` rather than from POSIX: that file is what turns these calls into a Go program's
 * filesystem, and it disagrees with POSIX in ways that show up as confusing errors if the host guesses. The measurements that produced these tests are
 * in `docs/audit/front-end-boundary-esbuild.md`; `tools/measure-esbuild-wasm.ts` is the instrument that makes the same calls for real.
 */

import { describe, expect, it } from "vitest";

import { createCompleteHostFs, createHostFs, hostFsSourceFrom, REFUSED_HOST_FS_MEMBERS } from "../../src/runtime/host-fs.js";
import { FileSystem } from "../../src/vfs/index.js";

const stubMembers = [
  "writeSync",
  "write",
  "chmod",
  "chown",
  "close",
  "fchmod",
  "fchown",
  "fstat",
  "fsync",
  "ftruncate",
  "lchown",
  "link",
  "lstat",
  "mkdir",
  "open",
  "read",
  "readdir",
  "readlink",
  "rename",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
];

const setup = (seed: (vfs: FileSystem) => void = () => {}): { vfs: FileSystem; lines: string[]; fs: ReturnType<typeof createCompleteHostFs> } => {
  const vfs = new FileSystem();
  vfs.mkdirSync("/app", { recursive: true });
  seed(vfs);
  const lines: string[] = [];
  const fs = createCompleteHostFs(hostFsSourceFrom(vfs), { cwd: "/app", write: (_fd, text) => lines.push(text) });
  return { vfs, lines, fs };
};

/** Fetches a member by name, failing loudly rather than invoking `undefined` when the shape is missing one. */
const member = (fs: object, name: string): ((...args: unknown[]) => void) => {
  const found = (fs as Record<string, unknown>)[name];
  if (typeof found !== "function") throw new Error(`${name} is not a function on the host fs object`);
  return found as (...args: unknown[]) => void;
};

/** Calls a two-argument host member and reports what the callback was given, because the shape is a callback, not a return value. */
const call = (invoke: (callback: (error: unknown, value?: unknown) => void) => void): { error: unknown; value: unknown } => {
  let error: unknown;
  let value: unknown;
  invoke((raised, returned) => {
    error = raised;
    value = returned;
  });
  return { error, value };
};

describe("the host fs object's shape", () => {
  it("mirrors the stub member set the Go runtime boots against", () => {
    // The shape IS the boot contract: esbuild's stub is installed as one block, and Go's syscall.init walks these members. A missing one is a panic
    // inside the Go runtime with no JavaScript frame to blame, so the whole list is pinned rather than the members that happen to be implemented.
    const { fs } = setup();
    for (const name of stubMembers) {
      expect(fs, `host fs is missing ${name}`).toHaveProperty([name]);
      expect(typeof fs[name as keyof typeof fs], `${name} is not callable`).toBe("function");
    }
    // Go copies these and `syscall.Open` reads them; the stub's values are -1 sentinels and inventing real ones would change behaviour nobody measured.
    expect(fs.constants).toMatchObject({ O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 });
  });

  it("refuses the members nothing has been measured asking for", () => {
    const { fs } = setup();
    for (const name of REFUSED_HOST_FS_MEMBERS) {
      const { error } = call((callback) => member(fs, name)(callback));
      expect(error, `${name} should refuse`).toMatchObject({ code: "ENOSYS" });
    }
  });

  it("lets fsync succeed, as the stub does", () => {
    // The stub's one member that does not refuse. Go calls it after a write, and an error there fails a build that actually completed.
    const { fs } = setup();
    const { error } = call((callback) => member(fs, "fsync")(callback));
    expect(error).toBeNull();
  });
});

describe("Stats, field by field", () => {
  it("supplies every field Go's setStat reads", () => {
    // setStat calls .Int() on each of these; a missing one is `panic: syscall/js: call of Value.Int on undefined`, not a degraded result.
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/main.js", "hello"));
    const { value } = call((callback) => fs.stat("/app/main.js", callback));
    const stats = value as Record<string, unknown>;
    for (const field of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeMs", "mtimeMs", "ctimeMs"]) {
      expect(typeof stats[field], `${field} must be a number`).toBe("number");
    }
    expect(stats["size"]).toBe(5);
  });

  it("decides directory-ness with mode, the way Go does", () => {
    // Go runs `mode & S_IFMT == S_IFDIR`, so the mode bits are what make a directory a directory on the Go side.
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/main.js", "hello"));
    const file = call((callback) => fs.stat("/app/main.js", callback)).value as { mode: number; isDirectory(): boolean };
    const dir = call((callback) => fs.stat("/app", callback)).value as { mode: number; isDirectory(): boolean };
    expect(file.mode & 0o170000).toBe(0o100000);
    expect(dir.mode & 0o170000).toBe(0o040000);
    expect(file.isDirectory()).toBe(false);
    expect(dir.isDirectory()).toBe(true);
  });

  it("resolves a relative path against the program's cwd", () => {
    // Go's Open only prepends process.cwd() to the name it RECORDS, after the call, so the host is what makes a relative path mean anything.
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/entry.ts", "x"));
    expect(call((callback) => fs.stat("entry.ts", callback)).error).toBeNull();
    expect(call((callback) => fs.stat("./entry.ts", callback)).error).toBeNull();
  });
});

describe("Open, which is not POSIX open", () => {
  it("opens a directory and reports it through fstat", () => {
    // The recorded reason this matters: Go opens, then fstat decides whether to readdir. A host that refuses to open a directory produces
    // "Cannot read directory ".": Is a directory", which reads like a refusal and is really a broken open.
    const { fs } = setup((vfs) => {
      vfs.writeFileSync("/app/main.js", "x");
      vfs.writeFileSync("/app/entry.ts", "y");
    });
    const opened = call((callback) => fs.open("/app", 0, 0, callback));
    expect(opened.error).toBeNull();
    const fd = opened.value as number;
    expect(typeof fd).toBe("number");

    const stats = call((callback) => fs.fstat(fd, callback)).value as { isDirectory(): boolean };
    expect(stats.isDirectory()).toBe(true);

    const entries = call((callback) => fs.readdir("/app", callback)).value as string[];
    expect(entries.sort()).toEqual(["entry.ts", "main.js"]);
  });

  it("hands out distinct fds and forgets one after close", () => {
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/main.js", "x"));
    const first = call((callback) => fs.open("/app/main.js", 0, 0, callback)).value as number;
    const second = call((callback) => fs.open("/app/main.js", 0, 0, callback)).value as number;
    expect(second).not.toBe(first);
    expect(fs.close(first, () => {})).toBeUndefined();
    expect(call((callback) => fs.fstat(first, callback)).error).toMatchObject({ code: "EBADF" });
  });

  it("reports a missing file with a code Go recognises", () => {
    // mapJSError panics on a code it does not know, so the error must be Node-shaped and carry a standard code rather than a custom one.
    const { fs } = setup();
    expect(call((callback) => fs.open("/app/nope.ts", 0, 0, callback)).error).toMatchObject({ code: "ENOENT" });
    expect(call((callback) => fs.stat("/app/nope.ts", callback)).error).toMatchObject({ code: "ENOENT" });
    expect(call((callback) => fs.readdir("/app/nope", callback)).error).toMatchObject({ code: "ENOENT" });
  });

});

describe("read, the member esbuild tries to take away", () => {
  // The recorded failure this closes: `vite build` with a `vite.config.js` bundles that config with esbuild, and esbuild's in-thread service assigns
  // its own stdin-only `read` (`throw new Error("Bad read")` for any fd but 0). A build whose entry point is a file on disk therefore died inside the
  // Go runtime. The host's `read` is installed as an accessor so the later assignment cannot replace it; these tests hold both halves of that.

  const readInto = (fs: ReturnType<typeof createCompleteHostFs>, fd: number, size: number, position: number | null): { error: unknown; count: number; text: string } => {
    const buffer = new Uint8Array(size);
    let error: unknown;
    let count = 0;
    member(fs, "read")(fd, buffer, 0, size, position, (raised: unknown, read?: unknown) => {
      error = raised;
      count = typeof read === "number" ? read : 0;
    });
    return { error, count, text: new TextDecoder().decode(buffer.subarray(0, count)) };
  };

  it("returns a file's bytes, which is what a bundler's entry point needs", () => {
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/main.js", "export const x = 1;\n"));
    const fd = call((callback) => fs.open("/app/main.js", 0, 0, callback)).value as number;
    const read = readInto(fs, fd, 64, null);
    expect(read.error).toBeNull();
    expect(read.text).toBe("export const x = 1;\n");
  });

  it("advances the handle on an unpositioned read and holds it on a positioned one", () => {
    // Go's `Read` loops until it sees a short read, so a host whose offset never moved would either loop forever or truncate a file silently.
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/data.txt", "abcdefghij"));
    const fd = call((callback) => fs.open("/app/data.txt", 0, 0, callback)).value as number;

    expect(readInto(fs, fd, 3, null).text).toBe("abc");
    expect(readInto(fs, fd, 3, null).text).toBe("def");
    // A positional read does not disturb the handle.
    expect(readInto(fs, fd, 2, 8).text).toBe("ij");
    expect(readInto(fs, fd, 4, null).text).toBe("ghij");
  });

  it("answers EOF with 0 rather than an error, so a reader knows to stop", () => {
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/short.txt", "ab"));
    const fd = call((callback) => fs.open("/app/short.txt", 0, 0, callback)).value as number;
    expect(readInto(fs, fd, 8, null)).toMatchObject({ error: null, count: 2, text: "ab" });
    expect(readInto(fs, fd, 8, null)).toMatchObject({ error: null, count: 0, text: "" });
    expect(readInto(fs, fd, 8, 99)).toMatchObject({ error: null, count: 0, text: "" });
  });

  it("serves stdin as EOF and an unknown fd as EBADF", () => {
    // There is no fs-level stdin in this runtime (it reaches a program as `process.stdin`), and a Go program that asks should see the end of the
    // input rather than a panic. An fd this object never handed out is a real mistake and gets a code Go's mapJSError recognises.
    const { fs } = setup();
    expect(readInto(fs, 0, 4, null)).toMatchObject({ error: null, count: 0 });
    expect(readInto(fs, 99, 4, null).error).toMatchObject({ code: "EBADF" });
  });

  it("survives the assignment esbuild makes after the object exists", () => {
    // This is the whole point, written as esbuild writes it: an unconditional assignment of a function that throws unless fd is 0. If the host's
    // accessor did not hold, a real build dies with `panic: JavaScript error: Bad read` and nothing in this file would explain why.
    const { fs } = setup((vfs) => vfs.writeFileSync("/app/main.js", "bytes"));
    const fd = call((callback) => fs.open("/app/main.js", 0, 0, callback)).value as number;
    (fs as unknown as Record<string, unknown>)["read"] = () => {
      throw new Error("Bad read");
    };
    const read = readInto(fs, fd, 16, null);
    expect(read.error).toBeNull();
    expect(read.text).toBe("bytes");
  });
});

describe("write", () => {
  it("routes fd 1 and 2 to their sinks", () => {
    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    const seen: Array<[number, string]> = [];
    const fs = createHostFs(hostFsSourceFrom(vfs), { cwd: "/app", write: (fd, text) => seen.push([fd, text]) });
    fs.write(1, new TextEncoder().encode("out\n"), 0, 4, null, () => {});
    fs.write(2, new TextEncoder().encode("err\n"), 0, 4, null, () => {});
    expect(seen).toEqual([
      [1, "out\n"],
      [2, "err\n"],
    ]);
  });

  it("holds a partial line until its newline arrives", () => {
    // The stub buffers, and a caller writing half a line must not have it cut in two on the way out.
    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    const seen: string[] = [];
    const fs = createHostFs(hostFsSourceFrom(vfs), { cwd: "/app", write: (_fd, text) => seen.push(text) });
    fs.write(1, new TextEncoder().encode("half"), 0, 4, null, () => {});
    expect(seen).toEqual([]);
    fs.write(1, new TextEncoder().encode(" line\nnext"), 0, 10, null, () => {});
    expect(seen).toEqual(["half line\n"]);
  });

  it("refuses a write it cannot honour rather than writing the wrong bytes", () => {
    // Go always passes offset 0 and the whole buffer; the stub refuses anything else, so a slice write is a bug worth surfacing.
    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    const fs = createHostFs(hostFsSourceFrom(vfs), { cwd: "/app", write: () => {} });
    const { error } = call((callback) => fs.write(1, new Uint8Array(4), 1, 2, null, callback as never));
    expect(error).toMatchObject({ code: "ENOSYS" });
  });
});
