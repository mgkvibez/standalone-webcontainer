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

const createAbsoluteFsShim = (port: FileSystemPort, watches?: WatchSourcePort): FsShim => {
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

  statSync(path) {
    try {
      return asStats(vfs.statSync(path));
    } catch (error) {
      throw toNodeError(error, "stat", path);
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

  return {
    readFileSync: (path, encoding) => inner.readFileSync(at(path), encoding),
    writeFileSync: (path, data) => inner.writeFileSync(at(path), data),
    existsSync: (path) => inner.existsSync(at(path)),
    mkdirSync: (path, mkdirOptions) => inner.mkdirSync(at(path), mkdirOptions),
    readdirSync: (path) => inner.readdirSync(at(path)),
    // Every path is rewritten before the batch is sent, so the caller batches relative paths and the port sees absolute ones.
    statManySync: (paths) => inner.statManySync(paths.map(at)),
    statSync: (path) => inner.statSync(at(path)),
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
