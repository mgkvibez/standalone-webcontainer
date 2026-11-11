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
/** How often a drain with outstanding handles checks whether anything happened. Real milliseconds. */
export const DEFAULT_KEEP_ALIVE_POLL_MS = 10;

/**
 * The allowance for ONE served request, which is a different thing from one execution.
 *
 * The execution guards above bound a program body: a second of virtual time, ten thousand callbacks, five real seconds. A server is
 * running for as long as somebody keeps asking, so those ceilings cannot apply to the work a request makes it do, and a fresh
 * accounting per request is the only shape that both bounds a stuck request and lets a long-lived server serve.
 *
 * The real ceiling sits under the gateway's own 30 s deadline on purpose: a pump that outlives the deadline would report work the
 * client has already given up on.
 */
export const DEFAULT_PUMP_VIRTUAL_MS = 60_000;
export const DEFAULT_PUMP_CALLBACKS = 200_000;
export const DEFAULT_PUMP_REAL_MS = 20_000;

/** What one pump is allowed to spend. Every field is a ceiling on the pump's own accounting, not on the program's. */
export interface PumpLimits {
  readonly maxVirtualMs?: number;
  readonly maxCallbacks?: number;
  readonly maxRealMs?: number;
}

/** The resolved pump scope: what `#drainPass` reads its ceilings from while a request is outstanding. */
interface PumpScope {
  readonly virtualStart: number;
  readonly callbacksStart: number;
  readonly realStart: number;
  readonly limits: Required<PumpLimits>;
  /** Whether the request this pump serves has been answered. A settled request ends the pass rather than finishing the queue. */
  readonly settled: () => boolean;
}

export interface SchedulerLimits {
  readonly budgetMs?: number;
  readonly maxCallbacks?: number;
  readonly maxRealMs?: number;
  /**
   * How many live handles are still waiting on something the timer queue cannot see, such as an open filesystem watcher.
   *
   * Node exits when the loop empties, and an open watcher is a ref'd handle, so a program that watches stays alive. Without
   * this the loop would finish the instant a program stopped scheduling timers, and a watcher would be silently pointless.
   * The count is polled rather than pushed: the scheduler owns no knowledge of what a handle is.
   */
  readonly keepAlive?: () => number;
  /** How long to wait between checks while handles are outstanding. Real milliseconds, not virtual. */
  readonly keepAlivePollMs?: number;
}

/** Why draining stopped. Exactly one applies to any execution. */
export type SchedulerStop =
  | "queue-empty"
  | "budget-exhausted"
  | "callback-limit"
  | "real-time-limit"
  /** Every timer left is unref'd, so nothing keeps the loop alive: Node exits here and the timers never fire. */
  | "no-refs-left"
  /**
   * Something outside the queue ended the program (`process.exit` from an input handler, or a kill). Node's exit is immediate:
   * no timer queued before it may still run, so this stops the pass rather than draining the remainder.
   */
  | "aborted";

