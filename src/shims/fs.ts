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
import { FileSystem } from "../vfs/index.js";
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
  promises: {
    readFile(path: string, encoding?: "utf8"): Promise<Buffer | string>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
  };
}

export const createFsShim = (vfs: FileSystem): FsShim => ({
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
