/**
 * `fs.watch` as a process sees it: a handle that asks the kernel what changed.
 *
 * The direction is the whole design. A watcher in Node is pushed to; here it polls, because a process cannot be interrupted —
 * it spends most of its life blocked inside `Atomics.wait` waiting for a syscall answer, and a kernel that pushed events
 * would have to write into a channel the process is not reading. Polling turns a push into a pull the process is already
 * built to make.
 *
 * What that costs, stated plainly: an event is delivered at most one poll interval late (default 20 ms). That is the price of
 * not having a second channel per watcher, and it is invisible to an HMR flow whose next step is a full module reload.
 *
 * Three behaviours come from Node and are tested rather than assumed:
 * - listeners receive `(eventType, filename)` where `eventType` is "change" or "rename";
 * - `close()` is idempotent and stops delivery immediately;
 * - a watcher whose kernel has gone away reports an error and closes, instead of polling a dead channel forever.
 */

import {
  toWatchAsyncIterator,
  type WatchAsyncIterator,
  type WatchHandlePort,
} from "../vfs/watch-iterator.js";

export type { WatchAsyncIterator } from "../vfs/watch-iterator.js";

export interface WatchTransport {
  call(request: unknown, options: { readonly timeoutMs: number }): unknown;
}

export type WatchEventType = "change" | "rename";

export interface WatchEventRecord {
  readonly kind: WatchEventType;
  readonly path: string;
  readonly previousPath?: string;
}

export interface WatchTickScheduler {
  /** Run `tick` once after `delayMs`, returning a cancel function. Injected so tests are not fighting real timers. */
  readonly schedule: (tick: () => void, delayMs: number) => () => void;
}

export interface FsWatcher {
  /**
   * `(eventType, filename)`, filename being the base name of the changed path, as Node reports it.
   *
   * `close` is a real event on Node's `FSWatcher`, and it is load-bearing here: an async iterator waiting on `next()` has no
   * other way to learn that no event will ever come, so without it `for await` over a closed watcher hangs forever.
   */
  on(event: WatchEventType | "error" | "close", listener: (...args: never[]) => void): FsWatcher;
  close(): void;
  readonly closed: boolean;
  /** Events the kernel had to drop because this watcher was not polled in time. Evidence, not an error. */
  readonly dropped: number;
}

export interface RemoteWatchOptions {
  readonly transport: WatchTransport;
  readonly path: string;
  readonly recursive?: boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly scheduler: WatchTickScheduler;
  /** Called when the watcher gives up (kernel gone). Defaults to a no-op so a forgotten handler cannot throw. */
  readonly onFatal?: (error: Error) => void;
}

/**
 * A scheduler backed by real timers.
 *
 * Watching is a real-time activity even inside a virtual-clock runtime: a poll interval measured in virtual milliseconds would
 * never fire, because virtual time only advances when the timer queue runs and the queue is exactly what is empty while a
 * watcher waits.
 */
export const realTimerScheduler: WatchTickScheduler = {
  schedule: (tick, delayMs) => {
    const id = setTimeout(tick, delayMs);
    return () => clearTimeout(id);
  },
};

const DEFAULT_WATCH_POLL_MS = 20;
const DEFAULT_WATCH_TIMEOUT_MS = 5_000;

const baseNameOf = (path: string): string => {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
};

/** Minimal event map. Not the shim's EventEmitter: this runs inside a Worker and must not depend on user-visible state. */
class Listeners {
  readonly #byEvent = new Map<string, Array<(...args: never[]) => void>>();

  add(event: string, listener: (...args: never[]) => void): void {
    const existing = this.#byEvent.get(event);
    if (existing === undefined) this.#byEvent.set(event, [listener]);
    else existing.push(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.#byEvent.get(event);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      (listener as unknown as (...values: unknown[]) => void)(...args);
    }
  }

  removeAll(): void {
    this.#byEvent.clear();
  }
}

/**
 * Start watching. The registration happens immediately and synchronously, so a caller that writes a file right after
 * `watch()` returns cannot miss the change — Node behaves the same way, and a deferred registration would be a race a program
 * could never see, only suffer.
 */
export function createRemoteWatcher(options: RemoteWatchOptions): FsWatcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_POLL_MS;
  const listeners = new Listeners();

  const answer = options.transport.call(
    { op: "watch", path: options.path, ...(options.recursive === true ? { recursive: true } : {}) },
    { timeoutMs },
  );
  if (typeof answer !== "object" || answer === null || (answer as { kind?: unknown }).kind !== "watch") {
    throw new Error(`filesystem watch of "${options.path}" returned a response the client does not understand`);
  }
  const watchId = (answer as { watchId: number }).watchId;

  const state = { closed: false, dropped: 0, cancelTimer: undefined as undefined | (() => void), polling: false };

  const finish = (): void => {
    if (state.closed) return;
    state.closed = true;
    if (state.cancelTimer !== undefined) {
      state.cancelTimer();
      state.cancelTimer = undefined;
    }
    // Best effort: if the kernel is gone, there is nothing to unwatch, and throwing here would hide the reason we stopped.
    try {
      options.transport.call({ op: "unwatch", watchId }, { timeoutMs });
    } catch {
      /* the kernel that held this watch is unreachable; closing is the right outcome either way */
    }
    // Order matters twice over: the close must be announced BEFORE the listeners are dropped, or a waiter never hears it.
    listeners.emit("close");
    listeners.removeAll();
  };

  const deliver = (events: readonly WatchEventRecord[]): void => {
    for (const event of events) {
      // A listener that closes the watcher mid-batch must stop the rest, exactly as in Node.
      if (state.closed) return;
      listeners.emit(event.kind, event.kind, baseNameOf(event.path));
    }
  };

  const pollOnce = (): void => {
    if (state.closed || state.polling) return;
    state.polling = true;
    try {
      const answer = options.transport.call({ op: "poll", watchId }, { timeoutMs });
      if (typeof answer !== "object" || answer === null || (answer as { kind?: unknown }).kind !== "events") {
        throw new Error("filesystem watch poll returned a response the client does not understand");
      }
      const result = answer as { events: readonly WatchEventRecord[]; dropped: number };
      state.dropped += result.dropped;
      if (result.events.length > 0) deliver(result.events);
    } catch (error) {
      // A kernel that cannot answer will not answer later either. Report once and stop, rather than spinning on a dead
      // channel forever: that is the same phantom-watcher failure the registry's cleanup exists to prevent, mirrored here.
      const fatal = error instanceof Error ? error : new Error(String(error));
      // Emit first, then close: finish() drops every listener, so an error raised afterwards would reach nobody. The first
      // version of this did exactly that and the error vanished silently — the same failure the error event exists for.
      listeners.emit("error", fatal);
      finish();
      if (options.onFatal !== undefined) options.onFatal(fatal);
      return;
    } finally {
      state.polling = false;
    }
    scheduleNext();
  };

  const scheduleNext = (): void => {
    if (state.closed) return;
    state.cancelTimer = options.scheduler.schedule(pollOnce, intervalMs);
  };

  scheduleNext();

  const watcher: FsWatcher = {
    on(event, listener) {
      listeners.add(event, listener);
      return watcher;
    },
    close: finish,
    get closed() {
      return state.closed;
    },
    get dropped() {
      return state.dropped;
    },
  };
  return watcher;
}

export function createRemoteWatchIterator(watcher: FsWatcher): WatchAsyncIterator {
  // One implementation, shared with the in-process path: a second copy of this logic is a second place to forget `close()`.
  return toWatchAsyncIterator(watcher as unknown as WatchHandlePort);
}
