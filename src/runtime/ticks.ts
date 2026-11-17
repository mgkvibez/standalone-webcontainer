/**
 * The nextTick queue.
 *
 * `process.nextTick` is not a promise job. In Node it is a separate queue that drains *before* the microtask queue
 * whenever the current operation completes, which is why `nextTick(fn)` beats `Promise.resolve().then(fn)` even when the
 * `.then` was registered first. Implementing it as `queueMicrotask` put it in the same queue as promises and let the two
 * interleave, so a program that mixed them saw a different order than Node. That was measured, not guessed: the
 * event-loop differential in `tools/differential` flagged `nexttick-before-promise`, `nexttick-nested` and
 * `async-await-order` as deviations.
 *
 * The fix is one microtask that drains the whole tick queue, including callbacks scheduled by callbacks. Draining to
 * quiescence *inside* a single microtask is what keeps ticks ahead of promise continuations: a tick that schedules
 * another tick runs before the `.then` that was already waiting behind the flush itself.
 *
 * Deliberate limits, so nobody mistakes this for a full event loop:
 * - A tick scheduled from inside a *promise* continuation runs after the continuations already queued, where Node would
 *   run it first. Closing that would mean owning the microtask queue, which is ADR-0018 work, not this.
 * - A throw inside a tick used to escape the microtask and surface as an unhandled rejection, which made `run()` reject
 *   instead of settling and left the caller with no verdict at all (W-40). A queue built with the runner's `onError` hook
 *   now reports the failure to the run, which settles it the way Node does: the remaining callbacks are dropped, because
 *   an uncaught exception ends the process rather than skipping to the next callback.
 */

export type TickCallback = (...args: readonly never[]) => void;

export class TickQueue {
  readonly #pending: Array<() => void> = [];
  #flushScheduled = false;
  /**
   * The run's reporter for a callback that threw, or `undefined` for a queue that is used on its own.
   *
   * Without a reporter the throw is re-raised out of the flush: a caller that owns the queue (the runner does) then has to
   * catch it, and every caller that forgot turned a program crash into an unresolved rejection in the harness or the page.
   * With one, the failure is attributed to the run and the queue stops rather than throwing at whoever flushed it.
   */
  readonly #onError: ((error: unknown) => void) | undefined;
  /** Set once a callback threw under a reporter: the queue is dead, as the process would be. */
  #failed = false;

  constructor(onError?: (error: unknown) => void) {
    this.#onError = onError;
  }

  /** Queue a callback for the tick phase. Order is first-in-first-out, as in Node. */
  schedule(callback: TickCallback, args: readonly unknown[] = []): void {
    this.#pending.push(() => {
      (callback as (...values: readonly unknown[]) => void)(...args);
    });

    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flush();
    });
  }

  /**
   * Drain now, synchronously.
   *
   * This is the part that makes the ordering match Node, and it is not obvious: scheduling the flush as a microtask is
   * too late whenever a promise continuation was registered *before* the tick. `Promise.resolve().then(a);
   * process.nextTick(b)` enqueues a native microtask for `a` first, so a microtask-based flush runs after `a` and prints
   * `promise,nextTick` where Node prints `nextTick,promise`. Draining at the end of the synchronous turn is what Node
   * actually does, so the runner calls this as soon as the program body returns, before any microtask can run.
   */
  flushNow(): void {
    if (this.#failed) return;
    this.#flushScheduled = false;
    this.#flush();
  }

  /**
   * True when callbacks are queued or a flush is already scheduled. Used by the runner to know it is finished.
   *
   * A failed queue reports false: its callbacks will never run, so a waiter that kept polling for them would wait forever.
   */
  get pending(): boolean {
    if (this.#failed) return false;
    return this.#pending.length > 0 || this.#flushScheduled;
  }

  /**
   * Drain synchronously. One pass over a snapshot is not enough: a callback may queue another, and Node runs those in the
   * same tick phase. The loop is bounded by the queue itself, which the callers control.
   */
  #flush(): void {
    this.#flushScheduled = false;
    if (this.#failed) {
      this.#pending.length = 0;
      return;
    }
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift();
        if (next === undefined) break;
        next();
      }
    } catch (error) {
      const report = this.#onError;
      if (report === undefined) throw error;
      // Node ends the process here, so the callbacks behind this one do not run. Keeping them queued would let a later
      // flush run them out of order and settle a run twice; dropping them is what "the process died" means.
      this.#failed = true;
      this.#pending.length = 0;
      this.#flushScheduled = false;
      report(error);
    } finally {
      // A throw abandoned the loop; anything left would otherwise be silently dropped.
      if (this.#pending.length > 0 && !this.#flushScheduled) {
        this.#flushScheduled = true;
        queueMicrotask(() => {
          this.#flush();
        });
      }
    }
  }
}
