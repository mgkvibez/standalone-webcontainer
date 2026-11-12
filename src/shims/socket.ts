/**
 * A duplex connection between two programs, without a socket.
 *
 * There are no sockets in a browser: no `net`, no file descriptors, nothing to `connect()` to. What an upgraded HTTP connection needs,
 * though, is not a socket — it is a PAIR of endpoints that carry bytes both ways until one side closes. That is something a browser can
 * have, and this is it.
 *
 * The shape is Node's `net.Socket` reduced to the surface an upgrade handler actually touches, because that is the surface a package
 * written against `ws` or Vite's HMR server will touch:
 *
 * - `write(chunk)` puts bytes on the far side, `end()` half-closes, `destroy()` tears both ends down.
 * - `on("data")`, `on("end")`, `on("close")`, `on("error")` are delivered, always AFTER the current turn, never during the call that
 *   caused them. Node's rule, and the reason a handler can attach listeners after writing its handshake and still receive the reply.
 * - `pause()`/`resume()` exist because `ws` calls them. What they do here is real but small: a paused socket QUEUES, so no byte is
 *   lost, and the queue drains on resume. Claiming to honour backpressure that cannot occur would be a lie with a nicer API, so the
 *   header says which one this is.
 * - `setTimeout`, `setNoDelay`, `setKeepAlive`, `setEncoding` are accepted and do what this runtime can honestly do: the first is a real
 *   idle timer, the middle two are no-ops that return the socket (there is no Nagle algorithm to disable and no keepalive probe to send),
 *   and the last decodes what a reader receives.
 *
 * WHAT THIS IS NOT: it is not `net.Socket`. There is no `remoteAddress` (`undefined`, as Node reports on a destroyed socket), no fd, and no
 * TLS. An upgrade is the only way to obtain one of these, which is the same rule a browser server-side runtime has to live by.
 */

import { EventEmitter, type EventListener } from "./events.js";

/** What a `data` listener may receive. Strings only when `setEncoding` was called, which is Node's contract. */
export type SocketChunk = Uint8Array | string;

export interface SocketOptions {
  /**
   * Deliveries per turn before the queue yields.
   *
   * A peer that writes in a loop could otherwise starve everything else, and the runtime's own scheduler is cooperative. Measured need:
   * `ws` writes one frame per `socket.write`, and a burst of them must not turn into one unbreakable turn.
   */
  readonly maxDeliveriesPerTurn?: number;
}

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

/**
 * One end of a connection.
 *
 * Both ends are created together by {@link linkSockets}, because an endpoint with no peer is not a smaller endpoint: it is a socket that
 * silently swallows writes, which is the failure shape this project keeps finding and refusing.
 */
export class Socket extends EventEmitter {
  /** True until `end()`/`destroy()`, as on a real socket. `ws` reads it to decide whether a write is legal. */
  public writable = true;
  public readable = true;
  public destroyed = false;
  /** Node reports `undefined` when there is no peer address, which is the truth here: there is no address. */
  public readonly remoteAddress = undefined;
  public readonly remotePort = undefined;
  public readonly localPort = undefined;

  #peer: Socket | null = null;
  #encoder: "utf8" | "hex" | "base64" | "latin1" | "ascii" | null = null;
  #decoder: string | null = null;
  /** Bytes that arrived while paused, drained on resume. */
  readonly #queued: Uint8Array[] = [];
  #paused = false;
  #draining = false;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimeoutMs = 0;
  #deliveriesPerTurn: number;
  /** Set once `end` has been delivered, so a second half-close cannot double-emit. */
  #endDelivered = false;

  constructor(options: SocketOptions = {}) {
    super();
    this.#deliveriesPerTurn = options.maxDeliveriesPerTurn ?? 64;
  }

  /** @internal Called by {@link linkSockets}; not part of the public shape because a socket is born attached. */
  attach(peer: Socket): void {
    this.#peer = peer;
  }

  /** The bytes a `data` listener receives, decoded when `setEncoding` asked for it. */
  setEncoding(encoding: string): this {
    const normalised = encoding.toLowerCase();
    if (normalised !== "utf8" && normalised !== "utf-8" && normalised !== "latin1" && normalised !== "ascii" && normalised !== "hex" && normalised !== "base64") {
      throw new TypeError(`Unknown encoding: ${encoding}`);
    }
    this.#decoder = normalised;
    return this;
  }

  /** Bytes are accepted as a string for convenience and stored as bytes, so a binary protocol cannot be corrupted by a decode. */
  write(chunk: string | Uint8Array, encoding?: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed || !this.writable) {
      const error = Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      if (callback !== undefined) {
        callback(error);
        return false;
      }
      throw error;
    }
    const bytes = toBytes(chunk, encoding ?? this.#encoder ?? "utf8");
    this.#touch();
    const peer = this.#peer;
    if (peer !== null) peer.receiveFromPeer(bytes);
    callback?.(null);
    return true;
  }

