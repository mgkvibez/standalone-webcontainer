/**
 * The synchronous syscall channel.
 *
 * ADR-0018 gives each process its own Worker and a kernel Worker that owns the filesystem, the process table and the
 * port registry. A process Worker must be able to make a *blocking* call, because `fs.readFileSync` cannot return a
 * promise: the calling frame has to stop until the answer exists. The only portable way to stop one Worker while another
 * runs is `SharedArrayBuffer` plus `Atomics.wait`.
 *
 * That is why this module exists at all, and why it could not be written before now: `SharedArrayBuffer` requires
 * `crossOriginIsolated`, which requires COOP/COEP, which the isolation commit added. In a browser that is not isolated,
 * `SharedArrayBuffer` is not even a constructor.
 *
 * Protocol, deliberately small:
 *
 *   header (16 Int32, 64 bytes)
 *     0  state      0 idle | 1 request pending | 2 response pending | 3 closed
 *     1  request length in bytes
 *     2  response length in bytes
 *     3  sequence number of the request in flight
 *     4  last error code (see CHANNEL_ERROR)
 *
 *   request region   fixed capacity, JSON
 *   response region  fixed capacity, JSON
 *
 * One call in flight at a time per channel. That is not a limitation to remove later: a blocked Worker can only be
 * waiting on one thing, so a queue would be dead weight. Parallel work is separate channels, which is what one channel
 * per process already gives us.
 *
 * Liveness is part of the protocol, not an afterthought (ADR-0003): every wait carries a deadline, and a deadline that
 * expires leaves the channel usable instead of wedged, because a wedged channel takes the kernel down with it.
 *
 * Known limits, stated rather than hidden:
 * - Payloads are JSON, so binary bodies travel base64-encoded (33% overhead). A binary side-channel is a later step.
 * - Capacities are fixed at allocation, and an oversized payload throws instead of truncating.
 * - This module does not decide *which* calls are synchronous. ADR-0018 leaves that open on purpose.
 */

export const CHANNEL_STATE = {
  idle: 0,
  requestPending: 1,
  responsePending: 2,
  closed: 3,
} as const;

export const CHANNEL_ERROR = {
  none: 0,
  timeout: 1,
  tooLarge: 2,
  closed: 3,
  malformed: 4,
} as const;

const HEADER_INTS = 16;
const HEADER_BYTES = HEADER_INTS * 4;

const IDX_STATE = 0;
const IDX_REQUEST_LENGTH = 1;
const IDX_RESPONSE_LENGTH = 2;
const IDX_SEQUENCE = 3;
const IDX_ERROR = 4;

export interface ChannelSizes {
  /** Capacity of one encoded request, in bytes. */
  readonly requestBytes: number;
  /** Capacity of one encoded response, in bytes. */
  readonly responseBytes: number;
}

export interface ChannelAllocation {
  readonly buffer: SharedArrayBuffer;
  readonly sizes: ChannelSizes;
}

export interface CallOptions {
  /** Hard deadline. Expiry throws `SyscallTimeoutError` and leaves the channel usable. */
  readonly timeoutMs: number;
}

/** A call that failed because the kernel answered with an error rather than a value. */
export class SyscallRejectedError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SyscallRejectedError";
    this.code = code;
  }
}

/** A call that failed because no answer arrived before its deadline. */
export class SyscallTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly sequence: number;

  constructor(timeoutMs: number, sequence: number) {
    super(`Syscall ${sequence} did not answer within ${timeoutMs} ms.`);
    this.name = "SyscallTimeoutError";
    this.timeoutMs = timeoutMs;
    this.sequence = sequence;
  }
}

/** A payload that does not fit the region it was allocated. Never truncated: a short response is worse than a failure. */
export class SyscallCapacityError extends Error {
  constructor(kind: "request" | "response", size: number, capacity: number) {
    super(`${kind} payload is ${size} bytes, which exceeds its ${capacity}-byte region.`);
    this.name = "SyscallCapacityError";
  }
}

export class SyscallChannelClosedError extends Error {
  constructor() {
    super("Syscall channel is closed.");
    this.name = "SyscallChannelClosedError";
  }
}

const align4 = (value: number): number => Math.ceil(value / 4) * 4;

