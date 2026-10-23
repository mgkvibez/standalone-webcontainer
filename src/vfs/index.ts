import { normalizeVfsPath } from "./path.js";
import {
  VFSIsADirectoryError,
  VFSInvalidEncodingError,
  VFSInvalidPathError,
  VFSNotEmptyError,
  VFSNotFoundError,
  VFSNotADirectoryError,
  VFSPathExistsError,
  VFSQuotaExceededError,
} from "./errors.js";
import type { DirNode, FileNode, Node, Stats } from "./types.js";

export { normalizeVfsPath } from "./path.js";
export {
  VFSInvalidEncodingError,
  VFSInvalidPathError,
  VFSIsADirectoryError,
  VFSNotEmptyError,
  VFSNotFoundError,
  VFSNotADirectoryError,
  VFSPathExistsError,
  VFSQuotaExceededError,
  VFSError,
} from "./errors.js";
export type { VfsErrorCode } from "./errors.js";
export type { DirNode, FileNode, Node, Stats } from "./types.js";

/**
 * Per-file size cap (ADR-0002 #4): 50 MiB by default. Exceeding it fails
 * with a typed `VFSQuotaExceededError` instead of an OOM.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Whole-VFS content cap (ADR-0002 #4). Before it produces a failure, LRU
 * eviction reclaims space from other files. The constructor guarantees
 * `maxFileSize <= maxTotalBytes`, which makes eviction always sufficient:
 * after evicting every other file there is room for any legal single write.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** Chunk size for file storage: 1 MiB keeps per-write allocations small. */
const CHUNK_SIZE = 1024 * 1024;

// WHY module-level codecs: both are stateless and free of DOM references;
// sharing them avoids per-call allocation and keeps this module safe inside
// a Dedicated Web Worker (ADR-0002 #2, #6).
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FileSystemOptions {
  /** Per-file cap in bytes. Defaults to `MAX_FILE_SIZE`. */
  readonly maxFileSize?: number;
  /** Whole-VFS cap in bytes. Defaults to `DEFAULT_MAX_TOTAL_BYTES`. */
  readonly maxTotalBytes?: number;
}

function isFileNode(node: Node | undefined): node is FileNode {
  return node?.kind === "file";
}

