/**
 * The timer queue and the virtual clock (ADR-0013 amendments 1 and 2).
 *
 * The runtime previously had no timer queue at all: `setTimeout(fn, 5)` scheduled onto the HOST's timers, so by the time the
 * run snapshot its output the callback had not fired, and a program that plainly worked reported empty output. A 0 ms timer
 * only "worked" because the liveness drain happened to cross a macrotask boundary first.
 *
 * Three design points carry the contract:
 *
 * 1. **Virtual, not real.** The clock jumps to the next due timer instead of waiting for it. A 900 ms timer costs
 *    microseconds of real time, and `Date.now()` reports the virtual instant, because the owner decided a program's view of
 *    time should be deterministic rather than dependent on machine load.
 * 2. **The budget alone does not bound work.** A `setTimeout(fn, 0)` loop never advances virtual time, so it would spin
 *    inside a 1,000 ms budget forever. `maxCallbacks` and `maxRealMs` are separate guards for exactly that.
 * 3. **Every stop is recorded.** Queue-empty, budget-exhausted, callback-limit, real-time-limit: each is evidence, and guard
 *    stops are harness bounds rather than the program's own behaviour.
 */

/** Virtual scheduling time available to one execution. Provisional; audit may change it. */
export const DEFAULT_VIRTUAL_BUDGET_MS = 1_000;
/** Callbacks per execution. Bounds zero-delay loops, which the virtual budget cannot. */
export const DEFAULT_MAX_CALLBACKS = 10_000;
/** Real milliseconds per execution. Bounds microtask storms and pathological synchronous callbacks. */
export const DEFAULT_MAX_REAL_MS = 5_000;

export interface SchedulerLimits {
  readonly budgetMs?: number;
  readonly maxCallbacks?: number;
  readonly maxRealMs?: number;
}

/** Why draining stopped. Exactly one applies to any execution. */
export type SchedulerStop =
  | "queue-empty"
  | "budget-exhausted"
  | "callback-limit"
  | "real-time-limit"
  /** Every timer left is unref'd, so nothing keeps the loop alive: Node exits here and the timers never fire. */
  | "no-refs-left";

export interface SchedulerEvidence {
  readonly stop: SchedulerStop;
  /** Virtual milliseconds elapsed: scheduled time, NOT execution time. */
  readonly virtualElapsedMs: number;
  /** Real milliseconds the queue actually consumed. Reported separately, and never presented as virtual. */
  readonly realElapsedMs: number;
  readonly callbacks: number;
  /** Entries still pending when draining stopped. */
  readonly deferred: number;
  /** Intervals that hit their per-interval fire cap. */
  readonly intervalsTruncated: number;
  /** Callbacks that threw. Node would kill the process; we record and continue (see `drain`). */
  readonly callbackErrors: number;
  /** True when a guard, rather than the program, ended draining. Must never be scored as the program's behaviour. */
  readonly guarded: boolean;
  /**
   * Timers left pending because they were unref'd and nothing ref'd kept the loop alive to reach them. Not a guard: the
   * program asked for this by unref'ing, which is how a program says "do not wait for me".
   */
  readonly unrefPending: number;
  /** Whether draining stopped with no ref'd handle left. `true` is Node's "the loop has nothing to live for". */
  readonly refsExhausted: boolean;
}

/** What user code receives from `setTimeout`/`setInterval`: clearable, and combinable with `clearTimeout`. */
export interface TimerHandle {
  readonly id: number;
  readonly kind: "timeout" | "interval" | "immediate";
  ref(): TimerHandle;
  unref(): TimerHandle;
  hasRef(): boolean;
}

interface Entry {
  readonly id: number;
  readonly kind: "timeout" | "interval" | "immediate";
  due: number;
  seq: number;
  readonly fn: (...args: never[]) => void;
  readonly args: readonly unknown[];
  readonly intervalMs: number;
  fires: number;
  readonly maxFires: number;
  /** `true` while this entry can still fire. `hasRef()` on a fired or cleared timer is false, as in Node. */
  live: boolean;
  /** Ref'd entries keep the loop alive. `unref()` turns this off without cancelling the timer. */
  refed: boolean;
}

