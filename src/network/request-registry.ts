/**
 * In-flight request bookkeeping, with the one property both reference implementations lacked.
 *
 * Both OpenWebContainer and labour keep a map from request id to a resolver and delete the entry only
 * when the reply arrives. If the worker dies, wedges, or simply never answers, the promise stays
 * pending forever: the preview hangs with no error and no timeout, and from the outside that is
 * indistinguishable from a slow request (see docs/references/discovery-labor-openwebcontainer.md §5
 * and discovery-stackblitz-public.md §2). Two independent projects, the same hole.
 *
 * So every entry here carries a deadline, and `reap` settles the ones that expired. Three rules make
 * that trustworthy rather than decorative:
 *
 * 1. The clock is injected. `now` is a parameter, never `Date.now()` inside, so a timeout test is
 *    deterministic instead of sleeping and hoping.
 * 2. Settling is idempotent. A reply that arrives after reaping is ignored rather than throwing,
 *    because a late reply is a normal race, not a bug in the caller.
 * 3. Reaping reports what it killed. A timeout nobody can name in a log is a timeout nobody can fix.
 */

/** Raised into a pending caller when its deadline passes. Modelled on a DOM abort reason. */
export class RequestTimeoutError extends Error {
  public readonly code = "ETIMEDOUT";
  public readonly requestId: string;

  constructor(requestId: string, elapsedMs: number) {
    super(`request ${requestId} timed out after ${elapsedMs}ms`);
    this.name = "RequestTimeoutError";
    this.requestId = requestId;
  }
}

export interface PendingRequest<T> {
  readonly id: string;
  readonly deadlineMs: number;
  readonly settled: Promise<T>;
}

interface Entry<T> {
  readonly id: string;
  readonly deadline: number;
  readonly openedAt: number;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export interface OpenOptions {
  /** Absolute deadline in the caller's clock, not a duration: durations drift when you re-read the clock. */
  readonly deadline: number;
  /**
   * The caller's current time, in the same clock as `deadline`.
   *
   * Required rather than read from `Date.now()` here, for two reasons: a test can then expire a request
   * without sleeping, and `reap` can report how long a request was allowed to live without keeping a
   * second hidden clock that could disagree with the caller's.
   */
  readonly now: number;
}

export interface ReapResult {
  readonly id: string;
  readonly elapsedMs: number;
}

/**
 * A bounded registry of requests that are waiting for something. `T` is whatever a reply looks like;
 * this module never interprets it.
 */
export class RequestRegistry<T> {
  readonly #entries = new Map<string, Entry<T>>();
  #nextId = 1;

  /** Open a request. The returned promise settles on reply, rejection, or reaping. */
  open(options: OpenOptions): PendingRequest<T> {
    const id = String(this.#nextId++);
    return this.openWithId(id, options);
  }

  /** Open under a caller-chosen id, for protocols where the id arrives from outside. */
  openWithId(id: string, options: OpenOptions): PendingRequest<T> {
    if (this.#entries.has(id)) throw new Error(`request id ${id} is already pending`);
    if (!Number.isFinite(options.deadline)) throw new Error("deadline must be a finite number");
    if (!Number.isFinite(options.now)) throw new Error("now must be a finite number");

    let resolveFn!: (value: T) => void;
    let rejectFn!: (reason: unknown) => void;
    const settled = new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.#entries.set(id, {
      id,
      deadline: options.deadline,
      openedAt: options.now,
      resolve: resolveFn,
      reject: rejectFn,
    });
    return { id, deadlineMs: options.deadline, settled };
  }

  /**
   * Deliver a reply. Returns false when the id is unknown, which includes the ordinary case of a reply
   * arriving after the request was reaped: the caller has already been told it timed out, so a second
   * answer must not be invented.
   */
  settle(id: string, value: T): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    entry.resolve(value);
    return true;
  }

  /** Fail a request for a reason other than its deadline. Same late-arrival rule as `settle`. */
  fail(id: string, reason: unknown): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    entry.reject(reason);
    return true;
  }

  /**
   * Settle every request whose deadline is at or before `now`, and say which ones.
   *
   * `<=` rather than `<` matters: a deadline exactly equal to now is expired, and a clock that ticks in
   * whole milliseconds would otherwise let an entry survive one extra pass.
   */
  reap(now: number): readonly ReapResult[] {
    const expired: ReapResult[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.deadline > now) continue;
      this.#entries.delete(entry.id);
      const elapsedMs = entry.deadline - entry.openedAt;
      entry.reject(new RequestTimeoutError(entry.id, elapsedMs));
      expired.push({ id: entry.id, elapsedMs });
    }
    return expired.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** How many requests are currently in flight. Used by the liveness check and by tests. */
  get size(): number {
    return this.#entries.size;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /**
   * Fail everything and return the ids. Teardown must not leave a caller awaiting a promise that can
   * never settle: that is the same liveness hole at a larger granularity.
   */
  closeAll(reason: unknown): readonly string[] {
    const ids = [...this.#entries.keys()].sort();
    for (const id of ids) this.fail(id, reason);
    return ids;
  }
}
