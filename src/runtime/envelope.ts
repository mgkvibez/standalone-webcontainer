/**
 * Typed Syscall Envelope — the single request/reply channel crossing the
 * Runtime <-> Worker boundary (ADR-0003, Decision 2; concept per the
 * browsix clean-room abstract in docs/references/).
 *
 * Design rules encoded here:
 * - One envelope shape for every future shim operation (fs, path, ...):
 *   a request is { msgId, op, args }; a reply is { msgId, success,
 *   result | error }. Nothing else crosses the boundary.
 * - Monotonic msgIds + an outstanding-calls map: the caller correlates
 *   replies to requests; the map entry is removed the moment a reply
 *   settles, so no state accumulates on long-lived workers.
 * - Errors cross as structured-cloneable { code, message } records and
 *   are rehydrated into typed errors on the caller side. POSIX-style
 *   codes (ENOENT, EISDIR, ENOSYS, ...) survive the trip.
 * - Transport-agnostic: both sides receive a `post` callback. Wiring
 *   this to a MessagePort (or any clone-capable channel) is the
 *   integrator's one job. Zero DOM APIs: safe in Dedicated Workers.
 * - Results and args must be structured-cloneable; Uint8Array travels
 *   natively, which is what the VFS read/write surface returns.
 *
 * NOTE: the spec's `args: any[]` is tightened to `unknown[]` per the
 * project charter's "no any where avoidable" rule; handlers own their
 * own narrowing.
 */

/** A single shim operation crossing the worker boundary. */
export interface SyscallRequest {
  msgId: number;
  op: string;
  args: unknown[];
}

/** Structured-cloneable error record (never a live Error object). */
export interface SyscallErrorRecord {
  code: string;
  message: string;
}

/** The only reply shape the boundary produces. */
export interface SyscallResponse {
  msgId: number;
  success: boolean;
  result?: unknown;
  error?: SyscallErrorRecord;
}

/** Fallback POSIX-ish code when a thrown error carries no code. */
export const UNKNOWN_ERROR_CODE = "EUNKNOWN";
/** POSIX code for an operation the kernel does not implement. */
export const UNIMPLEMENTED_ERROR_CODE = "ENOSYS";

/** A settled call's resolver pair, held while a request is in flight. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * msgId -> resolver registry. Registers a promise resolver per in-flight
 * call and removes it when the response settles, so slow or lost replies
 * can never accumulate stale entries across a worker's lifetime.
 */
export class OutstandingCallsMap {
  #calls = new Map<number, PendingCall>();

  register(msgId: number, resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
    this.#calls.set(msgId, { resolve, reject });
  }

  /**
   * Remove and return the pending call for `msgId`. A reply for an
   * unknown msgId (e.g. arriving after dispose) returns undefined and
   * is the caller's signal to ignore it silently.
   */
  take(msgId: number): PendingCall | undefined {
    const call = this.#calls.get(msgId);
    if (call !== undefined) {
      this.#calls.delete(msgId);
    }
    return call;
  }

  /** Reject every pending call (teardown), leaving the map empty. */
  rejectAll(reason: unknown): void {
    for (const call of this.#calls.values()) {
      call.reject(reason);
    }
    this.#calls.clear();
  }

  get size(): number {
    return this.#calls.size;
  }
}

/**
 * Typed error rehydrated on the caller side. Carries the POSIX-style
 * `code` from the worker (e.g. ENOENT from the VFS) so shim code can
 * branch on `err.code` exactly like Node code does.
 */
export class SyscallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SyscallError";
    this.code = code;
  }
}

/** Caller side: rehydrate a serialized error record into a typed error. */
export function rehydrateError(error: SyscallErrorRecord): SyscallError {
  return new SyscallError(error.code, error.message);
}

