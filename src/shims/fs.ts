import type { FileSystemPort, WatchSourcePort } from "../vfs/port.js";
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

const toNodeError = (error: unknown, syscall: string, path: string): NodeFsError => {
  if (error instanceof VFSError) {
    const code = CODE_MAP[error.code] ?? "EIO";
    const wrapped = new Error(`${code}: ${syscall} '${path}'`) as NodeFsError;
    wrapped.code = code;
    wrapped.errno = ERRNO[code] ?? -1;
    wrapped.syscall = syscall;
    wrapped.path = path;
    return wrapped;
  }
  // Anything that is not a VFS error is a bug in this shim, not user error: do
  // not masquerade it as a filesystem condition.
  throw error;
};

const asBuffer = (data: string | Uint8Array): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

export interface FsShim {
  readFileSync(path: string, encoding?: "utf8"): Buffer | string;
  writeFileSync(path: string, data: string | Uint8Array): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  statSync(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
  };
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  renameSync(from: string, to: string): void;
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
    const handle = watches.watch(path, options.recursive === true ? { recursive: true } : {});
    if (listener !== undefined) {
      handle.on("change", listener as (...args: never[]) => void);
      handle.on("rename", listener as (...args: never[]) => void);
    }
    return handle;
};

const createAbsoluteFsShim = (vfs: FileSystemPort, watches?: WatchSourcePort): FsShim => ({
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
      const stats = vfs.statSync(path);
      return {
        isFile: () => stats.kind === "file",
        isDirectory: () => stats.kind === "dir",
        size: stats.size,
        mtimeMs: stats.modifiedAt,
        birthtimeMs: stats.createdAt,
      };
    } catch (error) {
      throw toNodeError(error, "stat", path);
    }
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
  },
});

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
  const at = (path: string): string => (path.startsWith("/") ? path : nodePath.resolve(cwd, path));
  const inner = createAbsoluteFsShim(vfs, options.watches);

  return {
    readFileSync: (path, encoding) => inner.readFileSync(at(path), encoding),
    writeFileSync: (path, data) => inner.writeFileSync(at(path), data),
    existsSync: (path) => inner.existsSync(at(path)),
    mkdirSync: (path, mkdirOptions) => inner.mkdirSync(at(path), mkdirOptions),
    readdirSync: (path) => inner.readdirSync(at(path)),
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
    },
  };
};