/** Allocate the shared buffer both ends attach to. The same `SharedArrayBuffer` must reach both Workers. */
export function allocateChannel(sizes: ChannelSizes): ChannelAllocation {
  if (sizes.requestBytes <= 0 || sizes.responseBytes <= 0) {
    throw new RangeError("Channel regions must both be positive.");
  }
  const requestBytes = align4(sizes.requestBytes);
  const responseBytes = align4(sizes.responseBytes);
  const total = HEADER_BYTES + requestBytes + responseBytes;
  return {
    buffer: new SharedArrayBuffer(total),
    sizes: { requestBytes, responseBytes },
  };
}

interface Encoding {
  readonly encode: (value: unknown) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => unknown;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const jsonEncoding: Encoding = {
  encode: (value) => textEncoder.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(textDecoder.decode(bytes)) as unknown,
};

/**
 * The process side: writes a request, blocks until the response arrives or the deadline expires.
 *
 * `Atomics.wait` is only legal in a Worker, which is exactly where this class is used. Calling it from a page's main
 * thread throws, and that is not a limitation to work around: the design intent is that user code never runs there.
 */
export class SyscallClient {
  readonly #header: Int32Array;
  readonly #request: Uint8Array;
  readonly #response: Uint8Array;
  readonly #encoding: Encoding;
  #sequence = 0;

  constructor(allocation: ChannelAllocation, encoding: Encoding = jsonEncoding) {
    const { buffer, sizes } = allocation;
    this.#header = new Int32Array(buffer, 0, HEADER_INTS);
    this.#request = new Uint8Array(buffer, HEADER_BYTES, sizes.requestBytes);
    this.#response = new Uint8Array(buffer, HEADER_BYTES + sizes.requestBytes, sizes.responseBytes);
    this.#encoding = encoding;
  }

  get sequence(): number {
    return this.#sequence;
  }

