import { describe, expect, it } from "vitest";

import { createFsShim } from "../../src/shims/fs.js";
import { promisify } from "../../src/shims/util.js";
import { FileSystem } from "../../src/vfs/index.js";

describe("filesystem quota errors", () => {
  it("maps protected-file capacity failures to Node ENOSPC", () => {
    const vfs = new FileSystem({ maxFileSize: 10, maxTotalBytes: 10 });
    vfs.writeFileSync("/project/source.js", "12345678");
    const fs = createFsShim(vfs);

    let caught: unknown;
    try {
      fs.writeFileSync("/project/next.js", "1234");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "ENOSPC", errno: -28, syscall: "open", path: "/project/next.js" });
    expect(vfs.readFileSync("/project/source.js", "utf8")).toBe("12345678");
  });

  it("maps the per-file cap to Node EFBIG", () => {
    const fs = createFsShim(new FileSystem({ maxFileSize: 5, maxTotalBytes: 10 }));

    let caught: unknown;
    try {
      fs.writeFileSync("/too-large.js", "123456");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "EFBIG", errno: -27, syscall: "open", path: "/too-large.js" });
  });
});

describe("PathLike", () => {
  it("reads a file named by a file URL, which is how vite opens its own manifest", () => {
    // The literal call that stopped vite's boot: `readFileSync(new URL("../../package.json", import.meta.url))`. Node accepts it everywhere it
    // accepts a path, and the failure it produced here (`path.startsWith is not a function`) pointed at the shim's own resolve line rather than at
    // the caller.
    const vfs = new FileSystem();
    vfs.writeFileSync("/node_modules/vite/package.json", '{"version":"5.4.21"}');
    const fs = createFsShim(vfs);

    const read = fs.readFileSync(new URL("file:///node_modules/vite/package.json"), "utf8");

    expect(read).toBe('{"version":"5.4.21"}');
    expect(fs.existsSync(new URL("file:///node_modules/vite/package.json"))).toBe(true);
    expect(fs.statSync(new URL("file:///node_modules/vite/package.json")).isFile()).toBe(true);
  });

  it("reports a missing file by its path, as Node does for a URL argument", () => {
    const fs = createFsShim(new FileSystem());

    let caught: unknown;
    try {
      fs.readFileSync(new URL("file:///absent.json"));
    } catch (error) {
      caught = error;
    }

    // Node validates the PathLike into a path before it stats anything, so the error carries the path rather than the URL. Checked against
    // Node rather than assumed: a stringified `[object URL]` here would be the kind of wrongness that only shows up in a program comparing paths.
    expect(caught).toMatchObject({ code: "ENOENT", syscall: "open", path: "/absent.json" });
  });
});

/** Resolves with a callback's value, so a callback form can be awaited instead of asserted on twice. */
function callbackValue<T>(register: (callback: (error: unknown, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    register((error, value) => (error === null || error === undefined ? resolve(value as T) : reject(error)));
  });
}

function caughtBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("realpath", () => {
  it("resolves an existing path, and .native is the same answer", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/src/a.js", "x");
    const fs = createFsShim(vfs);

    // vite reaches this as `realpathSync.native`, so the property has to exist as well as the function.
    expect(fs.realpathSync("/project/src/../src/a.js")).toBe("/project/src/a.js");
    expect(fs.realpathSync.native("/project/src/a.js")).toBe("/project/src/a.js");
    expect(typeof fs.realpathSync.native).toBe("function");
  });

  it("throws Node's ENOENT with syscall realpath for a missing file", () => {
    const fs = createFsShim(new FileSystem());

    expect(caughtBy(() => fs.realpathSync("/absent.js"))).toMatchObject({ code: "ENOENT", syscall: "realpath", path: "/absent.js" });
    expect(caughtBy(() => fs.realpathSync.native("/absent.js"))).toMatchObject({ code: "ENOENT", syscall: "realpath" });
  });

  it("calls back in both shapes Node accepts, including the two-argument form promisify produces", async () => {
    // Measured, not assumed: `promisify(fs.realpath)` invokes `fs.realpath(path, callback)`, so the callback arrives as the SECOND argument
    // while the options form puts it third. Both are pinned because the wrapper used to declare only the options shape, which would have
    // hidden a regression rather than caused one: the delivered value still worked, so nothing would have failed loudly.
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);

    await expect(promisify(fs.realpath)("/project/a.txt")).resolves.toBe("/project/a.txt");
    await expect(callbackValue<string>((callback) => fs.realpath("/project/a.txt", (error, resolved) => callback(error, resolved)))).resolves.toBe(
      "/project/a.txt",
    );
    await expect(
      callbackValue<string>((callback) => fs.realpath("/project/a.txt", {}, (error, resolved) => callback(error, resolved))),
    ).resolves.toBe("/project/a.txt");
  });

  it("reports a missing file to the callback with the same code the sync form throws", async () => {
    const fs = createFsShim(new FileSystem());

    await expect(callbackValue<string>((callback) => fs.realpath("/absent.js", (error, resolved) => callback(error, resolved)))).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "realpath",
      path: "/absent.js",
    });
  });
});

