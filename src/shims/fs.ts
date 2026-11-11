import type { FileSystemPort, MkdirOptionsPort, VfsStatsPort, WatchSourcePort, WriteOptionsPort } from "../vfs/port.js";
import { toWatchAsyncIterator, type WatchAsyncIterator, type WatchHandlePort } from "../vfs/watch-iterator.js";
/**
 * `fs` shim: Node's documented `fs` surface, translated onto our VFS.
 *
 * ADR-0003 #1: the VFS remains the single owner of file state; this shim only
 * translates Node-shaped calls into VFS operations (never a second store). The
 * `memfs` package is the API-shape reference; it is not imported, because its
 * fifteen transitive `@jsonjoy` packages would land in a lockfile that cannot be
 * audited this week (ADR-0004, D-1).
 *
 * Errors are re-thrown as Node-shaped errors carrying `code` ("ENOENT", ...),
 * because real packages branch on `err.code` and a shim that throws internal
 * error classes breaks them at the first `catch`.
 */
import { path as nodePath } from "./path.js";
import { fileURLToPath } from "./url.js";
import { VFSError } from "../vfs/errors.js";
import { Buffer } from "buffer";

export interface NodeFsError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
}

/** Node's errno numbers for the codes we can raise. */
const ERRNO: Readonly<Record<string, number>> = {
  ENOENT: -2,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  ENOTEMPTY: -39,
  EINVAL: -22,
  ENOSPC: -28,
  EFBIG: -27,
  EPERM: -1,
};

const CODE_MAP: Readonly<Record<string, string>> = {
  ENOENT: "ENOENT",
  EEXIST: "EEXIST",
  ENOTDIR: "ENOTDIR",
  EISDIR: "EISDIR",
  ENOTEMPTY: "ENOTEMPTY",
  EINVAL: "EINVAL",
  EQUOTA: "ENOSPC",
  EENCODING: "EINVAL",
  EFBIG: "EFBIG",
  ENOSPC: "ENOSPC",
};

/**
 * A Node-shaped error for a VFS failure.
 *
 * `path` is the `PathLike` the caller gave, because that is what Node puts on the error and a program that compares it expects the same value it
 * passed. It is formatted into the message, so a URL reads as its href rather than as `[object URL]`.
 */
const toNodeError = (error: unknown, syscall: string, path: FsPath): NodeFsError => {
  const shown = typeof path === "string" ? path : path.href;
  if (error instanceof VFSError) {
    const code = CODE_MAP[error.code] ?? "EIO";
    const wrapped = new Error(`${code}: ${syscall} '${shown}'`) as NodeFsError;
    wrapped.code = code;
    wrapped.errno = ERRNO[code] ?? -1;
    wrapped.syscall = syscall;
    wrapped.path = shown;
    return wrapped;
  }
  // Anything that is not a VFS error is a bug in this shim, not user error: do
  // not masquerade it as a filesystem condition.
  throw error;
};

/** One place where a port stat becomes the Node-shaped one, so `statSync` and `statManySync` cannot drift apart. */
const asStats = (stats: VfsStatsPort): StatsShim => ({
  isFile: () => stats.kind === "file",
  isDirectory: () => stats.kind === "dir",
  size: stats.size,
  mtimeMs: stats.modifiedAt,
  birthtimeMs: stats.createdAt,
});

const asBuffer = (data: string | Uint8Array): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

