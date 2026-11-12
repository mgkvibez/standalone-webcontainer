/**
 * The filesystem as a *port*, not a class.
 *
 * ADR-0018 puts each process in its own Worker, so code inside that Worker can no longer touch the in-memory VFS: the
 * kernel owns it. What the process needs is a narrow structural description of the calls it makes, so the real
 * `FileSystem` (in-process, in tests) and a channel-backed client (in a Worker) are interchangeable.
 *
 * The shapes below are copied from the VFS rather than invented for the port: `statSync` returns a plain record with
 * `kind`/`modifiedAt`/`createdAt`, exactly as `FileSystem` already does, so the shim that adapts it to Node's `Stats` is
 * unchanged and there is only one description of a stat in the codebase.
 */

export interface VfsStatsPort {
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly modifiedAt: number;
  readonly createdAt: number;
}

export interface WriteOptionsPort {
  /** Mark generated data as safe to remove under capacity pressure. Defaults to false. */
  readonly evictable?: boolean;
}

export interface MkdirOptionsPort {
  readonly recursive?: boolean;
}

import type { WatchHandlePort } from "./watch-iterator.js";

export interface FileSystemPort {
  readFileSync(path: string, encoding?: "utf8"): Uint8Array | string;
  writeFileSync(path: string, data: string | Uint8Array, options?: WriteOptionsPort): void;
  mkdirSync(path: string, options?: MkdirOptionsPort): void;
  readdirSync(path: string): string[];
  statSync(path: string): VfsStatsPort;
  /**
   * Stat several paths, one entry per path, `null` where the path does not exist.
   *
   * Optional because it is a capability, not a requirement: a substrate that can answer N stats in one round trip should say
   * so, and one that cannot is still a filesystem. `null` rather than a throw is deliberate, because the only caller probes
   * for existence in a fixed order and a miss is an ordinary answer, not a failure.
   */
  statManySync?(paths: readonly string[]): readonly (VfsStatsPort | null)[];
  unlinkSync(path: string): void;
  /**
   * Set a node's modification time. Optional for the same reason `statManySync` is: it is a capability, not a requirement, and a substrate
   * without stored timestamps is still a filesystem. The fs shim refuses by name when it is missing rather than reporting success it did not have.
   */
  utimesSync?(path: string, modifiedAt: number): void;
  rmdirSync(path: string): void;
  renameSync(from: string, to: string): void;
  /**
   * The promise forms the shim exposes as `fs.promises`. They are not a second implementation: in a Worker the sync call
   * already blocks, so the promise resolves the moment it returns. Kept in the port because the shim touches them.
   */
  readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array, options?: WriteOptionsPort): Promise<void>;
  mkdir(path: string, options?: MkdirOptionsPort): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

/**
 * Watching, as a port.
 *
 * Kept separate from `FileSystemPort` on purpose: watching is a capability a substrate may lack, and a shim that cannot watch
 * must say so with a typed refusal rather than pretend. Structural typing means the channel-backed watcher and the
 * in-process one both satisfy this without either importing the other.
 */
export interface WatchSourcePort {
  watch(path: string, options?: { readonly recursive?: boolean }): WatchHandlePort;
}
