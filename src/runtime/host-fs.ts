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
 * WHY `read` IS THE INTERESTING MEMBER. `esbuild-wasm`'s in-thread service assigns `fs.read` and `fs.writeSync` UNCONDITIONALLY, after the host's
 * object is already in place (`lib/browser.js`, in-thread service body, two assignments behind no guard at all), and the `read` it assigns is
 * stdin-only: `if (fd !== 0 || offset !== 0 || length !== buffer.length || position !== null) throw new Error("Bad read")`. Measured consequence:
 * every build whose entry point has to be read from disk died with `panic: JavaScript error: Bad read`, raised by esbuild's own function.
 *
 * The dependency optimizer survives that by passing contents through `onLoad` callbacks, which is why this shape was enough for it. Ordinary builds do
 * not: `vite build` with a `vite.config.js` bundles the config with esbuild, and that build's entry point is a real file on disk. So the member is
 * implemented properly here, and `read` is installed as an ACCESSOR that COMPOSES the two: the assignment is kept for fd 0, which is the service's own
 * message channel, and every other fd reads this object's files. That is not a trick to look clever: the
 * alternative is a runtime where a project builds or not depending on whether it has a config file, which is a property of our embedder leaking into a
 * verdict about somebody's project. `writeSync` keeps the opposite treatment on purpose, because THERE the assigned version is the correct one: it is
 * what carries the Go side's output to the program's stdout, so `write` delegates through `this`.
 *
 * WHAT `read` DOES WITH EACH FD. An fd this object opened reads the file's bytes from the VFS, honouring the caller's offset/length and either a
 * positional read or the handle's own advancing position, exactly as Node does. fd 0 answers EOF rather than throwing: the runtime has no fs-level
 * stdin to serve (stdin reaches a program as `process.stdin`), and a Go program that asks gets `0` bytes instead of a panic. Any other fd is `EBADF`.
 *
 * PATH SEMANTICS. Go passes what it was given, so a relative path stays relative: `Open` only prepends `process.cwd()` to the name it records, after
 * the call. Resolving here, against the program's cwd, is what makes `readdir(".")` mean the directory the program was started in.
 */

/** The filesystem facts a Go runtime asks for, and nothing wider. */
export interface HostFsSource {
  readdirSync(path: string): string[];
  /** Write a file's whole contents, creating it (and its parents) if needed. */
  writeFileSync(path: string, bytes: Uint8Array): void;
  /** Create a directory and its parents, as `mkdir -p`. */
  mkdirSync(path: string): void;
  /** A file's bytes. Throws when the path does not exist or is a directory, as Node's does. */
  readFileSync(path: string): Uint8Array | string;
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
export function hostFsSourceFrom(vfs: {
  readdirSync(path: string): string[];
  readFileSync(path: string): Uint8Array | string;
  statSync(path: string): { kind: "file" | "dir"; size: number; modifiedAt: number; createdAt: number };
  writeFileSync(path: string, data: Uint8Array | string, options?: { readonly evictable?: boolean }): void;
  mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
}): HostFsSource {
  return {
    readdirSync: (path) => vfs.readdirSync(path),
    // The VFS writes a file only where its parents already exist, which is Node's rule and the right one for a shim. Go's `Create` is a one-call
    // affair, so the parents are made here rather than making esbuild ask for a directory it never asked for.
    writeFileSync: (path, bytes) => {
      const slash = path.lastIndexOf("/");
      if (slash > 0) vfs.mkdirSync(path.slice(0, slash), { recursive: true });
      vfs.writeFileSync(path, bytes);
    },
    mkdirSync: (path) => vfs.mkdirSync(path, { recursive: true }),
    readFileSync: (path) => vfs.readFileSync(path),
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
  /** Where an unpositioned read resumes. Advanced by each read, as a real fd's offset is. */
  position: number;
  /** Opened for writing. Decides whether `write` reaches the file or the program's stdout. */
  readonly writable: boolean;
  /** `O_APPEND`: every write lands at the end, whatever the position says. */
  readonly append: boolean;
}

/**
 * The open flags the Go runtime ORs together, as real POSIX values.
 *
 * They used to be the -1 sentinels esbuild's own stub ships, which made every flag indistinguishable: `OpenFile(name, O_WRONLY|O_CREATE|O_TRUNC)` arrived
 * as arithmetic on -1 and nothing could tell a read from a truncating write. `syscall.init` copies these members into its own constants at startup, so
 * supplying real values is what makes those flags mean what they say.
 */
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
const O_ACCMODE = O_WRONLY | O_RDWR;

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
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void;
  close(fd: number, callback: Callback): void;
  mkdir(path: string, mode: number, callback: Callback): void;
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
    const handle = handles.get(fd);
    // An fd this object opened for writing is a file, not a stream. Sending its bytes to stdout was the defect: esbuild wrote every dependency
    // bundle into the program's log and nothing appeared on disk, so vite's optimizer produced metadata naming a file that did not exist.
    if (handle !== undefined) return writeFileBytes(handle, buffer);
    pending += decoder.decode(buffer);
    const newline = pending.lastIndexOf("\n");
    if (newline !== -1) {
      options.write(fd, pending.slice(0, newline + 1));
      pending = pending.slice(newline + 1);
    }
    return buffer.length;
  };

  /** A file's bytes, or empty when it does not exist yet: the write path may be creating it. */
  const bytesOf = (path: string): Uint8Array => {
    try {
      const existing = source.readFileSync(path);
      return typeof existing === "string" ? new TextEncoder().encode(existing) : existing;
    } catch {
      return new Uint8Array(0);
    }
  };

