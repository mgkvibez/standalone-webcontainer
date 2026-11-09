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
 * - A throw inside a tick escapes the microtask and surfaces as an unhandled rejection, exactly as it did when
 *   `nextTick` was `queueMicrotask`. Node would crash the process instead. Recorded as a gap, not hidden.
 */

export type TickCallback = (...args: readonly never[]) => void;

export class TickQueue {
  readonly #pending: Array<() => void> = [];
  #flushScheduled = false;

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
    this.#flushScheduled = false;
    this.#flush();
  }

  /** True when callbacks are queued or a flush is already scheduled. Used by the runner to know it is finished. */
  get pending(): boolean {
    return this.#pending.length > 0 || this.#flushScheduled;
  }

  /**
   * Drain synchronously. One pass over a snapshot is not enough: a callback may queue another, and Node runs those in the
   * same tick phase. The loop is bounded by the queue itself, which the callers control.
   */
  #flush(): void {
    this.#flushScheduled = false;
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift();
        if (next === undefined) break;
        next();
      }
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