export interface SchedulerEvidence {
  readonly stop: SchedulerStop;
  /** Virtual milliseconds elapsed: scheduled time, NOT execution time. */
  readonly virtualElapsedMs: number;
  /** Real milliseconds the queue actually consumed. Reported separately, and never presented as virtual. */
  readonly realElapsedMs: number;
  /** Of `realElapsedMs`, the part spent waiting for an outside handle (input, a watcher). Excluded from the runaway guard. */
  readonly idleMs: number;
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

/**
 * Lets every pending continuation run, by crossing one macrotask boundary.
 *
 * The rule encoded here is Node's: the microtask queue is drained to exhaustion before the next macrotask runs. Two `await Promise.resolve()`
 * hops were a guess at the depth of a chain, and a measured wrong one: a `.then` whose callback returns another `.then` keeps queueing
 * continuations, so `setTimeout(() => Promise.resolve().then(..).then(..).then(..))` printed all three links in Node and only the first here
 * (differential case `chained-then-from-timer`). Only a macrotask boundary guarantees the queue is empty; a hop count can approximate it and
 * silently truncate anything deeper.
 *
 * `MessageChannel` rather than a 0 ms timer wherever it exists: this runs on every drain pass, and a Worker clamps timers to a few
 * milliseconds per hop. A message event is a macrotask in both a page and a Worker, so it drains microtasks without the clamp.
 */
async function drainContinuations(): Promise<void> {
  const Channel = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
  if (Channel !== undefined) {
    await new Promise<void>((resolve) => {
      const channel = new Channel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
  #aborted = false;
  /**
   * Real milliseconds spent waiting for an outside handle rather than running code.
   *
   * The real-time guard exists to catch a program that spins, and a program waiting for a keystroke is not spinning. Counting
   * that wait would have killed every interactive program five seconds after it asked its first question.
   */
  #idleWaitMs = 0;
  /**
   * When the current idle stretch began, or null when the program is not idle.
   *
   * The stretch has to start before the poll rather than at it: the loop also does bookkeeping between polls (a drain pass, a
   * continuation drain, the guard check itself), and charging that to the program made a program that only waits die of a budget
   * it never spent. Measured: a 5 ms ceiling over a 120 ms wait tripped on 2 of 3 local runs with `idle 61 real 67` in the
   * evidence, and this is a CI-only failure only because a slower machine crosses the line sooner.
   */
  #idleStart: number | null = null;
  #callbackErrors = 0;
  #evidence: SchedulerEvidence | null = null;
  readonly #onCallbackError: ((error: unknown) => void) | undefined;
  readonly #keepAlive: (() => number) | undefined;
  readonly #keepAlivePollMs: number;
  /**
   * The pump in progress, or null when the execution guards are the ones that apply.
   *
   * While this is set, `#drainPass` measures against the pump's own ceilings: the program is a long-lived server now, so its
   * execution budget has long since been spent on the program body and reusing it would refuse the first request.
   */
  #pump: PumpScope | null = null;

  constructor(limits: SchedulerLimits = {}, onCallbackError?: (error: unknown) => void) {
    this.#budgetMs = limits.budgetMs ?? DEFAULT_VIRTUAL_BUDGET_MS;
    this.#maxCallbacks = limits.maxCallbacks ?? DEFAULT_MAX_CALLBACKS;
    this.#maxRealMs = limits.maxRealMs ?? DEFAULT_MAX_REAL_MS;
    this.#baselineEpoch = Date.now();
    this.#realStart = Date.now();
    this.#onCallbackError = onCallbackError;
    this.#keepAlive = limits.keepAlive;
    this.#keepAlivePollMs = limits.keepAlivePollMs ?? DEFAULT_KEEP_ALIVE_POLL_MS;
  }

  /**
   * End this execution from outside the queue. Idempotent, and safe to call from a callback or from an input handler.
   *
   * The scheduler is not told why, because it does not need to know: it stops the pass, leaves pending work unrun, and reports
   * `aborted`. Whoever asked decides what the exit code means.
   */
  abort(): void {
    this.#aborted = true;
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
  /** Idle milliseconds including the stretch in progress, so a check mid-wait does not under-count. */
  #idleTotal(now: number = Date.now()): number {
    return this.#idleWaitMs + (this.#idleStart === null ? 0 : now - this.#idleStart);
  }

  /** Folds the idle stretch in progress into the total. Called whenever real work is about to run, and before reporting. */
  #chargeIdle(): void {
    if (this.#idleStart === null) return;
    this.#idleWaitMs += Date.now() - this.#idleStart;
    this.#idleStart = null;
  }

  /**
   * Runs the timer queue while an asynchronous ENTRY body is still evaluating.
   *
   * Node waits for an entry module's evaluation before the program counts as started, and a body suspended at an `await` is frequently waiting on
   * work only this queue can perform. Measured: an entry whose body is `await new Promise((resolve) => setTimeout(resolve, 5))` deadlocked here,
   * because the runner awaited a promise whose only resolver was a timer nothing would run, and the run ended at its timeout with no output at all.
   *
   * Deliberately not memoized. `drain` caches its evidence because it is the accounting for the whole execution, and this stops as soon as the
   * body settles, so caching here would hide the timers the body's own last statements scheduled. The runner still calls `drain` afterwards and
   * that call does the normal accounting.
   *
   * Termination follows Node rather than a guess: the loop stops when the body has settled and nothing is queued, when a guard fires, or when the
   * queue is empty, nothing outside the queue is in flight, and the body is still suspended after the real event loop has had a turn. That last case
   * is Node's own behaviour, where a process exits with an unresolved entry promise once its loop is empty.
   *
   * The returned stop reason exists so the runner can tell those two endings apart. A body that never settled is a program that did not finish, and
   * reporting it as exit 0 is the same silent green this scheduler's guards exist to prevent: measured on `vite build`, which awaited a wasm
   * instantiation, was declared finished, and reported success for a build that emitted nothing.
   */
  async drainWhile(evaluation: Promise<void>): Promise<{ readonly stop: SchedulerStop; readonly settled: boolean }> {
    let settled = false;
    let rejection: { error: unknown } | undefined;
    void evaluation.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        rejection = { error };
      },
    );

    let stop: SchedulerStop = "queue-empty";
    for (;;) {
      if (this.#aborted) {
        stop = "aborted";
        break;
      }
      const pass = await this.#drainPass();
      // A pass that ended on a guard ended this loop too: continuing would run exactly the work the guard exists to stop. `"settled"` is a
      // request-bound ending and cannot arrive here, because this loop holds no pump; the guard is a type narrowing, not a runtime branch.
      if (pass !== "queue-empty" && pass !== "settled") {
        stop = pass;
        break;
      }
      await drainContinuations();
      if (settled && this.#queue.length === 0) break;
      if (this.#queue.length > 0) continue;

      // Nothing of ours is queued and the body is still suspended. Outside work that settles on a real thread (a wasm instantiation, an open
      // handle) is work this body is waiting for, and the whole point is to keep the process alive until it lands, exactly as Node does while a
      // libuv handle is ref'd. Without this the loop gave up after a single real turn, which is how `await esbuild.build(...)` became "exit 0,
      // no output": esbuild's service is a Go program on a WebAssembly.Module, instantiated on another thread.
      const outstanding = this.#keepAlive === undefined ? 0 : this.#keepAlive();
      if (outstanding > 0) {
        if (this.#idleStart === null) this.#idleStart = Date.now();
        if (Date.now() - this.#realStart - this.#idleTotal() > this.#maxRealMs) {
          // Outside work that never lands is a hung program, not a finished one. This is the same ceiling `drain` applies, for the same reason:
          // waiting on the world is not the program working, so the wall clock is the only honest limit on it.
          stop = "real-time-limit";
          this.#chargeIdle();
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.#keepAlivePollMs);
        });
        continue;
      }

      // Nothing queued and nothing in flight: one real turn lets work this runtime cannot see (a dynamic import settling) make progress; if
      // neither that nor a new timer appears, this queue has nothing left to offer and the body will never be resumed.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (this.#queue.length === 0) break;
    }

    this.#chargeIdle();
    if (rejection !== undefined) throw rejection.error;
    return { stop, settled };
  }

  /**
   * Runs this queue while an outside promise - one served HTTP request - is outstanding.
   *
   * THE DEFECT THIS EXISTS FOR, MEASURED. A server that outlives its program is the shape this runtime documents: `vite dev` exits 0,
   * the container marks the process "running" with its ports, and the preview gateway keeps routing to it. But the timer queue is only
   * pumped while a run is in progress, so once the program body returned, nothing advanced it again. A request handler that awaited
   * `setTimeout(..., 10)` therefore never answered, and neither did one that awaited `setTimeout(..., 0)`:
   *
   *   GET /?wait=10 -> no response in 6 s      GET /?wait=0 -> no response in 6 s      pendingAsyncWork: 0
   *
   * That is not cosmetic. Vite's dependency optimizer - the whole of `optimizeDeps`, which every dev server runs for a bare import -
   * is asynchronous work behind such a request, so `import pc from "picocolors"` produced a rewritten specifier pointing at a file
   * that could never be generated, and the request hung until the gateway's deadline.
   *
   * WHAT IT IS NOT. It does not make the program immortal: it stops when the request settles, when a pump guard fires, or when the
   * queue is empty and nothing outside it is in flight. It does not reset the program's clock, because virtual time is what
   * `Date.now()` reports inside the server and moving it backwards would be a lie the server could feel.
   *
   * ONE PUMP AT A TIME. Two loops over one queue would interleave callbacks in an order nobody wrote, so a nested call refuses
   * instead of pretending to share. The runtime serialises requests before reaching here.
   */
  async pumpWhile(pending: Promise<unknown>, limits: PumpLimits = {}): Promise<SchedulerStop> {
    if (this.#pump !== null) return "aborted";

    let settled = false;
    void Promise.resolve(pending).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const scope: PumpScope = {
      virtualStart: this.#virtual,
      callbacksStart: this.#callbacks,
      realStart: Date.now(),
      limits: {
        maxVirtualMs: limits.maxVirtualMs ?? DEFAULT_PUMP_VIRTUAL_MS,
        maxCallbacks: limits.maxCallbacks ?? DEFAULT_PUMP_CALLBACKS,
        maxRealMs: limits.maxRealMs ?? DEFAULT_PUMP_REAL_MS,
      },
      settled: () => settled,
    };
    this.#pump = scope;

    let stop: SchedulerStop = "queue-empty";
    try {
      for (;;) {
        if (this.#aborted) {
          stop = "aborted";
          break;
        }
        const pass = await this.#drainPass();
        if (pass === "settled") {
          // The pass stopped because the response went out. Nothing was exhausted and nothing was refused, so this is the ordinary ending of a
          // request that its handler answered before the queue ran dry.
          stop = "queue-empty";
          break;
        }
        if (pass !== "queue-empty") {
          stop = pass;
          break;
        }
        await drainContinuations();
        // The response has been written. Whatever the server queued for later is the next request's problem, and running it here
        // would charge this request for the server's whole life.
        if (settled) break;
        if (this.#queue.length > 0) continue;

        const outstanding = this.#keepAlive === undefined ? 0 : this.#keepAlive();
        const elapsed = Date.now() - scope.realStart;
        if (elapsed > scope.limits.maxRealMs) {
          stop = "real-time-limit";
          break;
        }
        // A turn of the real event loop is what lets work this runtime cannot see make progress: a wasm instantiation settling,
        // a dynamic import resolving. With something in flight that is a wait worth polling; with nothing in flight it is the
        // only chance the request has left, so it is taken exactly as often as the ceiling allows.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, outstanding > 0 ? this.#keepAlivePollMs : 0);
        });
      }
    } finally {
      this.#pump = null;
    }

    return stop;
  }

  async drain(): Promise<SchedulerEvidence> {
    if (this.#evidence !== null) return this.#evidence;

    // Predicate and promise continuation order is not something a program controls, so a timer scheduled from inside a
    // continuation can land AFTER the queue looked empty. A single pass therefore missed it: fixture 4 scheduled its timer
    // from a `pipeline` callback, and `timer-ok` never printed. Draining means quiescence, not one pass.
    let stop: SchedulerStop = "queue-empty";
    for (;;) {
      const pass = await this.#drainPass();
      if (pass !== "settled") stop = pass;
      if (pass !== "queue-empty") break;
      // Let continuations run, then look again: they may have scheduled more work.
      await drainContinuations();
      if (this.#queue.length === 0) {
        // Nothing to run, but an open handle may still be waiting on the outside world: stay alive, re-check, and let the
        // real-time guard end a program that watches forever rather than exiting behind its back.
        const outstanding = this.#keepAlive === undefined ? 0 : this.#keepAlive();
        if (outstanding > 0) {
          // The stretch starts at the first moment the loop finds nothing to do, and covers everything until work resumes:
          // the poll, and the bookkeeping around it.
          if (this.#idleStart === null) this.#idleStart = Date.now();
          if (Date.now() - this.#realStart - this.#idleTotal() > this.#maxRealMs) {
            stop = "real-time-limit";
            this.#chargeIdle();
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, this.#keepAlivePollMs);
          });
          // Waiting for the outside world is not the program working, so it does not count against the runaway guard. Without
          // this, every interactive program died five seconds after asking its first question.
          continue;
        }
        break;
      }
    }

    this.#chargeIdle();
    this.#evidence = Object.freeze({
      stop,
      virtualElapsedMs: this.#virtual,
      realElapsedMs: Date.now() - this.#realStart,
      idleMs: this.#idleWaitMs,
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
  async #drainPass(): Promise<SchedulerStop | "settled"> {
    let stop: SchedulerStop = "queue-empty";

    while (true) {
      if (this.#aborted) {
        stop = "aborted";
        break;
      }
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
      // The ceilings are the execution's during a run and the pump's while a request is being served. One set of checks, two
      // accountings: duplicating the pass would let the two drift, which is the class of bug this file keeps meeting.
      const budgetCeiling = this.#pump === null ? this.#budgetMs : this.#pump.virtualStart + this.#pump.limits.maxVirtualMs;
      if (next.due > budgetCeiling) {
        stop = "budget-exhausted";
        break;
      }
      const callbackCeiling = this.#pump === null ? this.#maxCallbacks : this.#pump.callbacksStart + this.#pump.limits.maxCallbacks;
      if (this.#callbacks >= callbackCeiling) {
        stop = "callback-limit";
        break;
      }
      const realStart = this.#pump === null ? this.#realStart : this.#pump.realStart;
      // Idle time is not charged to a pump: a request waiting on the outside world is bounded by the request's own deadline,
      // and the stretch bookkeeping exists for a program body that would otherwise look like it had spin.
      const realSpent = Date.now() - realStart - (this.#pump === null ? this.#idleTotal() : 0);
      const realCeiling = this.#pump === null ? this.#maxRealMs : this.#pump.limits.maxRealMs;
      if (realSpent > realCeiling) {
        stop = "real-time-limit";
        if (this.#pump === null) this.#chargeIdle();
        break;
      }

      // Real work is about to run, so the idle stretch ends here rather than at the next poll.
      this.#chargeIdle();
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
      // A request-bound pass stops the moment its request has been answered, even with work still queued. That work was queued for the server's
      // future, and running it here would charge this request for a life it does not own. Only a pump can be told to stop this way: a program body
      // has no request to settle and must drain its queue the way Node does.
      if (this.#pump !== null && this.#pump.settled()) return "settled";
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
      idleMs: 0,
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
