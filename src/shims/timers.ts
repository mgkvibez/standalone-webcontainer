/**
 * `node:timers` and `node:timers/promises`, over THIS runtime's scheduler.
 *
 * The wiring hole this closes, measured by the audit and reproduced here: `require("timers")` threw MODULE_NOT_FOUND while the implementation
 * it would serve already existed in the tree (an unused preset module imported a timers preset and documented it as an approved
 * substrate; that module was never wired and was removed as dead code under P0-6). A
 * missing feature and a missing line in a table look identical at the call site, and this was the second: `setTimeout` was available as a
 * GLOBAL the whole time, because the run installs scheduler-backed globals, and the module that is supposed to export the same function
 * could not be loaded at all.
 *
 * WHY THE SCHEDULER AND NOT A PRESET: such a preset delegates to the platform's `globalThis.setTimeout`. That is the wrong clock
 * for a program running under the virtual scheduler. A program that mixes the two would see `Date.now()` jump 900 ms for a timer that fired in
 * a microsecond, and unref'd timers would keep the host alive rather than the virtual loop. So the same source of truth as the globals is
 * used, and virtual time, ref/unref and the budget all behave as they do for `setTimeout` written bare.
 *
 * `setInterval` from `timers/promises` is REFUSED BY NAME rather than omitted, because Node ships it and a caller will reach for it: it
 * returns an async iterator whose `break` must clear the timer, and a version that has never been run under this runtime's stop conditions
 * would be an untested code path that fails in the caller's loop instead of at the call. The refusal names it and says what to use instead.
 */
import type { Scheduler, TimerHandle } from "../runtime/scheduler.js";

/** Node's `Timeout`: a handle that can be cancelled, reffed or unreffed, and carries its numeric id. */
export interface TimeoutShim {
  readonly id: number;
  /** Carried through from the scheduler's handle so `clear()` can be given this object directly, as Node's clearTimeout accepts its Timeout. */
  readonly kind: "timeout" | "interval" | "immediate";
  ref(): TimeoutShim;
  unref(): TimeoutShim;
  hasRef(): boolean;
  close(): void;
}

export interface TimersShim {
  setTimeout(callback: (...args: never[]) => void, delay?: number, ...args: unknown[]): TimeoutShim;
  clearTimeout(handle: TimeoutShim | number | undefined): void;
  setInterval(callback: (...args: never[]) => void, delay?: number, ...args: unknown[]): TimeoutShim;
  clearInterval(handle: TimeoutShim | number | undefined): void;
  setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): TimeoutShim;
  clearImmediate(handle: TimeoutShim | number | undefined): void;
}

export interface TimersPromisesShim {
  setTimeout(delay?: number, value?: unknown): Promise<unknown>;
  setImmediate(value?: unknown): Promise<unknown>;
  setInterval(delay?: number, value?: unknown): AsyncIterable<unknown>;
}

/** One wrapper for both kinds of handle, so `close()`, `ref()` and `hasRef()` mean the same thing on a timeout and an interval. */
const asTimeout = (scheduler: Scheduler, handle: TimerHandle): TimeoutShim => {
  const timer: TimeoutShim = {
    id: handle.id,
    kind: handle.kind,
    ref: () => {
      handle.ref();
      return timer;
    },
    unref: () => {
      handle.unref();
      return timer;
    },
    hasRef: () => handle.hasRef(),
    // Node's `close()` is `clearTimeout(this)`; the scheduler's `clear` is the one operation, given either a handle or its id.
    close: () => scheduler.clear(handle),
  };
  return timer;
};

export const createTimersShim = (scheduler: Scheduler): TimersShim => ({
  setTimeout: (callback, delay = 0, ...args) => asTimeout(scheduler, scheduler.setTimeout(callback, delay, ...args)),
  clearTimeout: (handle) => scheduler.clear(handle),
  setInterval: (callback, delay = 0, ...args) => asTimeout(scheduler, scheduler.setInterval(callback, delay, ...args)),
  clearInterval: (handle) => scheduler.clear(handle),
  setImmediate: (callback, ...args) => asTimeout(scheduler, scheduler.setImmediate(callback, ...args)),
  clearImmediate: (handle) => scheduler.clear(handle),
});

export const createTimersPromisesShim = (scheduler: Scheduler): TimersPromisesShim => ({
  /**
   * Node's argument order is `(delay, value)`, the reverse of the callback form: the delay is required to make sense of a value that
   * arrives later, and a caller writing `await setTimeout(5)` means "wait, then carry on".
   */
  setTimeout: (delay = 0, value) =>
    new Promise((resolve) => {
      scheduler.setTimeout(() => resolve(value), delay);
    }),
  setImmediate: (value) =>
    new Promise((resolve) => {
      scheduler.setImmediate(() => resolve(value));
    }),
  setInterval: () => {
    throw Object.assign(
      new Error(
        "timers/promises setInterval is not implemented in this runtime: use setInterval from timers, or an async poll with timers/promises setTimeout",
      ),
      { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
    );
  },
});
