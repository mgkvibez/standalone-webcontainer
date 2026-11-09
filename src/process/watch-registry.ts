/**
 * The kernel's watch registry: who is watching what, and what they have not been told yet.
 *
 * A process cannot observe filesystem changes by itself — it does not own the filesystem, a different Worker does, and its
 * only channel to that Worker is the blocking syscall channel. So watches live here, in the kernel, and a process learns
 * about changes by asking (`poll`). That inverts the usual direction of `fs.watch` on purpose: the kernel must never call
 * into a process, because the process may be blocked, dead, or mid-syscall, and a notification pushed into a dead channel
 * is exactly the phantom-watcher failure this file exists to prevent.
 *
 * Three decisions worth stating, because each one is a place where a watcher could quietly lie:
 *
 * 1. **Ownership is explicit.** Every watch belongs to an owner (a pid, as a string). `stopAll(owner)` is called when a
 *    process exits, so a killed process cannot leave a watch feeding a channel nobody reads.
 * 2. **Coalescing is per path, and `rename` wins.** Node collapses bursts; a program watching a file being written ten times
 *    in a tick should not receive ten events, and a creation followed by writes must not report only a content change.
 * 3. **The queue is bounded and drops are counted.** An unbounded queue under a process that never polls is a memory leak
 *    shaped like a feature. Dropping is reported in `dropped` rather than hidden, so a watcher that fell behind is visible.
 */

import type { VfsChange } from "../vfs/index.js";

export interface WatchScopeStats {
  readonly owner: string;
  readonly watches: number;
  readonly pending: number;
  readonly dropped: number;
}

export interface WatchRequest {
  /** Who the watch belongs to. A pid as a string; the kernel binds it, the process never sends it. */
  readonly owner: string;
  /** Absolute path being watched, as a file or a directory. */
  readonly path: string;
  /** Watch everything beneath `path`. Node supports this on some platforms only; here it is supported everywhere. */
  readonly recursive?: boolean;
}

export interface WatchEvent {
  readonly kind: "change" | "rename";
  readonly path: string;
  readonly previousPath?: string;
}

export interface WatchPollResult {
  readonly events: readonly WatchEvent[];
  /** Events discarded because the owner did not poll and the queue hit its cap. Reported, never silent. */
  readonly dropped: number;
}

export class WatchNotFoundError extends Error {
  readonly code = "EBADF";
  constructor(watchId: number) {
    super(`No watch with id ${watchId} belongs to this process.`);
    this.name = "WatchNotFoundError";
  }
}

export class WatchTargetMissingError extends Error {
  readonly code = "ENOENT";
  constructor(path: string) {
    super(`Cannot watch "${path}": it does not exist.`);
    this.name = "WatchTargetMissingError";
  }
}

/** How many undispatched events one watch may hold before the oldest are dropped. */
export const MAX_PENDING_EVENTS = 512;

interface WatchEntry {
  readonly id: number;
  readonly owner: string;
  readonly path: string;
  readonly recursive: boolean;
  readonly targetIsDirectory: boolean;
  /** Undelivered events in arrival order, keyed by path so a burst on one path collapses. */
  readonly pending: Map<string, WatchEvent>;
  dropped: number;
}

/** `a/b` -> `a/`; the root's parent is undefined. Mirrors the VFS's own notion of a parent without importing it. */
const parentPathOf = (path: string): string | undefined => {
  if (path === "/") return undefined;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const isUnder = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);

export interface WatchRegistryOptions {
  /**
   * Whether a path is a directory at registration time.
   *
   * Injected rather than taken from the VFS because the answer decides matching rules and this file is otherwise pure: no
   * storage, no timers, no I/O, so every matching rule can be tested without a filesystem.
   */
  readonly statKind: (path: string) => "file" | "dir";
  readonly maxPending?: number;
}

export class WatchRegistry {
  readonly #statKind: (path: string) => "file" | "dir";
  readonly #maxPending: number;
  /** owner -> (watch id -> entry). Two levels so `stopAll` is one delete. */
  readonly #byOwner = new Map<string, Map<number, WatchEntry>>();
  #nextId = 1;