/** Two microtask hops: one lets the first continuation run, two let a continuation that queues another continuation run. */
async function drainContinuations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export class Scheduler {
  readonly #budgetMs: number;
  readonly #maxCallbacks: number;
  readonly #maxRealMs: number;
  /** One real instant, captured at execution start: the epoch `Date.now()` is measured from. */
  readonly #baselineEpoch: number;
  readonly #realStart: number;
  #virtual = 0;
  #seq = 0;
  #nextId = 1;
  #queue: Entry[] = [];
  #intervalsTruncated = 0;
  #unrefPending = 0;
  /** Totals across every drain pass, so the callback guard bounds the WHOLE execution rather than one pass. */
  #callbacks = 0;
  #callbackErrors = 0;
  #evidence: SchedulerEvidence | null = null;
  readonly #onCallbackError: ((error: unknown) => void) | undefined;

  constructor(limits: SchedulerLimits = {}, onCallbackError?: (error: unknown) => void) {
    this.#budgetMs = limits.budgetMs ?? DEFAULT_VIRTUAL_BUDGET_MS;
    this.#maxCallbacks = limits.maxCallbacks ?? DEFAULT_MAX_CALLBACKS;
    this.#maxRealMs = limits.maxRealMs ?? DEFAULT_MAX_REAL_MS;
    this.#baselineEpoch = Date.now();
    this.#realStart = Date.now();
    this.#onCallbackError = onCallbackError;
  }

  /** Virtual elapsed scheduled time, from 0. What `performance.now()` reports. */
  get virtualElapsedMs(): number {
    return this.#virtual;
  }

  /** `Date.now()` under this scheduler: the real baseline plus virtual elapsed. */
  now(): number {
    return this.#baselineEpoch + this.#virtual;
  }

  get timeOrigin(): number {
    return this.#baselineEpoch;
  }

  get budgetMs(): number {
    return this.#budgetMs;
  }

  setTimeout(fn: (...args: never[]) => void, delay = 0, ...args: unknown[]): TimerHandle {
    return this.#schedule("timeout", fn, delay, args);
  }

  setInterval(fn: (...args: never[]) => void, delay = 0, ...args: unknown[]): TimerHandle {
    return this.#schedule("interval", fn, delay, args);
  }

  setImmediate(fn: (...args: never[]) => void, ...args: unknown[]): TimerHandle {
    // Due now, and ordered after anything already due at this instant by the sequence number.
    const handle = this.#schedule("immediate", fn, 0, args);
    return handle;
  }

  clear(handleOrId: TimerHandle | number | undefined): void {
    if (handleOrId === undefined || handleOrId === null) return;
    const id = typeof handleOrId === "number" ? handleOrId : handleOrId.id;
    const index = this.#queue.findIndex((entry) => entry.id === id);
    // Clearing twice, or clearing something that never existed, is a no-op rather than an error, as in Node.
    if (index >= 0) {
      const removed = this.#queue[index];
      if (removed !== undefined) removed.live = false;
      this.#queue.splice(index, 1);
    }
  }

  /** Entries still scheduled. Exposed for tests and evidence, not for user code. */
  get pending(): number {
    return this.#queue.length;
  }

  get penalties(): number {
    return this.#intervalsTruncated;
  }

  /**
   * Runs the queue to termination, then reports why.
   *
   * After each callback the continuation queue is drained: without that, a `setTimeout(() => Promise.resolve().then(print))`
   * would print after the snapshot, which is the exact failure ADR-0013 was written for.
   */
  async drain(): Promise<SchedulerEvidence> {
    if (this.#evidence !== null) return this.#evidence;

    // Predicate and promise continuation order is not something a program controls, so a timer scheduled from inside a
    // continuation can land AFTER the queue looked empty. A single pass therefore missed it: fixture 4 scheduled its timer
    // from a `pipeline` callback, and `timer-ok` never printed. Draining means quiescence, not one pass.
    let stop: SchedulerStop = "queue-empty";
    for (;;) {
      const pass = await this.#drainPass();
      stop = pass;
      if (pass !== "queue-empty") break;
      // Let continuations run, then look again: they may have scheduled more work.
      await drainContinuations();
      if (this.#queue.length === 0) break;
    }

    this.#evidence = Object.freeze({
      stop,
      virtualElapsedMs: this.#virtual,
      realElapsedMs: Date.now() - this.#realStart,
      callbacks: this.#callbacks,
      deferred: this.#queue.length,
      intervalsTruncated: this.#intervalsTruncated,
      callbackErrors: this.#callbackErrors,
      // A truncated interval is also a guard: the program did not finish, our per-interval cap finished it. Leaving it out
      // made a 0 ms interval storm report guarded=false, which reads as a clean run.
      guarded: stop === "callback-limit" || stop === "real-time-limit" || this.#intervalsTruncated > 0,
      unrefPending: this.#unrefPending,
      refsExhausted: stop === "no-refs-left",
    });
    return this.#evidence;
  }

  /** One pass over everything currently queued. */
  async #drainPass(): Promise<SchedulerStop> {
    let stop: SchedulerStop = "queue-empty";

    while (true) {
      const next = this.#earliest();
      if (next === undefined) {
        stop = "queue-empty";
        break;
      }
      // A timer past the budget is deferred, never silently dropped: silence is indistinguishable from a callback that
      // never fired, and the difference matters when a fixture is scored.
      // Node's rule: an unref'd timer still fires when a ref'd handle keeps the loop alive past its due time, but it never
      // keeps the loop alive itself. So the loop is only dead when the next entry is unref'd AND nothing ref'd is due at
      // or before it. Reachable-but-later unref'd timers fire normally.
      const refDue = this.#earliestRefDue();
      // `refDue === Infinity` needs its own test: with no ref'd entry left, `due > Infinity` is false, so the comparison
      // alone would fire exactly the timers this rule exists to skip.
      if (!next.refed && (refDue === Infinity || next.due > refDue)) {
        stop = "no-refs-left";
        this.#unrefPending = this.#queue.length;
        break;
      }
      if (next.due > this.#budgetMs) {
        stop = "budget-exhausted";
        break;
      }
      if (this.#callbacks >= this.#maxCallbacks) {
        stop = "callback-limit";
        break;
      }
      if (Date.now() - this.#realStart > this.#maxRealMs) {
        stop = "real-time-limit";
        break;
      }

      this.#remove(next.id);
      next.live = false;
      // Capture the instant this callback is FOR before rescheduling the interval. Reading `next.due` after the reschedule
      // put the clock one period ahead, so `Date.now()` inside an interval callback reported the NEXT tick: a bug a test
      // caught only because it asserted the elapsed virtual time and not just the output.
      const fireAt = next.due;
      if (next.kind === "interval") {
        next.fires += 1;
        if (next.fires >= next.maxFires) {
          this.#intervalsTruncated += 1;
        } else {
          next.due = fireAt + (next.intervalMs === 0 ? 0 : next.intervalMs);
          next.seq = this.#seq++;
          next.live = true;
          this.#queue.push(next);
        }
      }

      // The clock sits AT the callback's due time while it runs, so Date.now() inside it is the virtual instant, not the
      // instant the scheduler happened to get to it.
      this.#virtual = Math.max(this.#virtual, fireAt);
      this.#callbacks += 1;

      try {
        next.fn(...(next.args as never[]));
      } catch (error) {
        // Node would kill the process here. Killing the run would make one bad callback look like a broken harness, so the
        // error is surfaced to stderr and counted; draining continues deterministically.
        this.#callbackErrors += 1;
        this.#onCallbackError?.(error);
      }
      await drainContinuations();
    }

    return stop;
  }

  /** Evidence after `drain`, or a zeroed record before it (a program that scheduled nothing still reports a stop). */
  get evidence(): SchedulerEvidence {
    return (
      this.#evidence ?? {
        stop: "queue-empty",
        virtualElapsedMs: this.#virtual,
        realElapsedMs: 0,
        callbacks: 0,
        deferred: this.#queue.length,
        intervalsTruncated: this.#intervalsTruncated,
        callbackErrors: 0,
        guarded: false,
        unrefPending: 0,
        refsExhausted: false,
      }
    );
  }

  #schedule(
    kind: "timeout" | "interval" | "immediate",
    fn: (...args: never[]) => void,
    delay: number,
    args: readonly unknown[],
  ): TimerHandle {
    const safeDelay = Number.isFinite(delay) && delay > 0 ? Math.floor(delay) : 0;
    const id = this.#nextId;
    this.#nextId += 1;
    const perIntervalCap = safeDelay === 0 ? this.#maxCallbacks : Math.min(Math.ceil(this.#budgetMs / safeDelay), 100);
    const entry: Entry = {
      id,
      kind,
      due: this.#virtual + (kind === "immediate" ? 0 : safeDelay),
      seq: this.#seq++,
      fn,
      args,
      intervalMs: safeDelay,
      fires: 0,
      maxFires: kind === "interval" ? Math.max(1, perIntervalCap) : 1,
      live: true,
      refed: true,
    };
    this.#queue.push(entry);
    // Real ref semantics, not the stubs that were here. A library that unref's its keep-alive timer expects the process to
    // be able to exit; reporting `hasRef() === true` forever and then draining the timer anyway meant a program that Node
    // exits immediately kept running here and produced output Node never prints.
    const handle: TimerHandle = {
      id,
      kind,
      ref: () => {
        entry.refed = true;
        return handle;
      },
      unref: () => {
        entry.refed = false;
        return handle;
      },
      hasRef: () => entry.refed && entry.live,
    };
    return handle;
  }

  /** Earliest due, ties broken by creation order. Both are integers, so the order cannot depend on machine timing. */
  #earliest(): Entry | undefined {
    let best: Entry | undefined;
    for (const entry of this.#queue) {
      if (best === undefined || entry.due < best.due || (entry.due === best.due && entry.seq < best.seq)) best = entry;
    }
    return best;
  }

  /** Due time of the earliest ref'd entry, or `Infinity` when every remaining timer is unref'd. */
  #earliestRefDue(): number {
    let due = Infinity;
    for (const entry of this.#queue) if (entry.refed && entry.due < due) due = entry.due;
    return due;
  }

  #remove(id: number): void {
    const index = this.#queue.findIndex((entry) => entry.id === id);
    if (index >= 0) this.#queue.splice(index, 1);
  }
}

