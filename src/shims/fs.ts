/**
 * fs shim (ADR-0003 Decision 1 + expert rulings, Oct 26).
 *
 * WRAP, NEVER EXTEND: this module delegates every async operation to the
 * ADR-0002 VFS instance owned by the worker. The VFS is the single owner
 * of file state; this shim only translates Node-shaped calls. It mutates
 * no globals and touches no DOM APIs.
 *
 * SYNC SURFACE (expert ruling "both, phased"): every synchronous method
 * throws SyncNotSupportedError (code ESYNCNOTSUPPORTED) synchronously.
 * Across the typed envelope (ADR-0003 Decision 2) the throw is captured
 * by the kernel's error serialization and rehydrated caller-side as a
 * typed error carrying the same code. SAB+Atomics parking is deferred
 * to a future phase, worker-side only, behind a feature flag.
 */
import { VFSIsADirectoryError } from "../vfs/index.js";
import type { FileSystem, Stats as VfsStats } from "../vfs/index.js";

/**
 * Node-API-shaped error surfaced by the shim where the oracle's Node
 * semantics differ from the VFS's POSIX layer (code + Node message).
 */
export class NodeApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NodeApiError";
  }
}

/** Typed error for the phased sync-fs contract (expert ruling, ADR-0003). */
export class SyncNotSupportedError extends Error {
  readonly code = "ESYNCNOTSUPPORTED";
  constructor(op: string) {
    super(
      `${op} is not supported: the browser runtime is async-only in this ` +
        `phase (ADR-0003 phased sync ruling); use the promise API instead.`,
    );
    this.name = "SyncNotSupportedError";
  }
}

/** Node-style shape of the VFS stat result (API shape per memfs oracle). */
export interface ShimStats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

type ReadFileEncoding = "utf8" | { readonly encoding: "utf8" } | undefined;

function wrapStats(stats: VfsStats): ShimStats {
  return {
    size: stats.size,
    mtimeMs: stats.modifiedAt,
    birthtimeMs: stats.createdAt,
    isFile: () => stats.kind === "file",
    isDirectory: () => stats.kind === "dir",
    // The VFS has no device, symlink, or FIFO node kinds — these are
    // structural constants, not guesses about underlying state.
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function normalizeEncoding(options: ReadFileEncoding): "utf8" | undefined {
  if (options === undefined) return undefined;
  if (options === "utf8") return "utf8";
  if (options.encoding === "utf8") return "utf8";
  // The VFS accepts exactly one text encoding (EINVAL below is what it
  // raises for others); report that faithfully rather than widening the
  // contract the conformance oracle has not verified.
  throw new Error(
    "readFile: only the 'utf8' encoding is supported in this phase",
  );
}

/** Node-shaped `fs` facade over the single-owner ADR-0002 VFS. */
export class FsShim {
  readonly #vfs: FileSystem;

  constructor(vfs: FileSystem) {
    this.#vfs = vfs;
  }

  async readFile(
    path: string,
    options?: ReadFileEncoding,
  ): Promise<string | Uint8Array> {
    return this.#vfs.readFile(path, normalizeEncoding(options));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.#vfs.writeFile(path, data);
  }

  async mkdir(
    path: string,
    options: { readonly recursive?: boolean } = {},
  ): Promise<void> {
    return this.#vfs.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.#vfs.readdir(path);
  }

  async stat(path: string): Promise<ShimStats> {
    return wrapStats(await this.#vfs.stat(path));
  }

  async unlink(path: string): Promise<void> {
    try {
      return await this.#vfs.unlink(path);
    } catch (error) {
      // ORACLE-VERIFIED (memfs, fs-conformance.test.ts): Node's unlink
      // on a directory reports EPERM, while the ADR-0002 VFS reports
      // POSIX/Linux EISDIR at its own layer. The shim is the Node
      // conformance surface, so it remaps only this case; every other
      // code (ENOENT, ENOTDIR) passes through untouched.
      if (error instanceof VFSIsADirectoryError) {
        throw new NodeApiError(
          "EPERM",
          `EPERM: operation not permitted, unlink '${path}'`,
        );
      }
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    return this.#vfs.rename(from, to);
  }

  async rmdir(path: string): Promise<void> {
    return this.#vfs.rmdir(path);
  }

  // ---- Sync surface: typed ESYNCNOTSUPPORTED, phased ruling ----

  readFileSync(path: string, options?: ReadFileEncoding): string | Uint8Array {
    void path;
    void options;
    throw new SyncNotSupportedError("fs.readFileSync");
  }

  writeFileSync(path: string, data: string | Uint8Array): void {
    void path;
    void data;
    throw new SyncNotSupportedError("fs.writeFileSync");
  }

  mkdirSync(path: string, options?: { readonly recursive?: boolean }): void {
    void path;
    void options;
    throw new SyncNotSupportedError("fs.mkdirSync");
  }

  readdirSync(path: string): string[] {
    void path;
    throw new SyncNotSupportedError("fs.readdirSync");
  }

  statSync(path: string): ShimStats {
    void path;
    throw new SyncNotSupportedError("fs.statSync");
  }

  unlinkSync(path: string): void {
    void path;
    throw new SyncNotSupportedError("fs.unlinkSync");
  }

  renameSync(from: string, to: string): void {
    void from;
    void to;
    throw new SyncNotSupportedError("fs.renameSync");
  }

  rmdirSync(path: string): void {
    void path;
    throw new SyncNotSupportedError("fs.rmdirSync");
  }
}

export function createFsShim(vfs: FileSystem): FsShim {
  return new FsShim(vfs);
}