  constructor(options: WatchRegistryOptions) {
    this.#statKind = options.statKind;
    this.#maxPending = options.maxPending ?? MAX_PENDING_EVENTS;
    if (this.#maxPending <= 0) throw new RangeError("maxPending must be positive");
  }

  /** Register a watch and return its process-scoped id. Throws if the path does not exist. */
  watch(request: WatchRequest): number {
    if (typeof request.path !== "string" || request.path === "") {
      throw new TypeError("A watch needs a non-empty path.");
    }
    if (!request.path.startsWith("/")) {
      throw new RangeError(`A watch path must be absolute, got "${request.path}".`);
    }
    if (request.path !== "/" && request.path.endsWith("/")) {
      throw new RangeError(`A watch path must not end with a slash, got "${request.path}".`);
    }
    let kind: "file" | "dir";
    try {
      kind = this.#statKind(request.path);
    } catch {
      throw new WatchTargetMissingError(request.path);
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const entry: WatchEntry = {
      id,
      owner: request.owner,
      path: request.path,
      recursive: request.recursive === true,
      targetIsDirectory: kind === "dir",
      pending: new Map(),
      dropped: 0,
    };
    let forOwner = this.#byOwner.get(request.owner);
    if (forOwner === undefined) {
      forOwner = new Map();
      this.#byOwner.set(request.owner, forOwner);
    }
    forOwner.set(id, entry);
    return id;
  }

  /** Remove one watch. Removing an unknown id throws: a silent no-op would hide a client that lost track of its handles. */
  unwatch(owner: string, watchId: number): void {
    const forOwner = this.#byOwner.get(owner);
    if (forOwner === undefined || !forOwner.delete(watchId)) throw new WatchNotFoundError(watchId);
    if (forOwner.size === 0) this.#byOwner.delete(owner);
  }

  /**
   * Remove every watch an owner holds, and say how many went.
   *
   * Called when a process exits. Returning the count matters: the kernel asserts it, so "the process is gone" and "its
   * watches are gone" cannot drift apart.
   */
  stopAll(owner: string): number {
    const forOwner = this.#byOwner.get(owner);
    if (forOwner === undefined) return 0;
    this.#byOwner.delete(owner);
    return forOwner.size;
  }

  /** Deliver everything queued for one watch, and reset its drop counter. */
  poll(owner: string, watchId: number): WatchPollResult {
    const entry = this.#byOwner.get(owner)?.get(watchId);
    if (entry === undefined) throw new WatchNotFoundError(watchId);
    const events = [...entry.pending.values()];
    const dropped = entry.dropped;
    entry.pending.clear();
    entry.dropped = 0;
    return { events, dropped };
  }

  /** Route one filesystem change to every watch that asked about it. Called from inside the VFS notification. */
  notify(change: VfsChange): void {
    if (this.#byOwner.size === 0) return;
    for (const forOwner of this.#byOwner.values()) {
      for (const entry of forOwner.values()) {
        if (!matches(entry, change)) continue;
        this.#enqueue(entry, {
          kind: change.kind,
          path: change.path,
          ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
        });
      }
    }
  }

  #enqueue(entry: WatchEntry, event: WatchEvent): void {
    const existing = entry.pending.get(event.path);
    if (existing !== undefined) {
      // Coalescing: `rename` outranks `change`, because "it appeared" is news that a later content write must not replace.
      // A rename keeps its own provenance; a rename arriving after a change replaces the weaker record.
      if (existing.kind === "rename") return;
      if (event.kind === "rename") {
        entry.pending.set(event.path, {
          kind: "rename",
          path: event.path,
          ...(event.previousPath === undefined ? {} : { previousPath: event.previousPath }),
        });
      }
      // A second `change` on a path already queued is the same news; Map keeps the original position, so order is stable.
      return;
    }
    if (entry.pending.size >= this.#maxPending) {
      // Drop the oldest: the newest events are the ones a watcher can still act on.
      const oldest = entry.pending.keys().next();
      if (oldest.done !== true) entry.pending.delete(oldest.value);
      entry.dropped += 1;
    }
    entry.pending.set(event.path, event);
  }

  /** Evidence for the kernel: nothing should be watching after a teardown. */
  stats(): readonly WatchScopeStats[] {
    const out: WatchScopeStats[] = [];
    for (const [owner, forOwner] of this.#byOwner) {
      let pending = 0;
      let dropped = 0;
      for (const entry of forOwner.values()) {
        pending += entry.pending.size;
        dropped += entry.dropped;
      }
      out.push({ owner, watches: forOwner.size, pending, dropped });
    }
    return out;
  }

  /** Total live watches. Cheaper than `stats()` for a hot assertion. */
  get size(): number {
    let total = 0;
    for (const forOwner of this.#byOwner.values()) total += forOwner.size;
    return total;
  }
}

/**
 * Does this change concern this watch?
 *
 * A directory watch reports its own path and its direct children (recursively too, if asked); a file watch reports only that
 * file. Both sides of a rename are considered, so a watcher on the destination learns about a move into it and a watcher on
 * the source learns about a move out — which is what Node's `rename` event means for a directory watcher.
 */
const matches = (entry: WatchEntry, change: VfsChange): boolean => {
  const candidates = change.previousPath === undefined ? [change.path] : [change.path, change.previousPath];
  for (const candidate of candidates) {
    if (entry.targetIsDirectory) {
      if (entry.recursive) {
        if (isUnder(candidate, entry.path)) return true;
      } else if (parentPathOf(candidate) === entry.path) {
        return true;
      }
      // A directory being renamed or removed is about the watched path itself.
      if (candidate === entry.path) return true;
      continue;
    }
    if (candidate === entry.path) return true;
  }
  return false;
};