/**
 * A `Date` whose `now()` and zero-argument constructor report virtual time.
 *
 * A subclass rather than a proxy: user code may `instanceof Date`, pass it to `JSON.stringify`, or call `getTime()`, and a
 * proxy would break every one of those. Only the two ways of reading "the current instant" change.
 */
export function createVirtualDate(now: () => number): DateConstructor {
  class VirtualDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(now());
        return;
      }
      // Mirror Date's own constructor shape: (value) or (year, month, ...components).
      if (args.length === 1) {
        super(args[0] as number);
        return;
      }
      const [first, ...rest] = args as [string | number | Date, ...number[]];
      // Date takes seven components at most: year, month, day, hours, minutes, seconds, ms.
      super(
        first as number,
        rest[0] as number,
        rest[1],
        rest[2],
        rest[3],
        rest[4],
        rest[5],
      );
    }

    static override now(): number {
      return now();
    }
  }
  return VirtualDate as unknown as DateConstructor;
}

/** `performance.now()` on virtual elapsed, with `timeOrigin` agreeing with `Date.now()`. */
export function createVirtualPerformance(scheduler: Scheduler): { now: () => number; timeOrigin: number } {
  return {
    now: () => scheduler.virtualElapsedMs,
    timeOrigin: scheduler.timeOrigin,
  };
}