describe("the callback members chokidar promisifies at module scope", () => {
  it("readdir calls back with entry names", async () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.js", "x");
    vfs.writeFileSync("/project/b.js", "x");
    const fs = createFsShim(vfs);

    const names = await callbackValue<string[]>((callback) => fs.readdir("/project", (error, entries) => callback(error, entries)));
    expect([...names].sort()).toEqual(["a.js", "b.js"]);
  });

  it("readdir calls back with ENOENT for a missing directory", async () => {
    const fs = createFsShim(new FileSystem());

    await expect(callbackValue<string[]>((callback) => fs.readdir("/absent", (error, entries) => callback(error, entries)))).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "scandir",
      path: "/absent",
    });
  });

  it("stat and lstat call back with stats, and lstat is stat because nothing here is a link", async () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.js", "1234");
    const fs = createFsShim(vfs);

    const stat = await callbackValue<{ isFile: () => boolean; size: number }>((callback) =>
      fs.stat("/project/a.js", (error, stats) => callback(error, stats)),
    );
    const lstat = await callbackValue<{ isFile: () => boolean; size: number }>((callback) =>
      fs.lstat("/project/a.js", (error, stats) => callback(error, stats)),
    );
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(4);
    expect(lstat.size).toBe(stat.size);
  });

  it("stat reports its own syscall name, which is what a program branching on the error reads", async () => {
    const fs = createFsShim(new FileSystem());

    await expect(callbackValue<unknown>((callback) => fs.stat("/absent", (error, stats) => callback(error, stats)))).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "stat",
    });
    await expect(callbackValue<unknown>((callback) => fs.lstat("/absent", (error, stats) => callback(error, stats)))).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "lstat",
    });
  });
});

describe("open descriptors", () => {
  it("hands back an integer and takes it back on close, and a closed descriptor stays bad", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);

    const fd = fs.openSync("/project/a.txt", "r");
    // Node's first non-standard descriptor is 3, and the table starts where Node's does.
    expect(fd).toBe(3);
    expect(fs.closeSync(fd)).toBeUndefined();
    expect(caughtBy(() => fs.closeSync(fd))).toMatchObject({ code: "EBADF", errno: -9, syscall: "close" });
  });

  it("applies the flag's side effects at open, which is what the flag means in Node", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);

    fs.closeSync(fs.openSync("/project/created.txt", "w"));
    expect(fs.existsSync("/project/created.txt")).toBe(true);
    fs.closeSync(fs.openSync("/project/a.txt", "w"));
    // "w" truncates before anything is written through the descriptor.
    expect(vfs.readFileSync("/project/a.txt", "utf8")).toBe("");
  });

  it("refuses a missing file and an exclusive create with Node's codes", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);

    expect(caughtBy(() => fs.openSync("/project/absent.txt", "r"))).toMatchObject({ code: "ENOENT", errno: -2, syscall: "open" });
    expect(caughtBy(() => fs.openSync("/project/a.txt", "wx"))).toMatchObject({ code: "EEXIST", errno: -17, syscall: "open" });
    // The failed opens left no descriptors behind, so the next one is still 3 rather than a leaked number.
    expect(fs.openSync("/project/a.txt", "r")).toBe(3);
  });

  it("refuses positional I/O by name, quoting the descriptor and the file it names", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);
    const fd = fs.openSync("/project/a.txt", "r");

    for (const operation of ["readSync", "writeSync"] as const) {
      const error = caughtBy(() => fs[operation](fd));
      expect(error).toMatchObject({ code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" });
      // This VFS reads and writes whole files, so there is no faithful positional answer; saying so is the whole implementation.
      expect((error as Error).message).toContain(`fs.${operation} on a file descriptor is not implemented`);
      expect((error as Error).message).toContain("fd 3 for '/project/a.txt'");
      expect((error as Error).message).toContain("readFile/writeFile");
    }
  });

  it("calls back rather than throwing, in Node's (error, fd) shape", async () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/project/a.txt", "hello");
    const fs = createFsShim(vfs);

    const fd = await callbackValue<number>((callback) => fs.open("/project/a.txt", "r", (error, opened) => callback(error, opened)));
    expect(fd).toBe(3);
    await expect(callbackValue<number>((callback) => fs.open("/project/absent.txt", "r", (error, opened) => callback(error, opened)))).rejects.toMatchObject({
      code: "ENOENT",
      path: "/project/absent.txt",
    });
  });

  it("refuses numeric flags by name instead of guessing a mode", () => {
    const fs = createFsShim(new FileSystem());

    expect(caughtBy(() => fs.openSync("/project/a.txt", 0))).toMatchObject({ code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" });
    expect(caughtBy(() => fs.openSync("/project/a.txt", "bogus"))).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });
});