  /**
   * Put `chunk` into the file behind a writable handle: at `position` when one is given, else at the end for `O_APPEND`, else at the handle's own
   * advancing offset, which is the rule a real fd follows.
   *
   * The bytes reach the filesystem on every call rather than being held until `close`. A kernel buffers, but here buffering buys nothing and costs
   * correctness: `close` is not guaranteed (a Go program that panics never sends one), the files are small, and anything reading between the write and
   * the close would see a truncated file. The measured case needs exactly this: esbuild writes one bundle per dependency and vite renames the whole
   * directory immediately afterwards, from the JavaScript side, with no Go close in between.
   */
  const writeFileBytes = (handle: Handle, chunk: Uint8Array, position: number | null = null): number => {
    if (!handle.writable) {
      // Writing to a handle opened read-only is EBADF in POSIX, and answering it anyway would hide a caller's bug.
      throw failure("EBADF", "write", handle.path);
    }
    const current = bytesOf(handle.path);
    const start = position ?? (handle.append ? current.length : handle.position);
    const end = start + chunk.length;
    const next = new Uint8Array(Math.max(current.length, end));
    next.set(current, 0);
    next.set(chunk, start);
    source.writeFileSync(handle.path, next);
    handle.position = end;
    return chunk.length;
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
    constants: { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL: 0o200 },
    open(path: string, flags: number, _mode: number, callback: Callback): void {
      const resolved = at(path);
      const writable = (flags & (O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
      const append = (flags & O_APPEND) !== 0;
      try {
        if (writable) {
          // A writable open cannot be gated on the file existing: `O_CREAT` means it may not yet. `O_TRUNC` empties it now, which is what makes a
          // second, shorter write a complete file rather than a new head on the old tail.
          if ((flags & O_TRUNC) !== 0) source.writeFileSync(resolved, new Uint8Array(0));
          else {
            try {
              source.statSync(resolved);
            } catch (error) {
              if ((flags & O_CREAT) === 0) throw error;
              source.writeFileSync(resolved, new Uint8Array(0));
            }
          }
        } else {
          // Opened for its identity, not its contents: Go's Open is immediately followed by fstat to learn whether this is a directory to readdir.
          source.statSync(resolved);
        }
        const fd = nextFd;
        nextFd += 1;
        handles.set(fd, { path: resolved, position: 0, writable, append });
        callback(null, fd);
      } catch (error) {
        callback(error);
      }
    },
    mkdir(path: string, _mode: number, callback: Callback): void {
      try {
        // Recursive because that is what the caller means: esbuild asks for an output directory that may be several levels deep.
        source.mkdirSync(at(path));
        callback(null);
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
    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback): void {
      // fd 0 is stdin. EOF, not a throw: the runtime serves stdin as `process.stdin`, so there are no bytes here and a Go program asking for them
      // should see the end of the input rather than a panic.
      if (fd === 0) {
        callback(null, 0);
        return;
      }
      const handle = handles.get(fd);
      if (handle === undefined) {
        callback(failure("EBADF", "read", String(fd)));
        return;
      }
      try {
        const contents = source.readFileSync(handle.path);
        const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
        const start = position ?? handle.position;
        if (start >= bytes.length) {
          callback(null, 0);
          return;
        }
        const end = Math.min(start + length, bytes.length);
        const slice = bytes.subarray(start, end);
        buffer.set(slice, offset);
        // A positional read leaves the handle where it was; an unpositioned one advances it, which is the rule Node follows and the one Go's
        // `Read` relies on when it loops until it sees a short read.
        if (position === null) handle.position = end;
        callback(null, slice.length);
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
      const handle = handles.get(fd);
      if (handle !== undefined) {
        // A file fd takes the caller's slice and position; the stdout-only restriction below is about streams, where a partial write has nowhere to go.
        try {
          callback(null, writeFileBytes(handle, buffer.subarray(offset, offset + length), position));
        } catch (error) {
          callback(error);
        }
        return;
      }
      if (offset !== 0 || length !== buffer.length || position !== null) {
        callback(enosys());
        return;
      }
      callback(null, this.writeSync(fd, buffer));
    },
  };

  // `read` is an accessor rather than a data property, because esbuild's in-thread service assigns its own stdin-only `read` onto this object after
  // the object exists. Read off the object before the accessor replaces it, so the getter closes over the implementation rather than calling itself.
  //
  // The assignment is COMPOSED rather than ignored, and both halves are load-bearing. Its function cannot serve a file read: every fd except 0 makes
  // it throw, which is the `panic: JavaScript error: Bad read` that killed every build with a `vite.config.js`. But it is the ONLY thing that drains
  // the service's own message protocol, which arrives on fd 0 and is queued in a closure array this object cannot see. Measured: ignoring the
  // assignment made file reads work and left the service permanently mute. `await esbuild.build(...)` then suspended forever with nothing queued,
  // which the scheduler reported as a finished program. So fd 0 goes to the assigned reader when one exists and every other fd stays ours.
  const readImpl = fs.read;
  let stdinReader: typeof readImpl | null = null;
  const composedRead: typeof readImpl = (fd, buffer, offset, length, position, callback) => {
    if (fd === 0 && stdinReader !== null) {
      stdinReader(fd, buffer, offset, length, position, callback);
      return;
    }
    readImpl(fd, buffer, offset, length, position, callback);
  };
  Object.defineProperty(fs, "read", {
    configurable: true,
    enumerable: true,
    get: () => composedRead,
    set: (value: unknown) => {
      if (typeof value === "function") stdinReader = value as typeof readImpl;
    },
  });
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
