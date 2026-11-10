/**
 * The `fs` object a WebAssembly program's Go runtime calls into.
 *
 * WHY THIS EXISTS. A Go binary compiled to `js/wasm` never touches the filesystem itself: every file call is a `syscall/js` call into a JavaScript
 * object named `fs`. `esbuild-wasm`'s loader installs a stub of that object whose every member answers `ENOSYS`, and guards the whole stub block behind
 * `if (!globalThis.fs)`. So the choice is not "stub or no stub", it is "their stub, or an object of this exact shape". `self.fs = {}` panics the Go
 * runtime at `syscall.init`; a mirror of the stub's member set boots. Measured, twice, before this file existed.
 *
 * WHAT IS IMPLEMENTED, AND WHY ONLY THAT. The member set is esbuild's stub, member for member, because the shape is the boot contract. The members
 * that actually answer are the ones a real build was observed to call, recorded with `npx tsx tools/measure-esbuild-wasm.ts --syscalls --trace`:
 * `stat`, `open`, `fstat`, `readdir`, `close`, `lstat`, `write`. Everything else keeps the stub's `ENOSYS`, which is honest: nothing has been
 * measured asking for it, and answering a call nobody makes is inventing behaviour.
 *
 * WHY THERE IS NO FILE-BYTE READ, WHICH IS THE INTERESTING PART. It is not omitted for effort. `esbuild-wasm`'s in-thread service assigns
 * `fs.read` and `fs.writeSync` UNCONDITIONALLY, after the host's object is already in place (`lib/browser.js`, in-thread service body, two assignments
 * behind no guard at all), and its `read` is stdin-only: any other fd throws `Bad read`. Measured consequence: a build whose entry point has to be
 * read from disk dies with `panic: JavaScript error: Bad read`, raised by esbuild's own function, not by ours. So in the browser embedder the Go side
 * can learn a file's METADATA but never its BYTES, and module contents have to arrive through `onLoad` plugin callbacks instead. That is exactly what
 * Vite's dependency optimizer does, which is why this is the shape the optimizer needs rather than a compromise.
 *
 * PATH SEMANTICS. Go passes what it was given, so a relative path stays relative: `Open` only prepends `process.cwd()` to the name it records, after
 * the call. Resolving here, against the program's cwd, is what makes `readdir(".")` mean the directory the program was started in.
 */

/** The filesystem facts a Go runtime asks for, and nothing wider. */
export interface HostFsSource {
  readdirSync(path: string): string[];
  statSync(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
  };
}

/**
 * The VFS's own vocabulary translated into the narrow one this adapter speaks.
 *
 * `kind` and `modifiedAt` are the VFS's words; `isFile`, `mtimeMs` and `birthtimeMs` are Node's, and Node's is what Go reads. One translation, here,
 * rather than a second stat shape inside the adapter: a VFS that changed its own vocabulary would break in one place.
 */
export function hostFsSourceFrom(vfs: { readdirSync(path: string): string[]; statSync(path: string): { kind: "file" | "dir"; size: number; modifiedAt: number; createdAt: number } }): HostFsSource {
  return {
    readdirSync: (path) => vfs.readdirSync(path),
    statSync: (path) => {
      const stats = vfs.statSync(path);
      const directory = stats.kind === "dir";
      return {
        isFile: () => !directory,
        isDirectory: () => directory,
        size: stats.size,
        mtimeMs: stats.modifiedAt,
        birthtimeMs: stats.createdAt,
      };
    },
  };
}

/** Where a write on a given fd goes. */
export interface HostFsSink {
  (fd: number, text: string): void;
}

type Callback = (error: unknown, value?: unknown) => void;

const enosys = (): Error & { code: string } => {
  const error = new Error("not implemented") as Error & { code: string };
  error.code = "ENOSYS";
  return error;
};

/** A Node-shaped error, because Go's `mapJSError` reads `err.code` and panics on a code it does not recognise. */
const failure = (code: string, syscall: string, path: string): Error & { code: string; syscall: string; path: string } => {
  const error = new Error(`${code}: ${syscall} '${path}'`) as Error & { code: string; syscall: string; path: string };
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
};

/**
 * The `Stats` object Go reads field by field in `setStat`.
 *
 * A partial object does not degrade, it panics: `syscall.setStat` calls `.Int()` on `dev`, `ino`, `mode`, `nlink`, `uid`, `gid`, `rdev`, `size`,
 * `blksize`, `blocks` and the three `*Ms` values, and `.Int()` on `undefined` panics the Go runtime. Measured as `panic: syscall/js: call of
 * Value.Int on undefined` at `syscall/fs_js.go:166`. `mode` is the load-bearing field: Go decides directory-ness with `mode & S_IFMT == S_IFDIR`.
 */
const statsFor = (stats: ReturnType<HostFsSource["statSync"]>): Record<string, unknown> => {
  const directory = stats.isDirectory();
  return {
    dev: 1,
    ino: 1,
    mode: (directory ? 0o040000 : 0o100000) | (directory ? 0o755 : 0o644),
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: stats.size,
    blksize: 4096,
    blocks: Math.ceil(stats.size / 512),
    atimeMs: stats.mtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    isFile: () => stats.isFile(),
    isDirectory: () => directory,
  };
};

/** An open fd. Directories are opened too: Go's `Open` opens first, then asks `fstat` what it got. */
interface Handle {
  readonly path: string;
}