  /** Make one blocking call. Returns the decoded value the kernel produced. */
  call(request: unknown, options: CallOptions): unknown {
    if (Atomics.load(this.#header, IDX_STATE) === CHANNEL_STATE.closed) throw new SyscallChannelClosedError();
    if (options.timeoutMs <= 0) throw new RangeError("A syscall needs a positive deadline.");

    const payload = this.#encoding.encode(request);
    if (payload.byteLength > this.#request.byteLength) {
      Atomics.store(this.#header, IDX_ERROR, CHANNEL_ERROR.tooLarge);
      throw new SyscallCapacityError("request", payload.byteLength, this.#request.byteLength);
    }

    this.#request.set(payload);
    this.#sequence += 1;
    Atomics.store(this.#header, IDX_REQUEST_LENGTH, payload.byteLength);
    Atomics.store(this.#header, IDX_SEQUENCE, this.#sequence);
    Atomics.store(this.#header, IDX_ERROR, CHANNEL_ERROR.none);
    Atomics.store(this.#header, IDX_STATE, CHANNEL_STATE.requestPending);
    Atomics.notify(this.#header, IDX_STATE);

    const outcome = Atomics.wait(this.#header, IDX_STATE, CHANNEL_STATE.requestPending, options.timeoutMs);
    if (outcome === "timed-out") {
      // Recover rather than wedge: a channel stuck in "request pending" would make every later call time out too, and a
      // late response is discarded by the sequence check below.
      Atomics.store(this.#header, IDX_STATE, CHANNEL_STATE.idle);
      Atomics.store(this.#header, IDX_ERROR, CHANNEL_ERROR.timeout);
      Atomics.notify(this.#header, IDX_STATE);
      throw new SyscallTimeoutError(options.timeoutMs, this.#sequence);
    }

    const state = Atomics.load(this.#header, IDX_STATE);
    if (state === CHANNEL_STATE.closed) throw new SyscallChannelClosedError();

    const respondedSequence = Atomics.load(this.#header, IDX_SEQUENCE);
    if (respondedSequence !== this.#sequence) {
      // A reply for an earlier, abandoned call. Treat it as a timeout rather than returning another call's answer.
      Atomics.store(this.#header, IDX_STATE, CHANNEL_STATE.idle);
      throw new SyscallTimeoutError(options.timeoutMs, this.#sequence);
    }

    const length = Atomics.load(this.#header, IDX_RESPONSE_LENGTH);
    const bytes = this.#response.slice(0, length);
    Atomics.store(this.#header, IDX_STATE, CHANNEL_STATE.idle);
    Atomics.notify(this.#header, IDX_STATE);

    const decoded = this.#encoding.decode(bytes) as { readonly ok?: boolean; readonly value?: unknown; readonly error?: { readonly message?: string; readonly code?: string } };
    if (decoded.ok === false) {
      const message = decoded.error?.message ?? "Kernel rejected the call without a message.";
      throw new SyscallRejectedError(message, decoded.error?.code);
    }
    return decoded.value;
  }

  /** Tell the other end that no further calls are coming, so a waiting kernel Worker can exit instead of blocking. */
  close(): void {
    Atomics.store(this.#header, IDX_STATE, CHANNEL_STATE.closed);
    Atomics.notify(this.#header, IDX_STATE);
  }
}

export interface ServeOptions {
  /** How long to wait for the next request before giving up. A kernel between processes should use a short value. */
  readonly timeoutMs: number;
}

export interface ServerEnd {
  /**
   * Wait for one request, answer it, and return. Returns `false` when the channel closed or the wait timed out with
   * nothing to do, so a kernel loop can distinguish "no work" from "work done".
   */
  serveOne: (handler: (request: unknown) => unknown, options: ServeOptions) => boolean;
  readonly closed: () => boolean;
  readonly close: () => void;
}

/**
 * The kernel side: waits for a request, hands it to a synchronous handler, publishes the answer.
 *
 * The handler is called synchronously and its thrown error becomes a `SyscallRejectedError` on the caller's side. That
 * matters: an ENOENT must arrive as a rejected syscall with a code, not as a crashed kernel or a silent empty file.
 */
export function serveChannel(
  allocation: ChannelAllocation,
  encoding: Encoding = jsonEncoding,
): ServerEnd {
  const { buffer, sizes } = allocation;
  const header = new Int32Array(buffer, 0, HEADER_INTS);
  const requestRegion = new Uint8Array(buffer, HEADER_BYTES, sizes.requestBytes);
  const responseRegion = new Uint8Array(buffer, HEADER_BYTES + sizes.requestBytes, sizes.responseBytes);

  const writeResponse = (sequence: number, payload: Uint8Array): void => {
    if (payload.byteLength > responseRegion.byteLength) {
      const tooLarge = textEncoder.encode(
        JSON.stringify({ ok: false, error: { message: `response payload is ${payload.byteLength} bytes`, code: "ERESPTOOLARGE" } }),
      );
      responseRegion.set(tooLarge.subarray(0, responseRegion.byteLength));
      Atomics.store(header, IDX_RESPONSE_LENGTH, Math.min(tooLarge.byteLength, responseRegion.byteLength));
    } else {
      responseRegion.set(payload);
      Atomics.store(header, IDX_RESPONSE_LENGTH, payload.byteLength);
    }
    Atomics.store(header, IDX_SEQUENCE, sequence);
    Atomics.store(header, IDX_STATE, CHANNEL_STATE.responsePending);
    Atomics.notify(header, IDX_STATE);
  };

  return {
    serveOne: (handler, options) => {
      const state = Atomics.load(header, IDX_STATE);
      if (state === CHANNEL_STATE.closed) return false;
      if (state !== CHANNEL_STATE.requestPending) {
        const outcome = Atomics.wait(header, IDX_STATE, state, options.timeoutMs);
        if (outcome === "timed-out") return false;
        if (Atomics.load(header, IDX_STATE) === CHANNEL_STATE.closed) return false;
      }

      const sequence = Atomics.load(header, IDX_SEQUENCE);
      const length = Atomics.load(header, IDX_REQUEST_LENGTH);
      if (length > requestRegion.byteLength) {
        writeResponse(sequence, textEncoder.encode(JSON.stringify({ ok: false, error: { message: "request length exceeds region", code: "EREQTOOLARGE" } })));
        return true;
      }

      let answer: Uint8Array;
      try {
        const request = encoding.decode(requestRegion.slice(0, length));
        answer = encoding.encode({ ok: true, value: handler(request) });
      } catch (error) {
        const err = error as { message?: string; code?: string };
        answer = encoding.encode({ ok: false, error: { message: err.message ?? String(error), code: err.code ?? "EUNKNOWN" } });
      }
      writeResponse(sequence, answer);
      return true;
    },
    closed: () => Atomics.load(header, IDX_STATE) === CHANNEL_STATE.closed,
    close: () => {
      Atomics.store(header, IDX_STATE, CHANNEL_STATE.closed);
      Atomics.notify(header, IDX_STATE);
    },
  };
}

/** Bytes reserved before the payload regions: exposed for tests that assert the layout rather than trusting it. */
export const CHANNEL_HEADER_BYTES = HEADER_BYTES;