/** Parent path of a normalized absolute path; `undefined` for `/`. */
function parentOf(p: string): string | undefined {
  if (p === "/") {
    return undefined;
  }
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/**
 * In-memory POSIX-style file system, implemented strictly per ADR-0002.
 *
 * - Flat `Map<string, Node>` keyed by normalized absolute path; directories
 *   are derived on demand from the keys below them (#1).
 * - Async-first: every public method is `async` and yields once on entry.
 *   The body after the yield runs atomically, so concurrent calls interleave
 *   only at entry and the internal size/LRU bookkeeping never sees torn
 *   state (#2). Blocking-style work in a worker freezes only the worker.
 * - In-memory only: no persistence in Phase 1 (#3).
 * - Chunked `Uint8Array` storage, per-file cap, whole-VFS cap with LRU
 *   eviction, typed quota error (#4).
 * - Zero DOM references: instantiable and runnable inside the Dedicated Web
 *   Worker that solely owns it (#2, #6). The main thread never holds it.
 */
export class FileSystem {
  readonly maxFileSize: number;
  readonly maxTotalBytes: number;

  readonly #nodes = new Map<string, Node>();
  #totalBytes = 0;
  #accessCounter = 0;

  constructor(options: FileSystemOptions = {}) {
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (this.maxFileSize <= 0 || this.maxTotalBytes <= 0) {
      throw new RangeError("maxFileSize and maxTotalBytes must be positive");
    }
    // WHY: if one file could exceed the whole-VFS cap, eviction could never
    // free enough space and the "evict, then write" guarantee would be
    // unsound. Rejecting the configuration keeps the invariant checkable.
    if (this.maxFileSize > this.maxTotalBytes) {
      throw new RangeError("maxFileSize must not exceed maxTotalBytes");
    }
  }

  /** Write `data` to `path`, creating the file and derived parents. */
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await Promise.resolve(); // async-first contract (ADR-0002 #2)
    const p = normalizeVfsPath(path);
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new TypeError(`writeFile: data must be a string or Uint8Array, got ${typeof data}`);
    }
    if (p === "/") {
      throw new VFSIsADirectoryError(p);
    }
    this.#assertNoFileAncestors(p);
    const existing = this.#nodes.get(p);
    if (existing?.kind === "dir") {
      throw new VFSIsADirectoryError(p);
    }
    // Strings are encoded once, up front, so the size cap is checked against
    // real UTF-8 byte length, not character count.
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.byteLength > this.maxFileSize) {
      throw new VFSQuotaExceededError(p, bytes.byteLength, this.maxFileSize);
    }
    // WHY slice (which copies) per chunk: the VFS must own its bytes. A
    // caller mutating a buffer it handed to writeFile must not corrupt
    // stored contents.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
      chunks.push(bytes.slice(i, i + CHUNK_SIZE));
    }
    const needed = bytes.byteLength - (isFileNode(existing) ? existing.size : 0);
    this.#evictFor(needed, p);
    if (isFileNode(existing)) {
      this.#totalBytes -= existing.size;
    }
    const now = Date.now();
    this.#nodes.set(p, {
      kind: "file",
      chunks,
      size: bytes.byteLength,
      // Birth time survives overwrites, like Node's stat.birthtime.
      createdAt: isFileNode(existing) ? existing.createdAt : now,
      modifiedAt: now,
      lastAccessCounter: ++this.#accessCounter,
    });
    this.#totalBytes += bytes.byteLength;
  }

  /** Read `path`. Returns `Uint8Array`, or `string` when encoding is "utf8". */
  async readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string> {
    await Promise.resolve();
    const p = normalizeVfsPath(path);
    if (encoding !== undefined && encoding !== "utf8") {
      // Runtime guard: JS callers bypassing the TS types must not reach
      // TextDecoder with junk. Phase 1 supports utf8 only.
      throw new VFSInvalidEncodingError(p, encoding);
    }
    const node = this.#fileAt(p);
    // WHY a fresh copy per read: chunk storage is private to the VFS;
    // handing out a live view would let callers corrupt it (worker safety).
    const out = new Uint8Array(node.size);
    let offset = 0;
    for (const chunk of node.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return encoding === "utf8" ? decoder.decode(out) : out;
  }

  /** Create a directory. Node semantics: `recursive` is `mkdir -p`. */
  async mkdir(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    await Promise.resolve();
    const p = normalizeVfsPath(path);
    const recursive = options.recursive === true;
    this.#assertNoFileAncestors(p);
    const existing = this.#nodes.get(p);
    if (existing?.kind === "file") {
      throw new VFSPathExistsError(p);
    }
    if (existing?.kind === "dir" || this.#existsAsDir(p)) {
      // Node semantics: recursive mkdir over an existing directory is a
      // silent no-op; non-recursive mkdir on an existing directory is EEXIST.
      if (recursive) {
        return;
      }
      throw new VFSPathExistsError(p);
    }
    const parent = parentOf(p);
    if (parent !== undefined && !this.#existsAsDir(parent)) {
      if (!recursive) {
        // Node semantics: without recursive, a missing parent is ENOENT.
        throw new VFSNotFoundError(parent);
      }
      // WHY materialize parents on recursive mkdir: an explicit entry keeps
      // stat()/readdir() of the parent correct even if its children are
      // later moved away, and mirrors what `mkdir -p` actually wrote.
      const now = Date.now();
      let cur = "";
      for (const segment of parent.split("/").filter((s) => s !== "")) {
        cur = `${cur}/${segment}`;
        if (!this.#nodes.has(cur)) {
          this.#nodes.set(cur, { kind: "dir", createdAt: now, modifiedAt: now });
        }
      }
    }
    const now = Date.now();
    this.#nodes.set(p, { kind: "dir", createdAt: now, modifiedAt: now } satisfies DirNode);
  }

  /** List direct child names of the directory at `path`, sorted. */
  async readdir(path: string): Promise<string[]> {
    await Promise.resolve();
    const p = normalizeVfsPath(path);
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node?.kind === "file") {
      throw new VFSNotADirectoryError(p);
    }
    if (node === undefined && !this.#existsAsDir(p)) {
      throw new VFSNotFoundError(p);
    }
    const prefix = this.#prefixOf(p);
    const names = new Set<string>();
    for (const key of this.#nodes.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      if (rest.length === 0) {
        continue;
      }
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    // Sorted for deterministic comparisons in tests and later shims.
    return [...names].sort();
  }

  /** Stat the file or directory at `path`. */
  async stat(path: string): Promise<Stats> {
    await Promise.resolve();
    const p = normalizeVfsPath(path);
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node?.kind === "file") {
      node.lastAccessCounter = ++this.#accessCounter; // LRU touch
      return { kind: "file", size: node.size, createdAt: node.createdAt, modifiedAt: node.modifiedAt };
    }
    if (node?.kind === "dir") {
      return { kind: "dir", size: 0, createdAt: node.createdAt, modifiedAt: node.modifiedAt };
    }
    if (p === "/" || this.#existsAsDir(p)) {
      // Derived directory (ADR-0002 #1): it exists because keys live below
      // it, but has no explicit entry, so it carries epoch timestamps.
      return { kind: "dir", size: 0, createdAt: 0, modifiedAt: 0 };
    }
    throw new VFSNotFoundError(p);
  }

  /** Remove the file at `path`. Directories are never removable (POSIX). */
  async unlink(path: string): Promise<void> {
    await Promise.resolve();
    const p = normalizeVfsPath(path);
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node === undefined) {
      // A derived directory has no entry but exists; unlink must report
      // EISDIR there, not ENOENT.
      if (this.#existsAsDir(p)) {
        throw new VFSIsADirectoryError(p);
      }
      throw new VFSNotFoundError(p);
    }
    if (node.kind === "dir") {
      throw new VFSIsADirectoryError(p);
    }
    this.#nodes.delete(p);
    this.#totalBytes -= node.size;
  }

  /**
   * Rename/move `from` to `to`. POSIX semantics: overwrites an existing
   * file; refuses to move into the source's own subtree; refuses to
   * overwrite a non-empty directory. Moves whole subtrees via prefix scan
   * (ADR-0002 #1).
   */
  async rename(from: string, to: string): Promise<void> {
    await Promise.resolve();
    const src = normalizeVfsPath(from);
    const dst = normalizeVfsPath(to);
    if (src === "/" || dst === "/") {
      throw new VFSInvalidPathError(`${from} -> ${to}`, "cannot rename the root directory");
    }
    if (src === dst) {
      // POSIX no-op, success without side effects.
      return;
    }
    if (dst.startsWith(this.#prefixOf(src))) {
      throw new VFSInvalidPathError(`${from} -> ${to}`, "destination is inside the source subtree");
    }
    this.#assertNoFileAncestors(src);
    this.#assertNoFileAncestors(dst);
    const srcNode = this.#nodes.get(src);
    const srcIsDir = srcNode?.kind === "dir" || (srcNode === undefined && this.#existsAsDir(src));
    if (!srcIsDir && srcNode === undefined) {
      throw new VFSNotFoundError(src);
    }
    const dstNode = this.#nodes.get(dst);
    const dstIsDir = dstNode?.kind === "dir" || (dstNode === undefined && this.#existsAsDir(dst));
    if (dstIsDir) {
      // POSIX: a file cannot replace a directory.
      if (!srcIsDir) {
        throw new VFSIsADirectoryError(dst);
      }
      // POSIX: a non-empty directory cannot be overwritten.
      if (this.#hasChildren(dst)) {
        throw new VFSNotEmptyError(dst);
      }
      this.#nodes.delete(dst);
    } else if (isFileNode(dstNode)) {
      // POSIX: a directory cannot replace a file.
      if (srcIsDir) {
        throw new VFSNotADirectoryError(dst);
      }
      this.#nodes.delete(dst);
      this.#totalBytes -= dstNode.size;
    }
    // Prefix scan (ADR-0002 #1): move the root and every descendant key.
    const prefix = this.#prefixOf(src);
    const moved = [...this.#nodes.entries()].filter(([key]) => key === src || key.startsWith(prefix));
    for (const [key, node] of moved) {
      this.#nodes.delete(key);
      this.#nodes.set(dst + key.slice(src.length), node);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** `/a/b` -> `/a/`; the root prefix is just `/`. */
  #prefixOf(p: string): string {
    return p === "/" ? "/" : `${p}/`;
  }

  /**
   * ENOTDIR check: every ancestor of `p` must not be a file. Runs before
   * ENOENT checks so a path under a file reports ENOTDIR, like Node.
   */
  #assertNoFileAncestors(p: string): void {
    let cur = parentOf(p);
    while (cur !== undefined) {
      if (this.#nodes.get(cur)?.kind === "file") {
        throw new VFSNotADirectoryError(p);
      }
      cur = parentOf(cur);
    }
  }

  /** True when `p` is a directory: an explicit DirNode or derived (ADR-0002 #1). */
  #existsAsDir(p: string): boolean {
    if (p === "/") {
      return true;
    }
    if (this.#nodes.get(p)?.kind === "dir") {
      return true;
    }
    const prefix = this.#prefixOf(p);
    for (const key of this.#nodes.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  #hasChildren(p: string): boolean {
    const prefix = this.#prefixOf(p);
    for (const key of this.#nodes.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /** Resolve `p` to a FileNode, throwing ENOTDIR/ENOENT/EISDIR and touching LRU. */
  #fileAt(p: string): FileNode {
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node === undefined) {
      // A derived directory exists (ADR-0002 #1) even without an explicit
      // entry; reading it must report EISDIR, not ENOENT.
      if (this.#existsAsDir(p)) {
        throw new VFSIsADirectoryError(p);
      }
      throw new VFSNotFoundError(p);
    }
    if (node.kind === "dir") {
      throw new VFSIsADirectoryError(p);
    }
    node.lastAccessCounter = ++this.#accessCounter;
    return node;
  }

  /**
   * Reclaim space via LRU eviction until `bytesNeeded` fits (ADR-0002 #4).
   * The file being written (`excludePath`) is never evicted. The
   * constructor's `maxFileSize <= maxTotalBytes` invariant guarantees this
   * loop terminates with room for any legal write.
   */
  #evictFor(bytesNeeded: number, excludePath: string): void {
    if (this.#totalBytes + bytesNeeded <= this.maxTotalBytes) {
      return;
    }
    const evictable: Array<[string, FileNode]> = [];
    for (const [key, node] of this.#nodes) {
      if (node.kind === "file" && key !== excludePath) {
        evictable.push([key, node]);
      }
    }
    evictable.sort((a, b) => a[1].lastAccessCounter - b[1].lastAccessCounter);
    for (const [key, node] of evictable) {
      if (this.#totalBytes + bytesNeeded <= this.maxTotalBytes) {
        break;
      }
      this.#nodes.delete(key);
      this.#totalBytes -= node.size;
    }
  }
}