/** The object placed at `globalThis.fs` for a program that loads a Go runtime. */
export interface HostFs {
  readonly constants: Readonly<Record<string, number>>;
  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void;
  writeSync(fd: number, buffer: Uint8Array): number;
  open(path: string, flags: number, mode: number, callback: Callback): void;
  fstat(fd: number, callback: Callback): void;
  stat(path: string, callback: Callback): void;
  lstat(path: string, callback: Callback): void;
  readdir(path: string, callback: Callback): void;
  close(fd: number, callback: Callback): void;
}

/**
 * Builds the host object.
 *
 * `cwd` is the program's working directory, so a relative path from Go resolves the way the same path would in a program written by hand.
 */
export function createHostFs(source: HostFsSource, options: { readonly cwd: string; readonly write: HostFsSink }): HostFs {
  const handles = new Map<number, Handle>();
  let nextFd = 3;
  const decoder = new TextDecoder("utf-8");

  /** Relative paths resolve against the program's cwd, which is what `Open`'s own fallback would do one call later. */
  const at = (path: string): string => {
    if (path.startsWith("/")) return path;
    const base = options.cwd.endsWith("/") ? options.cwd.slice(0, -1) : options.cwd;
    return `${base}/${path}`;
  };

  // Line-buffered, as the stub is: a caller that writes half a line must not have it cut in two on the way out.
  let pending = "";
  const writeSync = (fd: number, buffer: Uint8Array): number => {
    pending += decoder.decode(buffer);
    const newline = pending.lastIndexOf("\n");
    if (newline !== -1) {
      options.write(fd, pending.slice(0, newline + 1));
      pending = pending.slice(newline + 1);
    }
    return buffer.length;
  };

  const statOf = (path: string, callback: Callback): void => {
    try {
      callback(null, statsFor(source.statSync(at(path))));
    } catch (error) {
      callback(error);
    }
  };

  const fs: HostFs = {
    // `syscall.Open` copies these members, and the stub's own values are -1 sentinels. Kept identical rather than invented: a caller that branches
    // on a flag is branching on something this runtime never implemented, and matching the stub is the only behaviour that cannot surprise it.
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
    open(path: string, _flags: number, _mode: number, callback: Callback): void {
      const resolved = at(path);
      try {
        // Opened for its identity, not its contents: Go's Open is immediately followed by fstat to learn whether this is a directory to readdir.
        source.statSync(resolved);
        const fd = nextFd;
        nextFd += 1;
        handles.set(fd, { path: resolved });
        callback(null, fd);
      } catch (error) {
        callback(error);
      }
    },
    fstat(fd: number, callback: Callback): void {
      const handle = handles.get(fd);
      if (handle === undefined) {
        callback(failure("EBADF", "fstat", String(fd)));
        return;
      }
      statOf(handle.path, callback);
    },
    stat: (path: string, callback: Callback) => statOf(path, callback),
    // No symlinks exist in this VFS, so `lstat` is `stat`. Documented rather than silently aliased.
    lstat: (path: string, callback: Callback) => statOf(path, callback),
    readdir(path: string, callback: Callback): void {
      const resolved = at(path);
      try {
        callback(null, source.readdirSync(resolved));
      } catch (error) {
        callback(error);
      }
    },
    close(fd: number, callback: Callback): void {
      handles.delete(fd);
      callback(null);
    },
    writeSync,
    // Delegates through `this`, exactly as the stub does, because esbuild replaces `writeSync` on this object when its service starts and that
    // replacement is what carries output to the program's stdout. Calling our own copy directly would bypass it and print nothing.
    write(this: HostFs, fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void {
      if (offset !== 0 || length !== buffer.length || position !== null) {
        callback(enosys());
        return;
      }
      callback(null, this.writeSync(fd, buffer));
    },
  };
  return fs;
}

/**
 * The members the Go runtime may call, each answering `ENOSYS` unless `createHostFs` implements it.
 *
 * Kept as a list rather than left out, because omitting a member changes the object's SHAPE, and the shape is what boots the Go runtime. A caller
 * that reaches one of these gets a named refusal instead of a `TypeError` from the Go side.
 */
export const REFUSED_HOST_FS_MEMBERS: readonly string[] = [
  "chmod",
  "chown",
  "fchmod",
  "fchown",
  "ftruncate",
  "lchown",
  "link",
  "mkdir",
  "read",
  "readlink",
  "rename",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
];

/** Extends a host object with the refused members, so its shape matches the stub the Go runtime expects. */
export function withRefusedMembers(fs: HostFs): HostFs & Record<string, unknown> {
  const object = fs as unknown as Record<string, unknown>;
  for (const name of REFUSED_HOST_FS_MEMBERS) {
    object[name] = function refused(this: unknown, ...args: unknown[]): void {
      const callback = args[args.length - 1];
      if (typeof callback === "function") (callback as Callback)(enosys());
    };
  }
  // `fsync` is the stub's one member that SUCCEEDS rather than refusing: Go calls it after a write, and an error there would fail a build that
  // actually completed. Read off the stub, not assumed.
  object["fsync"] = function fsync(this: unknown, ...args: unknown[]): void {
    const callback = args[args.length - 1];
    if (typeof callback === "function") (callback as Callback)(null);
  };
  return object as HostFs & Record<string, unknown>;
}

/** Convenience: the complete object, refused members included. */
export function createCompleteHostFs(
  source: HostFsSource,
  options: { readonly cwd: string; readonly write: HostFsSink },
): HostFs & Record<string, unknown> {
  return withRefusedMembers(createHostFs(source, options));
}
