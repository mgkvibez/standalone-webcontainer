import { normalizeVfsPath } from "./path.js";
import {
  VFSIsADirectoryError,
  VFSInvalidEncodingError,
  VFSInvalidPathError,
  VFSNotEmptyError,
  VFSNotFoundError,
  VFSNotADirectoryError,
  VFSNoSpaceError,
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
  VFSNoSpaceError,
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

export interface WriteFileOptions {
  /** Mark generated data as safe to remove under capacity pressure. Defaults to false. */
  readonly evictable?: boolean;
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
 *   are derived on demand from the keys below them (#1). A descendant-count
 *   index keeps directory-existence checks constant-time without changing
 *   the storage model.
 * - Async methods yield once on entry and use the same synchronous core as
 *   the worker-only sync methods. The core runs atomically, so async calls
 *   interleave only at entry and bookkeeping never sees torn state (#2).
 *   Blocking-style work in a worker freezes only the worker.
 * - In-memory only: no persistence in Phase 1 (#3).
 * - Chunked `Uint8Array` storage, per-file cap, whole-VFS cap, and LRU
 *   eviction restricted to explicitly regenerable files (#4).
 * - Zero DOM references: instantiable and runnable inside the Dedicated Web
 *   Worker that solely owns it (#2, #6). The main thread never holds it.
 */
/**
 * A change to the filesystem, as the watcher layer sees it.
 *
 * Node's two event names are the whole vocabulary: `change` means a file's contents moved, `rename` means it appeared,
 * disappeared, or moved. Creation and deletion are both `rename` because that is what a program watching a directory reacts
 * to, and a third category would be an invention Node does not have.
 */
export interface VfsChange {
  readonly kind: "change" | "rename";
  readonly path: string;
  /** For a rename: where the entry came from, so a watcher can tell a move from an unrelated pair of events. */
  readonly previousPath?: string;
}

export type VfsListener = (change: VfsChange) => void;

export class FileSystem {
  readonly maxFileSize: number;
  readonly maxTotalBytes: number;

  readonly #nodes = new Map<string, Node>();
  /** Number of stored nodes beneath each path; keeps derived-directory checks O(1). */
  readonly #descendantCounts = new Map<string, number>();
  #totalBytes = 0;
  #accessCounter = 0;
  /** Change subscribers. Empty in the common case, so watching costs a size check per write. */
  readonly #listeners = new Set<VfsListener>();

  constructor(options: FileSystemOptions = {}) {
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (this.maxFileSize <= 0 || this.maxTotalBytes <= 0) {
      throw new RangeError("maxFileSize and maxTotalBytes must be positive");
    }
    // WHY: a legal single file must fit in an empty VFS. The write may still
    // fail when protected files occupy the remaining capacity.
    if (this.maxFileSize > this.maxTotalBytes) {
      throw new RangeError("maxFileSize must not exceed maxTotalBytes");
    }
  }

  /**
   * Observe every mutation, for `fs.watch` and the kernel's watch registry.
   *
   * Returns an unsubscribe function rather than exposing `off(listener)`: a closure cannot be confused with another
   * subscriber's, and dropping the last watcher must not leave a dead listener queued behind every write.
   */
  subscribe(listener: VfsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get watcherCount(): number {
    return this.#listeners.size;
  }

  /**
   * Tell subscribers what changed.
   *
   * A throwing listener is contained on purpose: notification observes a write that already succeeded, so a bug in a watcher
   * must not turn a successful `writeFileSync` into a failed one. The throw is swallowed and the other listeners still run.
   */
  #emit(change: VfsChange): void {
    if (this.#listeners.size === 0) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {
        // Observation must never affect the observed write.
      }
    }
  }

  /** Write `data` to `path`, creating the file and derived parents. */
  async writeFile(path: string, data: string | Uint8Array, options: WriteFileOptions = {}): Promise<void> {
    await Promise.resolve(); // async-first contract (ADR-0002 #2)
    this.writeFileSync(path, data, options);
  }

  /**
   * Synchronous write. ADR-0002 #2 states that sync APIs block ONLY the worker
   * thread, which presupposes a sync path exists inside the worker; ADR-0002 #7
   * makes `fs` the first shim, and Node's `fs.writeFileSync` has no async
   * equivalent that CommonJS `require()` can await. The body is the same code the
   * async method runs after its yield, so the two cannot diverge.
   */
  writeFileSync(path: string, data: string | Uint8Array, options: WriteFileOptions = {}): void {
    const p = normalizeVfsPath(path);
    // CRITICAL integrity guard (expert review of PR #2): derived directories
    // have NO Map entry, so the old `existing?.kind === "dir"` check missed
    // them — writing a file onto one would orphan its children and corrupt
    // stat/readdir. `#existsAsDir` covers the root, explicit entries, and
    // derived entries using the descendant index, so package installs do not
    // scan the whole VFS once per file.
    if (this.#existsAsDir(p)) {
      throw new VFSIsADirectoryError(p);
    }
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new TypeError(`writeFile: data must be a string or Uint8Array, got ${typeof data}`);
    }
    this.#assertNoFileAncestors(p);
    const existing = this.#nodes.get(p);
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
      evictable: options.evictable === true,
      chunks,
      size: bytes.byteLength,
      // Birth time survives overwrites, like Node's stat.birthtime.
      createdAt: isFileNode(existing) ? existing.createdAt : now,
      modifiedAt: now,
      lastAccessCounter: ++this.#accessCounter,
    });
    if (existing === undefined) this.#changeAncestorCounts(p, 1);
    this.#totalBytes += bytes.byteLength;
    this.#emit({ kind: "change", path: p });
  }

  /** Read `path`. Returns `Uint8Array`, or `string` when encoding is "utf8". */
  async readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string> {
    await Promise.resolve();
    return this.readFileSync(path, encoding);
  }

  /** Synchronous read. Same rationale as `writeFileSync`. */
  readFileSync(path: string, encoding?: "utf8"): Uint8Array | string {
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
    this.mkdirSync(path, options);
  }

  /** Synchronous mkdir. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  mkdirSync(path: string, options: { readonly recursive?: boolean } = {}): void {
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
          this.#changeAncestorCounts(cur, 1);
        }
      }
    }
    const now = Date.now();
    this.#nodes.set(p, { kind: "dir", createdAt: now, modifiedAt: now } satisfies DirNode);
    this.#changeAncestorCounts(p, 1);
    this.#emit({ kind: "rename", path: p });
  }

  /** List direct child names of the directory at `path`, sorted. */
  async readdir(path: string): Promise<string[]> {
    await Promise.resolve();
    return this.readdirSync(path);
  }

  /** Synchronous readdir. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  readdirSync(path: string): string[] {
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
    return this.statSync(path);
  }

  /** Synchronous stat. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  /** The loop, spelled once, so the resolver has one shape to call whatever substrate it is talking to. */
  statManySync(paths: readonly string[]): (Stats | null)[] {
    return paths.map((path) => {
      try {
        return this.statSync(path);
      } catch {
        return null;
      }
    });
  }

  statSync(path: string): Stats {
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

  /**
   * Set a node's modification time, which is what `fs.utimes` does underneath.
   *
   * `createdAt` is left alone on purpose: POSIX `utimes` cannot change birth time either, and this VFS treats
   * `createdAt` as birth time everywhere (`statSync` reports it as such, and a write preserves it).
   *
   * A DERIVED directory has no Map entry, so setting a time on one MATERIALIZES it with the same epoch timestamps its
   * siblings have. That is the same choice `mkdirSync` makes for a parent it had to create, and the alternative (silently
   * doing nothing) would make `utimes` succeed while `stat` still reported 0, which is a lie a caller could not detect.
   */
  utimesSync(path: string, modifiedAt: number): void {
    const p = normalizeVfsPath(path);
    if (!Number.isFinite(modifiedAt) || modifiedAt < 0) {
      throw new VFSInvalidPathError(p, "utimes needs a finite, non-negative modification time");
    }
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node !== undefined) {
      node.modifiedAt = modifiedAt;
      this.#emit({ kind: "change", path: p });
      return;
    }
    if (p === "/" || this.#existsAsDir(p)) {
      // The root is derived by definition and has nowhere to store a time: it is not a keyed entry, and inventing one for
      // `/` would put a node at the root that every readdir and count has to special-case. Reporting that honestly beats a
      // silent no-op.
      if (p === "/") {
        throw new VFSInvalidPathError(p, "the root directory has no stored timestamps to set");
      }
      this.#nodes.set(p, { kind: "dir", createdAt: modifiedAt, modifiedAt });
      this.#changeAncestorCounts(p, 1);
      this.#emit({ kind: "change", path: p });
      return;
    }
    throw new VFSNotFoundError(p);
  }

  /** Remove the file at `path`. Directories are never removable (POSIX). */
  async unlink(path: string): Promise<void> {
    await Promise.resolve();
    this.unlinkSync(path);
  }

  /** Synchronous unlink. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  unlinkSync(path: string): void {
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
    this.#changeAncestorCounts(p, -1);
    this.#totalBytes -= node.size;
    this.#emit({ kind: "rename", path: p });
  }

  /**
   * Remove the empty directory at `path` (POSIX `rmdir`).
   *
   * WHY in Phase 1 (expert decision, Oct 26): npm install/remove flows
   * need directory deletion before the package layer exists. Recursive
   * removal is deliberately deferred: POSIX `rmdir` refuses non-empty
   * directories, and keeping that strictness now avoids guessing at
   * subtree-copy/unmount semantics the expert has not ruled on.
   */
  async rmdir(path: string): Promise<void> {
    await Promise.resolve();
    this.rmdirSync(path);
  }

  /** Synchronous rmdir. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  rmdirSync(path: string): void {
    const p = normalizeVfsPath(path);
    if (p === "/") {
      // The root is always in use; POSIX reports EBUSY, Node surfaces
      // EINVAL. We report EINVAL with an explicit message.
      throw new VFSInvalidPathError(p, "cannot remove the root directory");
    }
    this.#assertNoFileAncestors(p);
    const node = this.#nodes.get(p);
    if (node === undefined) {
      // No entry: either a derived directory (children exist, so it is
      // non-empty) or nothing at all.
      if (this.#existsAsDir(p)) {
        throw new VFSNotEmptyError(p);
      }
      throw new VFSNotFoundError(p);
    }
    if (node.kind === "file") {
      // POSIX rmdir on a regular file is ENOTDIR.
      throw new VFSNotADirectoryError(p);
    }
    if (this.#hasChildren(p)) {
      throw new VFSNotEmptyError(p);
    }
    this.#nodes.delete(p);
    this.#changeAncestorCounts(p, -1);
    this.#emit({ kind: "rename", path: p });
  }

  /**
   * Rename/move `from` to `to`. POSIX semantics: overwrites an existing
   * file; refuses to move into the source's own subtree; refuses to
   * overwrite a non-empty directory. Moves whole subtrees via prefix scan
   * (ADR-0002 #1).
   */
  async rename(from: string, to: string): Promise<void> {
    await Promise.resolve();
    this.renameSync(from, to);
  }

  /** Synchronous rename. Same rationale as `writeFileSync` (ADR-0002 #2, #7). */
  renameSync(from: string, to: string): void {
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
      if (dstNode !== undefined) this.#changeAncestorCounts(dst, -1);
    } else if (isFileNode(dstNode)) {
      // POSIX: a directory cannot replace a file.
      if (srcIsDir) {
        throw new VFSNotADirectoryError(dst);
      }
      this.#nodes.delete(dst);
      this.#changeAncestorCounts(dst, -1);
      this.#totalBytes -= dstNode.size;
    }
    // Prefix scan (ADR-0002 #1): move the root and every descendant key.
    const prefix = this.#prefixOf(src);
    const moved = [...this.#nodes.entries()].filter(([key]) => key === src || key.startsWith(prefix));
    for (const [key, node] of moved) {
      this.#nodes.delete(key);
      const movedPath = dst + key.slice(src.length);
      this.#changeAncestorCounts(key, -1);
      this.#changeAncestorCounts(movedPath, 1);
      this.#nodes.set(movedPath, node);
    }
    // One event carrying both names, not two: a watcher interested in either side of the move must be able to tell that
    // these two paths are the same entry, which two unrelated `rename` events could not express.
    this.#emit({ kind: "rename", path: dst, previousPath: src });
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
    return (this.#descendantCounts.get(p) ?? 0) > 0;
  }

  #hasChildren(p: string): boolean {
    return (this.#descendantCounts.get(p) ?? 0) > 0;
  }

  /** Adjust counts for every ancestor because `path` itself is a stored node. */
  #changeAncestorCounts(path: string, delta: 1 | -1): void {
    let ancestor = parentOf(path);
    while (ancestor !== undefined) {
      const next = (this.#descendantCounts.get(ancestor) ?? 0) + delta;
      if (next < 0) throw new Error(`VFS descendant-count invariant violated at '${ancestor}'`);
      if (next === 0) this.#descendantCounts.delete(ancestor);
      else this.#descendantCounts.set(ancestor, next);
      ancestor = parentOf(ancestor);
    }
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
   * Reclaim space only from explicitly regenerable files. Preflight the
   * eligible bytes first so a failed write never leaves a partially evicted
   * VFS. User files are protected by default.
   */
  #evictFor(bytesNeeded: number, excludePath: string): void {
    if (this.#totalBytes + bytesNeeded <= this.maxTotalBytes) {
      return;
    }
    const evictable: Array<[string, FileNode]> = [];
    for (const [key, node] of this.#nodes) {
      if (node.kind === "file" && node.evictable && key !== excludePath) {
        evictable.push([key, node]);
      }
    }
    evictable.sort((a, b) => a[1].lastAccessCounter - b[1].lastAccessCounter);
    const reclaimable = evictable.reduce((total, [, node]) => total + node.size, 0);
    if (this.#totalBytes + bytesNeeded - reclaimable > this.maxTotalBytes) {
      throw new VFSNoSpaceError(excludePath, bytesNeeded, this.maxTotalBytes);
    }
    for (const [key, node] of evictable) {
      if (this.#totalBytes + bytesNeeded <= this.maxTotalBytes) {
        break;
      }
      this.#nodes.delete(key);
      this.#changeAncestorCounts(key, -1);
      this.#totalBytes -= node.size;
    }
  }
}