/** Worker side: flatten a thrown error into a cloneable record. */
export function serializeError(error: unknown): SyscallErrorRecord {
  if (error instanceof Error) {
    // WHY the guarded code pick: our VFS errors carry POSIX codes; plain
    // Errors (e.g. TypeError from a bad argument) fall back to EUNKNOWN
    // rather than inventing a code the caller did not throw.
    const maybeCode = (error as { code?: unknown }).code;
    return {
      code: typeof maybeCode === "string" ? maybeCode : UNKNOWN_ERROR_CODE,
      message: error.message,
    };
  }
  return { code: UNKNOWN_ERROR_CODE, message: String(error) };
}

/** Caller side of the envelope: `call(op, ...args)` -> Promise. */
export class SyscallClient {
  readonly #outstanding = new OutstandingCallsMap();
  readonly #post: (request: SyscallRequest) => void;
  #nextMsgId = 1;

  constructor(post: (request: SyscallRequest) => void) {
    this.#post = post;
  }

  /** Issue a syscall; resolves with the worker's `result`. */
  call(op: string, ...args: unknown[]): Promise<unknown> {
    const msgId = this.#nextMsgId;
    this.#nextMsgId += 1;
    return new Promise((resolve, reject) => {
      this.#outstanding.register(msgId, resolve, reject);
      this.#post({ msgId, op, args });
    });
  }

  /**
   * Feed one reply. Unknown msgIds (stale replies racing a dispose) are
   * ignored by contract: a dead call must never crash the caller.
   */
  handleResponse(response: SyscallResponse): void {
    const call = this.#outstanding.take(response.msgId);
    if (call === undefined) {
      return;
    }
    if (response.success) {
      call.resolve(response.result);
    } else {
      call.reject(rehydrateError(response.error ?? { code: UNKNOWN_ERROR_CODE, message: "malformed response" }));
    }
  }

  /** Reject all in-flight calls (worker teardown). */
  dispose(): void {
    this.#outstanding.rejectAll(new SyscallError(UNKNOWN_ERROR_CODE, "syscall envelope disposed"));
  }

  /** In-flight count (observability; also exercised by tests). */
  get pending(): number {
    return this.#outstanding.size;
  }
}

/** A single operation implementation, worker side. */
export type SyscallHandler = (...args: never[]) => unknown | Promise<unknown>;
// ^ `never[]` keeps call sites variance-safe while `call`'s `unknown[]`
//   remains the wire type; handlers narrow their own arguments.

/**
 * Worker side of the envelope: an op -> handler table that executes
 * operations and produces structured-cloneable responses. The kernel
 * never blocks: handlers may return promises, and the reply is posted
 * whenever the work completes (continuation discipline, ADR-0003 #2).
 */
export class SyscallKernel {
  readonly #handlers = new Map<string, (...args: never[]) => unknown>();

  register(op: string, handler: (...args: never[]) => unknown): void {
    this.#handlers.set(op, handler);
  }

  /** Process one request and produce its response (cloneable). */
  async handle(request: SyscallRequest): Promise<SyscallResponse> {
    const handler = this.#handlers.get(request.op);
    if (handler === undefined) {
      // WHY ENOSYS: the surface is fixed; an op outside it is a missing
      // implementation, exactly the case the shim layer reports.
      return {
        msgId: request.msgId,
        success: false,
        error: { code: UNIMPLEMENTED_ERROR_CODE, message: `syscall not implemented: ${request.op}` },
      };
    }
    try {
      const result = await handler(...(request.args as never[]));
      return { msgId: request.msgId, success: true, result };
    } catch (error) {
      return { msgId: request.msgId, success: false, error: serializeError(error) };
    }
  }

  /**
   * Bind the kernel to a post callback; returns the function an
   * integrator wires to a MessagePort's `onmessage`. Responses are
   * posted only after handlers settle — never synchronously inline.
   */
  attach(post: (response: SyscallResponse) => void): (request: SyscallRequest) => void {
    return (request: SyscallRequest) => {
      void this.handle(request).then(post);
    };
  }
}
