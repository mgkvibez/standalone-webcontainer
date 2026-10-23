/**
 * VFS node shapes (ADR-0002 #1).
 *
 * WHY chunks: ADR-0002 #4 mandates chunked `Uint8Array` storage so that a
 * large file write never requires one contiguous allocation and eviction
 * accounting can be done per file, not per byte.
 *
 * WHY no persistence fields: Phase 1 is in-memory only (ADR-0002 #3). The
 * persistence surface is intentionally absent, not stubbed.
 */
export interface FileNode {
  kind: "file";
  /** File contents, chunked at CHUNK_SIZE; concatenation is the file body. */
  chunks: Uint8Array[];
  size: number;
  /** Epoch ms. Preserved across overwrites, like Node's birth time. */
  createdAt: number;
  /** Epoch ms of the last write. */
  modifiedAt: number;
  /** Monotonic LRU order (ADR-0002 #4): higher = more recently accessed. */
  lastAccessCounter: number;
}

export interface DirNode {
  kind: "dir";
  createdAt: number;
  modifiedAt: number;
}

export type Node = FileNode | DirNode;

/** Result of `stat`: enough for the future `fs` shim, nothing speculative. */
export interface Stats {
  kind: "file" | "dir";
  size: number;
  createdAt: number;
  modifiedAt: number;
}