  /** Half-close. The peer sees `end` once everything already written has been delivered, which is why this queues rather than cuts. */
  end(chunk?: string | Uint8Array, encoding?: string, callback?: () => void): this {
    if (chunk !== undefined) this.write(chunk, encoding);
    this.writable = false;
    this.#touch();
    const peer = this.#peer;
    if (peer !== null) {
      // After the writes above, so bytes and end keep their order on the far side.
      queueMicrotask(() => peer.#deliverEnd());
    }
    callback?.();
    return this;
  }

  /** Tear both ends down. Node's `destroy` is idempotent, and so is this. */
  destroy(error?: Error): this {
    if (this.destroyed && (this.#peer === null || this.#peer.destroyed)) return this;
    const peer = this.#peer;
    this.#finish(error);
    if (peer !== null) {
      peer.#finish(error === undefined ? undefined : Object.assign(new Error(error.message), { code: (error as { code?: string }).code }));
    }
    return this;
  }

  /**
   * Registering a `data` listener drains what was queued before anyone was listening.
   *
   * This is Node's flowing-mode switch, and it is load-bearing rather than tidy: two ends of a container socket are in the same turn, so a
   * server can answer the instant it is handed the connection — which means the reply can arrive before the client that opened it has
   * attached its listeners. A socket that dropped those bytes would present as a handshake that never completes.
   */
  override on(event: string, listener: EventListener): this {
    super.on(event, listener);
    if (event === "data") queueMicrotask(() => this.#drain());
    return this;
  }

  override once(event: string, listener: EventListener): this {
    super.once(event, listener);
    if (event === "data") queueMicrotask(() => this.#drain());
    return this;
  }

  /** Stop delivering until `resume()`. Bytes that arrive meanwhile are queued, not dropped. */
  pause(): this {
    this.#paused = true;
    return this;
  }

  resume(): this {
    if (!this.#paused) return this;
    this.#paused = false;
    this.#drain();
    return this;
  }

  /** Node's idle timer: fires `timeout` when nothing is read or written for `ms`, and 0 disables it. */
  setTimeout(ms: number, callback?: () => void): this {
    this.#idleTimeoutMs = ms;
    if (callback !== undefined) this.once("timeout", callback);
    this.#touch();
    return this;
  }

  /** There is no Nagle algorithm here. Returns the socket so the chain `socket.setNoDelay().setKeepAlive()` works, which is what callers write. */
  setNoDelay(_enabled = true): this {
    return this;
  }

  setKeepAlive(_enabled = false, _initialDelay = 0): this {
    return this;
  }

  /** The bytes address of the peer. Absent here, and `undefined` is what Node reports when there is none. */
  address(): { address: string; family: string; port: number } | undefined {
    return undefined;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /** @internal A byte arrived from the peer. Public in name only: a socket is only useful cross-linked. */
  private receiveFromPeer(bytes: Uint8Array): void {
    if (this.destroyed || !this.readable) return;
    if (this.#paused) {
      this.#queued.push(bytes);
      return;
    }
    this.#emitData(bytes);
  }

  #emitData(bytes: Uint8Array): void {
    if (this.listenerCount("data") === 0) {
      // Nobody is reading. Node buffers in the socket rather than dropping, and so does the queue here: a handler that attaches its
      // listeners after writing its handshake must still see the reply.
      this.#queued.push(bytes);
      return;
    }
    this.#touch();
    const payload: SocketChunk = this.#decoder === null ? bytes : decode(bytes, this.#decoder);
    this.emit("data", payload);
  }

  /** Deliver queued bytes in order, yielding between batches so one peer cannot monopolise the turn. */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      let delivered = 0;
      while (!this.#paused && this.#queued.length > 0 && delivered < this.#deliveriesPerTurn) {
        const next = this.#queued.shift();
        if (next === undefined) break;
        this.#emitData(next);
        delivered += 1;
      }
      if (!this.#paused && this.#queued.length > 0) queueMicrotask(() => this.#drain());
    } finally {
      this.#draining = false;
    }
  }

  #deliverEnd(): void {
    if (this.#endDelivered || this.destroyed) return;
    this.#endDelivered = true;
    this.readable = false;
    // Queued bytes first: `end` means "nothing after this", and an end delivered ahead of data would truncate the stream.
    this.#drain();
    this.emit("end");
    this.emit("close", false);
  }

  #finish(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#queued.length = 0;
    if (error !== undefined) this.emit("error", error);
    queueMicrotask(() => this.emit("close", error !== undefined));
  }

  /** Restart the idle timer. Called on every read and write, which is what "idle" means. */
  #touch(): void {
    if (this.#idleTimeoutMs <= 0 || this.destroyed) return;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.emit("timeout");
      // A timeout with no listener destroys the socket, as Node's does: a half-open connection nobody is watching is a leak.
      if (this.listenerCount("timeout") === 0) this.destroy(Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }));
    }, this.#idleTimeoutMs);
  }
}

/** Two endpoints wired to each other. The only way to obtain a {@link Socket}. */
export function linkSockets(options: SocketOptions = {}): { readonly local: Socket; readonly remote: Socket } {
  const local = new Socket(options);
  const remote = new Socket(options);
  local.attach(remote);
  remote.attach(local);
  return { local, remote };
}

function toBytes(chunk: string | Uint8Array, encoding: string): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (encoding === "utf8" || encoding === "utf-8") return TEXT_ENCODER.encode(chunk);
  if (encoding === "latin1" || encoding === "ascii") {
    const out = new Uint8Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) out[index] = chunk.charCodeAt(index) & 0xff;
    return out;
  }
  if (encoding === "hex") {
    const out = new Uint8Array(chunk.length / 2);
    for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(chunk.slice(index * 2, index * 2 + 2), 16);
    return out;
  }
  if (encoding === "base64") return Uint8Array.from(atob(chunk), (character) => character.charCodeAt(0));
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

function decode(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf8" || encoding === "utf-8") return TEXT_DECODER.decode(bytes);
  if (encoding === "hex") return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (encoding === "base64") return btoa([...bytes].map((byte) => String.fromCharCode(byte)).join(""));
  // latin1 and ascii, which Node treats the same way here.
  return [...bytes].map((byte) => String.fromCharCode(byte)).join("");
}