export interface StatsShim {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/**
 * What Node accepts wherever it accepts a path: a string, or a `file:` URL.
 *
 * Measured, not speculative. Vite's `dist/node/constants.js` opens its own manifest with
 * `readFileSync(new URL("../../package.json", import.meta.url))`, which is ordinary Node and failed here with
 * `TypeError: path.startsWith is not a function` from a line that had nothing to do with the mistake. Buffer paths are deliberately not
 * supported: nothing in this runtime hands one over, and accepting a type no caller uses is a claim without a test.
 */
export type FsPath = string | URL;

/** A `file:` URL becomes the path it names; a string is already what every layer below wants. */
const pathOf = (value: FsPath): string => (typeof value === "string" ? value : fileURLToPath(value));

/**
 * The same VFS, accepting a URL wherever a path goes.
 *
 * One view rather than a conversion in twenty method bodies: the absolute shim below is written against a `FileSystemPort`, so wrapping the port
 * is the only place a path can be widened without every method repeating the rule. Wider parameters make this assignable to `FileSystemPort`, so
 * nothing above needs a cast.
 */
const pathAccepting = (vfs: FileSystemPort) => ({
  readFileSync: (path: FsPath, encoding?: "utf8") => vfs.readFileSync(pathOf(path), encoding),
  writeFileSync: (path: FsPath, data: string | Uint8Array, options?: WriteOptionsPort) =>
    vfs.writeFileSync(pathOf(path), data, options),
  mkdirSync: (path: FsPath, options?: MkdirOptionsPort) => vfs.mkdirSync(pathOf(path), options),
  readdirSync: (path: FsPath) => vfs.readdirSync(pathOf(path)),
  statSync: (path: FsPath) => vfs.statSync(pathOf(path)),
  ...(vfs.statManySync === undefined
    ? {}
    : { statManySync: (paths: readonly FsPath[]) => vfs.statManySync!(paths.map(pathOf)) }),
  unlinkSync: (path: FsPath) => vfs.unlinkSync(pathOf(path)),
  rmdirSync: (path: FsPath) => vfs.rmdirSync(pathOf(path)),
  renameSync: (from: FsPath, to: FsPath) => vfs.renameSync(pathOf(from), pathOf(to)),
  readFile: (path: FsPath, encoding?: "utf8") => vfs.readFile(pathOf(path), encoding),
  writeFile: (path: FsPath, data: string | Uint8Array, options?: WriteOptionsPort) =>
    vfs.writeFile(pathOf(path), data, options),
  mkdir: (path: FsPath, options?: MkdirOptionsPort) => vfs.mkdir(pathOf(path), options),
  readdir: (path: FsPath) => vfs.readdir(pathOf(path)),
  unlink: (path: FsPath) => vfs.unlink(pathOf(path)),
});

export interface FsShim {
  readFileSync(path: FsPath, encoding?: "utf8"): Buffer | string;
  writeFileSync(path: FsPath, data: string | Uint8Array): void;
  existsSync(path: FsPath): boolean;
  mkdirSync(path: FsPath, options?: { recursive?: boolean }): void;
  readdirSync(path: FsPath): string[];
  statSync(path: FsPath): StatsShim;
  /**
   * Stat several paths at once: one entry per path, `null` where it does not exist.
   *
   * Always present on the shim so callers have one shape to call, even when the substrate underneath cannot batch: the
   * fallback is the same loop over `statSync`, which is what the caller would have written anyway.
   */
  statManySync(paths: readonly FsPath[]): readonly (StatsShim | null)[];
  unlinkSync(path: FsPath): void;
  rmdirSync(path: FsPath): void;
  renameSync(from: FsPath, to: FsPath): void;
  /**
   * `fs.watch`. The listener may be passed second, as in Node, and the returned handle is the FSWatcher-shaped object.
   *
   * `encoding` is refused rather than ignored: Node uses it to decide whether filenames arrive as strings or Buffers, and
   * quietly returning strings to a program that asked for Buffers is the kind of wrongness that takes a day to find.
   */
  watch(
    path: string,
    listenerOrOptions?: WatchListener | WatchOptions,
    maybeListener?: WatchListener,
  ): WatchHandlePort;
  /**
   * Callback `readdir`, `stat` and `lstat`.
   *
   * These exist because a real dependency asks for them BY NAME and promisifies them: vite's bundled chokidar does
   * `const readdir = promisify(fs.readdir)` at module scope, so an absent member is not a gap a program can route around, it is a boot failure.
   * Node's signatures are (path[, options], callback) for readdir and (path, callback) for the two stats.
   */
  readdir(path: FsPath, optionsOrCallback?: object | string | ReaddirCallback, maybeCallback?: ReaddirCallback): void;
  /**
   * `open` and `close`, callback and sync forms.
   *
   * Implemented over the VFS with a real per-shim table, so the descriptor is a number a caller can hold and close, exactly as Node's is.
   * `read`/`write` through a descriptor are NOT implemented: they refuse with a named error naming the fd and its path, because this VFS has
   * whole-file reads and writes and inventing positional semantics on top would be a guess dressed as an answer.
   */
  open(path: FsPath, flags: string | number, callback: (error: unknown, fd?: FileDescriptor) => void): void;
  openSync(path: FsPath, flags: string | number): FileDescriptor;
  close(fd: FileDescriptor, callback: (error: unknown) => void): void;
  closeSync(fd: FileDescriptor): void;
  /** Present, and refusing by name: this VFS reads and writes whole files, so positional descriptor I/O has no faithful answer here. */
  readSync(fd: FileDescriptor): never;
  /** Present for the same reason as `readSync`. */
  writeSync(fd: FileDescriptor): never;
  stat(path: FsPath, callback: StatCallback): void;
  /** No symlinks exist in this VFS, so `lstat` is `stat`. Documented rather than silently aliased. */
  lstat(path: FsPath, callback: StatCallback): void;
  /**
   * `realpathSync`, with Node's `.native` property hanging off it.
   *
   * Nothing in this VFS is a symbolic link, so there is no chain for a "native" variant to follow differently: `.native` is the same
   * implementation. It has to EXIST, though, because vite reads `require('fs').realpathSync.native` and dies on the property being undefined.
   */
  realpathSync: RealpathSync;
  /** Node's callback form, `(path[, options], callback)`. */
  realpath: RealpathCallback;
  promises: {
    readFile(path: string, encoding?: "utf8"): Promise<Buffer | string>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<StatsShim>;
    /** No symlinks exist in this VFS, so `lstat` is `stat`. Documented rather than silently aliased. */
    lstat(path: string): Promise<StatsShim>;
    /** Normalises and confirms existence. There is nothing to resolve, because no path is a link. */
    realpath(path: string): Promise<string>;
    /** Existence only: Node's mode argument is accepted and ignored, because there are no permission bits here. */
    access(path: string): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    watch(path: string, options?: WatchOptions): WatchAsyncIterator;
  };
}

/**
 * An open file descriptor.
 *
 * Real: `open` and `close` are implemented over the VFS with a small table, because a caller that opens a file to prove it can (which is what
 * vite's bundled watcher does, in Node's own Windows EPERM workaround) needs a descriptor that round-trips through `close`. Reading and writing
 * THROUGH a descriptor is not implemented, and refuses by name rather than pretending: see the fd table below.
 */
export type FileDescriptor = number;

/** Callback shapes for the three promisified members: `(error) | (error, value)`. */
export type ReaddirCallback = (error: unknown, entries?: string[]) => void;
export type StatCallback = (error: unknown, stats?: StatsShim) => void;

/** The synchronous realpath, plus the `.native` property Node hangs off it (and that vite reads as `realpathSync.native`). */
export type RealpathSync = ((path: FsPath) => string) & { native: (path: FsPath) => string };

/** Node's callback form: (path[, options], callback). */
export type RealpathCallback = (
  path: FsPath,
  optionsOrCallback?: object | ((error: unknown, resolved?: string) => void),
  maybeCallback?: (error: unknown, resolved?: string) => void,
) => void;

export interface WatchOptions {
  readonly recursive?: boolean;
}

export type WatchListener = (eventType: "change" | "rename", filename: string) => void;

/** Absolute-path-only core. Everything outside this module goes through the cwd-aware wrapper below. */
/**
 * `fs.watch` for an absolute path.
 *
 * A named helper rather than an object-literal method because BOTH `fs.watch` and `fs.promises.watch` need it, and `this`
 * inside the `promises` literal is the promises object, not the shim. The type checker caught that immediately; had it been a
 * loosely typed property it would have been a runtime TypeError on the first call.
 */
const absoluteWatch = (
  watches: WatchSourcePort | undefined,
  path: string,
  listenerOrOptions?: WatchListener | WatchOptions,
  maybeListener?: WatchListener,
): WatchHandlePort => {
    if (watches === undefined) {
      // A typed refusal, not a silent no-op: a program that watches and never hears anything cannot tell that apart from a
      // file that never changed.
      throw Object.assign(new Error("fs.watch is not available in this runtime"), { code: "ENOSYS" });
    }
    const options: WatchOptions = typeof listenerOrOptions === "function" ? {} : (listenerOrOptions ?? {});
    const listener = typeof listenerOrOptions === "function" ? listenerOrOptions : maybeListener;
    if ((options as { encoding?: unknown }).encoding !== undefined) {
      throw Object.assign(new Error("fs.watch does not support the encoding option in this runtime"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    const handle = watches.watch(pathOf(path), options.recursive === true ? { recursive: true } : {});
    if (listener !== undefined) {
      handle.on("change", listener as (...args: never[]) => void);
      handle.on("rename", listener as (...args: never[]) => void);
    }
    return handle;
};

const createAbsoluteFsShim = (
  port: FileSystemPort,
  watches?: WatchSourcePort,
): // The absolute layer is not the object a program receives, so it does not carry Node's `.native` property: the wrapper below adds that,
// because `.native` is a property of the function the public `fs` exports and nowhere else.
Omit<FsShim, "realpathSync"> & { realpathSync: (path: FsPath) => string } => {

  /**
   * The open-descriptor table.
   *
   * A descriptor is an integer, as in Node, because that is what callers put on the wire and in logs. The number counts up from 3 (Node's 0/1/2
   * are the standard streams) and a closed descriptor is REUSED never, so a program holding a stale fd gets EBADF with the number it asked
   * about rather than a different file.
   */
  const openFiles = new Map<FileDescriptor, { path: string; flags: string }>();
  let nextDescriptor = 3;

  /** Node's string flags, reduced to the facts this VFS can act on: does it read, does it write, does it create, does it truncate. */
  const parseOpenFlags = (flags: string | number): string => {
    if (typeof flags === "number") {
      throw Object.assign(
        new Error(`fs.open numeric flags are not implemented in this runtime: pass a string flag such as "r" or "w"`),
        { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
      );
    }
    const known = ["r", "r+", "w", "w+", "a", "a+", "wx", "wx+", "ax", "ax+", "rs", "rs+"];
    if (!known.includes(flags)) {
      throw Object.assign(new Error(`Unknown file open flag: ${flags}`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    return flags;
  };

  /** Opens a descriptor against the VFS, applying the create/truncate side effects immediately, as Node does. */
  const openDescriptor = (path: string, flagsInput: string | number): FileDescriptor => {
    const flags = parseOpenFlags(flagsInput);
    const writes = flags.includes("w") || flags.includes("a") || flags.includes("+");
    const exclusive = flags.includes("x");
    const mustExist = !flags.includes("w") && !flags.includes("a");
    let exists = true;
    try {
      vfs.statSync(path);
    } catch {
      exists = false;
    }
    if (mustExist && !exists) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
        errno: -2,
        syscall: "open",
        path,
      });
    }
    if (exclusive && exists) {
      throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
        code: "EEXIST",
        errno: -17,
        syscall: "open",
        path,
      });
    }
    if (writes && !exists) vfs.writeFileSync(path, new Uint8Array(0));
    // Truncation is a real side effect of "w" and "w+", and applying it at open is what makes the descriptor mean the same thing it does in Node.
    if (flags.includes("w")) vfs.writeFileSync(path, new Uint8Array(0));
    const fd = nextDescriptor;
    nextDescriptor += 1;
    openFiles.set(fd, { path, flags });
    return fd;
  };

  /** Reads through a descriptor. Refused, and the refusal is the point: there is no positional read here to be faithful with. */
  const refuseDescriptorIo = (operation: string, fd: FileDescriptor): never => {
    const entry = openFiles.get(fd);
    throw Object.assign(
      new Error(
        `fs.${operation} on a file descriptor is not implemented in this runtime (fd ${fd}${entry === undefined ? "" : ` for '${entry.path}'`}): read and write whole files with readFile/writeFile`,
      ),
      { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
    );
  };
  const vfs = pathAccepting(port);
  return {
  watch: (path, listenerOrOptions, maybeListener) =>
    absoluteWatch(watches, path, listenerOrOptions, maybeListener),

  readFileSync(path, encoding) {
    try {
      const out = encoding === "utf8" ? vfs.readFileSync(path, "utf8") : vfs.readFileSync(path);
      return typeof out === "string" ? out : asBuffer(out);
    } catch (error) {
      throw toNodeError(error, "open", path);
    }
  },

  writeFileSync(path, data) {
    try {
      vfs.writeFileSync(path, data);
    } catch (error) {
      throw toNodeError(error, "open", path);
    }
  },

  existsSync(path) {
    // Node's existsSync is the one API that returns false instead of throwing.
    try {
      vfs.statSync(path);
      return true;
    } catch {
      return false;
    }
  },

  mkdirSync(path, options) {
    try {
      vfs.mkdirSync(path, options ?? {});
    } catch (error) {
      throw toNodeError(error, "mkdir", path);
    }
  },

  readdirSync(path) {
    try {
      return vfs.readdirSync(path);
    } catch (error) {
      throw toNodeError(error, "scandir", path);
    }
  },

  open(path: FsPath, flags: string | number, callback: (error: unknown, fd?: FileDescriptor) => void) {
    try {
      callback(null, openDescriptor(pathOf(path), flags));
    } catch (error) {
      callback(error);
    }
  },

  openSync(path: FsPath, flags: string | number) {
    return openDescriptor(pathOf(path), flags);
  },

  close(fd: FileDescriptor, callback: (error: unknown) => void) {
    try {
      this.closeSync(fd);
      callback(null);
    } catch (error) {
      callback(error);
    }
  },

  closeSync(fd: FileDescriptor) {
    if (!openFiles.has(fd)) {
      throw Object.assign(new Error(`EBADF: bad file descriptor, close`), {
        code: "EBADF",
        errno: -9,
        syscall: "close",
      });
    }
    openFiles.delete(fd);
  },

  /** Present so a program that reads through a descriptor learns the truth by name instead of reading a wrong answer. */
  readSync(fd: FileDescriptor): never {
    return refuseDescriptorIo("readSync", fd);
  },

  /** Present for the same reason as `readSync`. */
  writeSync(fd: FileDescriptor): never {
    return refuseDescriptorIo("writeSync", fd);
  },

  /** Callback `readdir`. The error, when there is one, is the same mapped error the sync form throws: one source of truth for the code. */
  readdir(path: FsPath, optionsOrCallback?: object | string | ReaddirCallback, maybeCallback?: ReaddirCallback) {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const resolvedPath = pathOf(path);
    let entries: string[];
    try {
      entries = vfs.readdirSync(resolvedPath);
    } catch (error) {
      callback?.(toNodeError(error, "scandir", resolvedPath));
      return;
    }
    callback?.(null, entries);
  },

  stat(path: FsPath, callback: StatCallback) {
    const resolvedPath = pathOf(path);
    try {
      callback(null, asStats(vfs.statSync(resolvedPath)));
    } catch (error) {
      callback(toNodeError(error, "stat", resolvedPath));
    }
  },

  /** `lstat` is `stat`, as above, because nothing in this VFS is a symbolic link. */
  lstat(path: FsPath, callback: StatCallback) {
    const resolvedPath = pathOf(path);
    try {
      callback(null, asStats(vfs.statSync(resolvedPath)));
    } catch (error) {
      callback(toNodeError(error, "lstat", resolvedPath));
    }
  },

  statSync(path) {
    try {
      return asStats(vfs.statSync(path));
    } catch (error) {
      throw toNodeError(error, "stat", path);
    }
  },

  /**
   * `realpathSync`: existence and a normalised path, and nothing more, because nothing in this VFS is a symbolic link.
   *
   * A missing path still throws ENOENT with `syscall: "realpath"`, which is what callers branch on. The `.native` property is assigned in the
   * path-rewriting layer below, where the shape is built, because Node exposes `realpathSync.native` as a property OF this function.
   */
  realpathSync(path: FsPath) {
    const resolvedPath = pathOf(path);
    try {
      vfs.statSync(resolvedPath);
    } catch (error) {
      throw toNodeError(error, "realpath", resolvedPath);
    }
    return nodePath.normalize(resolvedPath);
  },

  /** The callback form, which takes the same options object Node accepts and then calls back. */
  realpath(
    path: FsPath,
    optionsOrCallback?: object | ((error: unknown, resolved?: string) => void),
    maybeCallback?: (error: unknown, resolved?: string) => void,
  ) {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const resolvedPath = pathOf(path);
    try {
      vfs.statSync(resolvedPath);
      callback?.(null, nodePath.normalize(resolvedPath));
    } catch (error) {
      // The same mapped error the sync form throws, so both shapes of this call report the same code and syscall.
      callback?.(toNodeError(error, "realpath", resolvedPath));
    }
  },

  statManySync(paths) {
    const many = vfs.statManySync;
    if (many !== undefined) return many.call(vfs, paths).map((stats) => (stats === null ? null : asStats(stats)));
    return paths.map((path) => {
      try {
        return asStats(vfs.statSync(path));
      } catch {
        return null;
      }
    });
  },

  unlinkSync(path) {
    try {
      vfs.unlinkSync(path);
    } catch (error) {
      throw toNodeError(error, "unlink", path);
    }
  },

  rmdirSync(path) {
    try {
      vfs.rmdirSync(path);
    } catch (error) {
      throw toNodeError(error, "rmdir", path);
    }
  },

  renameSync(from, to) {
    try {
      vfs.renameSync(from, to);
    } catch (error) {
      throw toNodeError(error, "rename", from);
    }
  },

  promises: {
    watch(path, watchOptions) {
      return toWatchAsyncIterator(absoluteWatch(watches, path, watchOptions));
    },
    async readFile(path, encoding) {
      try {
        const out = encoding === "utf8" ? await vfs.readFile(path, "utf8") : await vfs.readFile(path);
        return typeof out === "string" ? out : asBuffer(out);
      } catch (error) {
        throw toNodeError(error, "open", path);
      }
    },
    async writeFile(path, data) {
      try {
        await vfs.writeFile(path, data);
      } catch (error) {
        throw toNodeError(error, "open", path);
      }
    },
    async mkdir(path, options) {
      try {
        await vfs.mkdir(path, options ?? {});
      } catch (error) {
        throw toNodeError(error, "mkdir", path);
      }
    },
    async readdir(path) {
      try {
        return await vfs.readdir(path);
      } catch (error) {
        throw toNodeError(error, "scandir", path);
      }
    },
    async unlink(path) {
      try {
        await vfs.unlink(path);
      } catch (error) {
        throw toNodeError(error, "unlink", path);
      }
    },
    async stat(path) {
      // The port's promise forms resolve from the sync call, and its doc says so: in a Worker the sync call already blocks, so
      // there is nothing to gain from a second implementation that could drift from this one.
      try {
        return asStats(vfs.statSync(path));
      } catch (error) {
        throw toNodeError(error, "stat", path);
      }
    },
    async lstat(path) {
      return this.stat(path);
    },
    async realpath(path) {
      // Existence and a normalised path are all this VFS can honestly offer: nothing here is a symbolic link, so there is no chain to
      // follow. A missing path still fails the way Node fails, because callers branch on that.
      await this.stat(path);
      return path;
    },
    async access(path) {
      await this.stat(path);
    },
    async rm(path, rmOptions) {
      const recursive = rmOptions?.recursive === true;
      const force = rmOptions?.force === true;
      try {
        // `kind` is the port's word for it; `isDirectory()` is Node's, and it exists only on the shim's Stats.
        const stats = vfs.statSync(path);
        if (stats.kind === "dir") {
          if (!recursive) throw toNodeError(new Error("EISDIR"), "rm", path);
          for (const entry of vfs.readdirSync(path)) {
            await this.rm(`${path === "/" ? "" : path}/${entry}`, { recursive: true, force: true });
          }
          vfs.rmdirSync(path);
          return;
        }
        vfs.unlinkSync(path);
      } catch (error) {
        // `force: true` is Node's "missing is fine", and vite passes it for cache directories that may never have existed.
        if (force && (error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
    },
  },
  };
};

/**
 * The shim user code sees: Node resolves a relative path against the process working directory, and the VFS only knows
 * absolute ones. Without this, `fs.readFileSync("sample.txt")` from a script started in /app looks for /sample.txt, and
 * every ordinary CLI fails with ENOENT while the file sits exactly where the author put it.
 *
 * Error mapping lives in the absolute shim, so this layer only rewrites paths and cannot change how failures surface.
 */
export const createFsShim = (
  vfs: FileSystemPort,
  options: { readonly cwd?: string; readonly watches?: WatchSourcePort } = {},
): FsShim => {
  const cwd = options.cwd ?? "/";
  const at = (value: FsPath): string => {
    // A URL is absolute by construction, so it is converted before the leading-slash test rather than resolved against cwd.
    const path = pathOf(value);
    return path.startsWith("/") ? path : nodePath.resolve(cwd, path);
  };
  const inner = createAbsoluteFsShim(vfs, options.watches);

  const realpathSync = Object.assign((path: FsPath) => inner.realpathSync(at(path)), {
    native: (path: FsPath) => inner.realpathSync(at(path)),
  });

  return {
    realpathSync,
    // Forwarded uncast, in both shapes Node accepts: `promisify(fs.realpath)` — which is how vite's bundled watcher calls it — passes the
    // callback as the SECOND argument, so both positions have to survive this wrapper. The cast that used to be here was only a type-level
    // lie (the value still arrived at runtime and the call DID work), but it described the wrapper as taking one shape while it accepted two,
    // which is how a real regression would have been introduced without a test noticing.
    realpath: (path, optionsOrCallback, maybeCallback) => inner.realpath(at(path), optionsOrCallback, maybeCallback),
    readFileSync: (path, encoding) => inner.readFileSync(at(path), encoding),
    writeFileSync: (path, data) => inner.writeFileSync(at(path), data),
    existsSync: (path) => inner.existsSync(at(path)),
    mkdirSync: (path, mkdirOptions) => inner.mkdirSync(at(path), mkdirOptions),
    readdirSync: (path) => inner.readdirSync(at(path)),
    // Every path is rewritten before the batch is sent, so the caller batches relative paths and the port sees absolute ones.
    statManySync: (paths) => inner.statManySync(paths.map(at)),
    statSync: (path) => inner.statSync(at(path)),
    readdir: (path, optionsOrCallback, maybeCallback) =>
      inner.readdir(at(path), optionsOrCallback as object | string | undefined, maybeCallback),
    open: (path, flags, callback) => inner.open(at(path), flags, callback),
    openSync: (path, flags) => inner.openSync(at(path), flags),
    close: (fd, callback) => inner.close(fd, callback),
    closeSync: (fd) => inner.closeSync(fd),
    readSync: (fd) => inner.readSync(fd),
    writeSync: (fd) => inner.writeSync(fd),
    stat: (path, callback) => inner.stat(at(path), callback),
    lstat: (path, callback) => inner.lstat(at(path), callback),
    unlinkSync: (path) => inner.unlinkSync(at(path)),
    rmdirSync: (path) => inner.rmdirSync(at(path)),
    renameSync: (from, to) => inner.renameSync(at(from), at(to)),
    watch: (path, listenerOrOptions, maybeListener) =>
      inner.watch(at(path), listenerOrOptions, maybeListener),
    promises: {
      watch: (path, watchOptions) => inner.promises.watch(at(path), watchOptions),
      readFile: (path, encoding) => inner.promises.readFile(at(path), encoding),
      writeFile: (path, data) => inner.promises.writeFile(at(path), data),
      mkdir: (path, mkdirOptions) => inner.promises.mkdir(at(path), mkdirOptions),
      readdir: (path) => inner.promises.readdir(at(path)),
      unlink: (path) => inner.promises.unlink(at(path)),
      stat: (path) => inner.promises.stat(at(path)),
      lstat: (path) => inner.promises.lstat(at(path)),
      realpath: (path) => inner.promises.realpath(at(path)),
      access: (path) => inner.promises.access(at(path)),
      rm: (path, rmOptions) => inner.promises.rm(at(path), rmOptions),
    },
  };
};
