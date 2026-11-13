/**
 * `WebSocket`, the client half, over whatever duplex this runtime can open.
 *
 * A browser has a `WebSocket` and it is useless here for one specific reason: it opens a connection to a HOST, and the server we want to
 * reach is a program in this runtime on port 3000 of a hostname that does not exist. So the global is replaced with this, and the only
 * thing that differs is where the bytes go. Everything above that is RFC 6455, and it is implemented rather than delegated: a handshake,
 * masked client frames, continuation frames, ping/pong and a closing handshake.
 *
 * The division of labour with `http.js` is Node's, and it is the reason this file is small: `Server.dispatchUpgrade` gives a handler a
 * duplex and the handler writes the `101` itself. This side writes the request, reads the response, checks the accept key, and from then
 * on the same socket carries frames.
 *
 * MASKING IS NOT OPTIONAL in either direction. A client that forgets to mask is rejected by every real server, and a server that masks is
 * malformed; a runtime that got this backwards would work against itself and fail against anything else, which is the worst combination
 * to discover late. `tests/unit/websocket.test.ts` asserts both directions.
 *
 * WHAT THIS IS NOT: there is no compression (`permessage-deflate` is not negotiated, and asking for it gets a refusal rather than a
 * silently uncompressed stream), no `wss:` (there is no TLS to terminate below this), and no backpressure signal — `send` returns once the
 * bytes are on the socket, and `bufferedAmount` reports what the socket still holds rather than a number invented here.
 */

import { EventEmitter } from "./events.js";
import { sha1 } from "./digest.js";
import type { Socket } from "./socket.js";

/** The GUID every WebSocket handshake appends to the client's key. Fixed by RFC 6455 §1.3. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** The states the standard names, and the numbers it names them with. */
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/** What a connection attempt is given: the URL to reach, and the headers the handshake must carry. */
export interface WebSocketConnectRequest {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** What a connector answers: somebody accepted, or a sentence a user can act on. */
export type WebSocketConnectResult = { readonly socket: Socket } | { readonly refusal: string };

/**
 * Opens the duplex. Supplied by whoever owns a transport: the in-process runtime answers from its own port registry, and a kernel forwards
 * it to the process Worker that owns the port.
 *
 * It may answer asynchronously, and that is a fact about the transport rather than a convenience: across a thread boundary the listener's
 * answer is a message, so there is no way to know whether it accepted until that message arrives. A connector that knows its answer refuses
 * nothing by returning a promise: the refusal is what the promise RESOLVES to.
 */
export type WebSocketConnector = (request: WebSocketConnectRequest) => WebSocketConnectResult | Promise<WebSocketConnectResult>;

export interface WebSocketInit {
  readonly unused?: never;
}

/** The shape a listener receives, close enough to the platform's that a client written for a browser works unchanged. */
interface WebSocketEvent {
  readonly type: string;
  /** `this` at the moment of delivery. Typed loosely because the class is a deliberate subset of the DOM interface. */
  readonly target: unknown;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
  readonly message?: string;
}

export interface WebSocketOptions {
  /** Handshake deadline, default 30s. A server that accepts the connection and never answers would otherwise wait forever. */
  readonly handshakeTimeoutMs?: number;
  /** Largest message accepted, default 16 MiB. A frame header can claim 2^63 bytes; a runtime that trusted it would try to allocate it. */
  readonly maxMessageBytes?: number;
}

/**
 * Build the `WebSocket` class a program sees, bound to one connector.
 *
 * A factory rather than a module-level class because the connector IS the transport: an in-process runtime and a process Worker reach
 * different machines behind the same RFC, and a single global class would have to guess which one it was in.
 */
export function createWebSocketClass(connect: WebSocketConnector, options: WebSocketOptions = {}): typeof WebSocket {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
  const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;

  class RuntimeWebSocket extends EventEmitter {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    public readyState: number = CONNECTING;
    public binaryType: "blob" | "arraybuffer" = "blob";
    public readonly url: string;
    /**
     * The subprotocol the SERVER chose, empty when neither side asked for one.
     *
     * A browser sets this from the handshake response, and code reads it to know which protocol is in force (`ws` does, and so does anything that
     * offers two). It was a constant empty string here until a preview page requested `echo` and got `""` back: the client sent the header and never
     * looked at the answer, which is the quiet kind of incompleteness — the connection works, and only the negotiation is missing.
     */
    public protocol = "";
    public readonly extensions = "";
    /** Bytes handed to the socket and not yet written. Reported, not enforced: see the header. */
    public bufferedAmount = 0;

    #socket: Socket | null = null;
    /** The key sent in the handshake, kept so the accept header can be recomputed rather than guessed. */
    #key = "";
    /** What the caller offered in `sec-websocket-protocol`, so the server's answer can be checked against it. */
    #protocols: readonly string[] = [];
    #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bytes received before the handshake finished, and after it: one buffer, because the response and the first frame can arrive together. */
    #buffer: Uint8Array = new Uint8Array(0);
    #handshakeDone = false;
    /** The message being assembled from continuation frames. Fragmentation is legal and common; ignoring it truncates messages. */
    #fragments: Uint8Array[] = [];
    #fragmentOpcode: number | null = null;
    #closeEmitted = false;

    constructor(url: string | URL, protocols?: string | readonly string[]) {
      super();
      const target = typeof url === "string" ? url : url.href;
      this.url = target;

      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw Object.assign(new SyntaxError(`Failed to construct 'WebSocket': The URL '${target}' is invalid.`), { name: "SyntaxError" });
      }
      if (parsed.protocol === "wss:") {
        // Named rather than silently downgraded: a program that asked for TLS and got plaintext would believe it was encrypted.
        queueMicrotask(() => this.#fail("wss: is not available in this runtime: TLS is terminated by the gateway, so a websocket here is ws: only."));
        return;
      }
      if (parsed.protocol !== "ws:") {
        queueMicrotask(() => this.#fail(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol.replace(":", "")}' is not allowed.`));
        return;
      }

      const list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];
      // Kept so the answer can be checked against what was actually offered, which is the only way to notice a server that chose for itself.
      this.#protocols = list;
      const key = base64(randomKey());
      this.#key = key;
      const headers: Record<string, string> = {
        host: parsed.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...(list.length === 0 ? {} : { "sec-websocket-protocol": list.join(", ") }),
      };

      const opened = connect({
        host: parsed.hostname,
        port: Number(parsed.port === "" ? 80 : parsed.port),
        path: `${parsed.pathname === "" ? "/" : parsed.pathname}${parsed.search}`,
        headers,
      });
      if (opened instanceof Promise) {
        // A transport that has to ask another thread. The state stays CONNECTING while it waits, and the deadline above is already running,
        // so a far side that never answers fails as a handshake timeout rather than as a promise nobody awaited.
        void opened.then(
          (result) => {
            if (this.readyState === CLOSED) return;
            this.#adopt(result);
          },
          (error: unknown) => this.#fail(error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      this.#adopt(opened);
    }

    /**
     * Take the answer a connector gave, synchronously or later.
     *
     * One path for both, because the two must behave identically once the socket exists: the acceptance, the listener wiring and the
     * handshake deadline are the same whether the answer took a microtask or a message.
     */
    #adopt(opened: WebSocketConnectResult): void {
      if ("refusal" in opened) {
        // Deferred: the constructor has not returned, so no listener can be attached yet. A failure delivered synchronously would be an
        // error nobody could hear, which reads as a socket that silently never connects.
        queueMicrotask(() => this.#fail(opened.refusal));
        return;
      }

      const socket = opened.socket;
      this.#socket = socket;
      socket.on("data", (chunk: unknown) =>
        this.#consume(typeof chunk === "string" ? TEXT_ENCODER.encode(chunk) : (chunk as Uint8Array)),
      );
      socket.on("error", (error: unknown) => this.#fail(error instanceof Error ? error.message : String(error)));
      socket.on("end", () => this.#closed(1006, "", false));
      socket.on("close", () => this.#closed(1006, "", false));

      // A deadline, because a server that accepted the connection and never wrote a `101` is a hang with no diagnosable cause. The timer
      // is the caller's to lose: `close()` clearing it is the difference between a leak and a lifecycle.
      this.#handshakeTimer = setTimeout(() => {
        this.#handshakeTimer = null;
        this.#fail(`handshake did not complete within ${String(handshakeTimeoutMs)} ms`);
      }, handshakeTimeoutMs);

      // NO REQUEST BYTES GO ON THE SOCKET, and this is the one place the container's model differs from a real connection. On a real
      // socket the client writes `GET ... Upgrade: websocket` and the server parses it; here the request travels OUT OF BAND as the
      // parsed request `dispatchUpgrade` is handed, so the handler already has it in `request.headers`. Writing it a second time would
      // deliver those bytes to the handler as payload, where a frame parser reads `G` as opcode 7 and the handshake never completes.
      // The headers are still built above and passed to `connect`, so nothing is lost: only the transport skips the HTTP parse.
    }

    /** The standard's listener API, over the emitter. Both are offered because both are used in the wild. */
    addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
      this.on(type, listener as (value: unknown) => void);
    }

    removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
      this.off(type, listener as (value: unknown) => void);
    }

    send(data: string | ArrayBuffer | Uint8Array): void {
      if (this.readyState !== OPEN) {
        // Node's WebSocket throws here and the browser's silently buffers. Throwing is the honest one: a message queued behind a closed
        // socket is a message that will never be sent, and the caller is the only one who can decide what to do about that.
        throw Object.assign(new Error("WebSocket is not open: readyState " + String(this.readyState) + " (" + stateName(this.readyState) + ")"), {
          name: "InvalidStateError",
        });
      }
      const bytes = typeof data === "string" ? TEXT_ENCODER.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      const opcode = typeof data === "string" ? OPCODE_TEXT : OPCODE_BINARY;
      const frame = encodeFrame(opcode, bytes, true);
      this.bufferedAmount += frame.length;
      this.#socket?.write(frame, undefined, () => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.length);
      });
    }

    /** The closing handshake: send `close`, then half-close and wait for the peer's reply, which is what "clean" means. */
    close(code = 1000, reason = ""): void {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      if (this.#socket === null || !this.#handshakeDone) {
        this.#closed(code, reason, false);
        return;
      }
      const body = new Uint8Array(2 + TEXT_ENCODER.encode(reason).length);
      body[0] = (code >> 8) & 0xff;
      body[1] = code & 0xff;
      body.set(TEXT_ENCODER.encode(reason), 2);
      this.#socket.write(encodeFrame(OPCODE_CLOSE, body, true));
      this.#socket.end();
      // Nothing arrives to complete the handshake in this runtime: the peer's reply ends the socket, and `end` is delivered to us.
    }

    #consume(chunk: Uint8Array): void {
      this.#buffer = concat(this.#buffer, chunk);
      if (!this.#handshakeDone && !this.#completeHandshake()) return;
      if (this.#handshakeDone) this.#parseFrames();
    }

    /** Read the HTTP response, verify it, and hand back whatever followed it. */
    #completeHandshake(): boolean {
      const end = indexOfDoubleCrlf(this.#buffer);
      if (end === -1) return false;
      const head = TEXT_DECODER.decode(this.#buffer.subarray(0, end));
      const rest = this.#buffer.subarray(end + 4);
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1] ?? "0");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }

      if (status !== 101) {
        // The server's own sentence is quoted when it sent one. `ws` answers a refused handshake with a short body naming the header it
        // rejected, and replacing that with "the server answered 400" threw away the only diagnosis the page's developer would ever get.
        const phrase = statusLine.slice(statusLine.indexOf(" ") + 1).trim();
        const detail = TEXT_DECODER.decode(rest).replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
        this.#fail(`handshake failed: the server answered ${phrase === "" ? String(status) : phrase}${detail === "" ? "" : `: ${detail}`}, not 101`);
        return false;
      }
      const expected = base64(sha1(this.#key + HANDSHAKE_GUID));
      if ((headers["sec-websocket-accept"] ?? "") !== expected) {
        // This is the check that makes the handshake worth doing: without it, anything that can write 101 bytes is "connected".
        this.#fail("handshake failed: sec-websocket-accept did not match the key this client sent");
        return false;
      }

      // The server's choice must be one the client offered. A browser fails the connection outright when it is not, because a peer that picks its
      // own protocol is a peer the caller did not agree to talk to.
      const selected = headers["sec-websocket-protocol"] ?? "";
      if (selected !== "" && this.#protocols.length === 0) {
        this.#fail(`handshake failed: the server chose the subprotocol "${selected}" when none was requested`);
        return false;
      }
      if (selected !== "" && !this.#protocols.includes(selected)) {
        this.#fail(`handshake failed: the server chose the subprotocol "${selected}", which was not offered`);
        return false;
      }
      this.protocol = selected;

      this.#handshakeDone = true;
      this.readyState = OPEN;
      if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
      this.#buffer = rest;
      this.emit("open", { type: "open", target: this } satisfies WebSocketEvent);
      this.onopen?.call(this, { type: "open", target: this } as unknown as Event);
      return true;
    }

    #parseFrames(): void {
      for (;;) {
        const frame = decodeFrame(this.#buffer, maxMessageBytes);
        if (frame === null) return;
        this.#buffer = this.#buffer.subarray(frame.consumed);
        if (frame.opcode === OPCODE_PING) {
          this.#socket?.write(encodeFrame(OPCODE_PONG, frame.payload, true));
          continue;
        }
        if (frame.opcode === OPCODE_PONG) continue;
        if (frame.opcode === OPCODE_CLOSE) {
          const code = frame.payload.length >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : 1005;
          const reason = frame.payload.length > 2 ? TEXT_DECODER.decode(frame.payload.subarray(2)) : "";
          // Echo the close, then treat ours as complete: a peer that closes and gets no reply retries, which reads as a flapping connection.
          if (this.readyState === OPEN) this.#socket?.write(encodeFrame(OPCODE_CLOSE, frame.payload, true));
          this.#closed(code, reason, true);
          return;
        }
        if (frame.opcode === OPCODE_CONTINUATION) {
          if (this.#fragmentOpcode === null) {
            this.#fail("protocol error: a continuation frame arrived with no message to continue");
            return;
          }
          this.#fragments.push(frame.payload);
        } else {
          // A new data message while one was still open means the peer dropped a fragment. Assembling them anyway would splice two
          // messages into one, which is worse than refusing.
          if (this.#fragmentOpcode !== null) {
            this.#fail("protocol error: a new data frame arrived before the previous message finished");
            return;
          }
          this.#fragmentOpcode = frame.opcode;
          this.#fragments.push(frame.payload);
        }
        if (!frame.final) continue;
        const opcode = this.#fragmentOpcode;
        const payload = concat(...this.#fragments);
        this.#fragments = [];
        this.#fragmentOpcode = null;
        if (opcode === OPCODE_TEXT) {
          this.#deliver(TEXT_DECODER.decode(payload));
        } else if (opcode === OPCODE_BINARY) {
          this.#deliver(this.binaryType === "arraybuffer" ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : new Blob([payload.slice()]));
        }
      }
    }

    #deliver(data: unknown): void {
      const event: WebSocketEvent = { type: "message", target: this, data };
      this.emit("message", event);
      this.onmessage?.call(this, event as unknown as MessageEvent);
    }

    #fail(message: string): void {
      if (this.readyState === CLOSED) return;
      this.emit("error", { type: "error", target: this, message } satisfies WebSocketEvent);
      this.onerror?.call(this, { type: "error", message } as unknown as Event);
      this.#closed(1006, message, false);
    }

    #closed(code: number, reason: string, wasClean: boolean): void {
      if (this.#closeEmitted) return;
      this.#closeEmitted = true;
      this.readyState = CLOSED;
      if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
      this.#socket?.destroy();
      const event: WebSocketEvent = { type: "close", target: this, code, reason, wasClean };
      this.emit("close", event);
      this.onclose?.call(this, event as unknown as CloseEvent);
    }

    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
  }

  return RuntimeWebSocket as unknown as typeof WebSocket;
}

/** A 16-byte nonce, base64 encoded, as RFC 6455 §4.1 requires. */
function randomKey(): Uint8Array {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (view: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues !== undefined) {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  // A predictable key is a weaker handshake, not a broken one: the accept check exists to prove the peer understood the protocol, and
  // Math.random still does that. Said out loud rather than hidden, because a reader should know which one they got.
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

function base64(bytes: Uint8Array | ArrayBufferLike): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stateName(state: number): string {
  return state === CONNECTING ? "CONNECTING" : state === OPEN ? "OPEN" : state === CLOSING ? "CLOSING" : "CLOSED";
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function indexOfDoubleCrlf(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a && bytes[index + 2] === 0x0d && bytes[index + 3] === 0x0a) return index;
  }
  return -1;
}

/**
 * Encode one frame. Client frames are always masked, so `mask` is a parameter only so a test can prove the flag matters.
 */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: boolean): Uint8Array {
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const headerLength = 2 + extended + (mask ? 4 : 0);
  const out = new Uint8Array(headerLength + payload.length);
  out[0] = 0x80 | opcode;
  let offset = 2;
  if (extended === 0) {
    out[1] = (mask ? 0x80 : 0) | payload.length;
  } else if (extended === 2) {
    out[1] = (mask ? 0x80 : 0) | 126;
    out[2] = (payload.length >> 8) & 0xff;
    out[3] = payload.length & 0xff;
    offset = 4;
  } else {
    out[1] = (mask ? 0x80 : 0) | 127;
    // The high 32 bits are zero: a message larger than 4 GiB cannot exist here, and writing them as anything but zero would encode a
    // length this runtime could not have produced.
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 0;
    out[6] = (payload.length >>> 24) & 0xff;
    out[7] = (payload.length >>> 16) & 0xff;
    out[8] = (payload.length >>> 8) & 0xff;
    out[9] = payload.length & 0xff;
    offset = 10;
  }
  if (mask) {
    const key = new Uint8Array([0x2a, 0x71, 0x0c, 0x5e]);
    out.set(key, offset);
    offset += 4;
    for (let index = 0; index < payload.length; index += 1) out[offset + index] = payload[index]! ^ key[index & 3]!;
  } else {
    out.set(payload, offset);
  }
  return out;
}

export interface DecodedFrame {
  readonly final: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array;
  /** How many bytes this frame occupied, so the caller can advance its buffer. */
  readonly consumed: number;
}

/** Decode one frame, or `null` if the buffer does not hold all of it yet. */
export function decodeFrame(bytes: Uint8Array, maxMessageBytes: number): DecodedFrame | null {
  if (bytes.length < 2) return null;
  const first = bytes[0]!;
  const second = bytes[1]!;
  const final = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (bytes.length < 4) return null;
    length = (bytes[2]! << 8) | bytes[3]!;
    offset = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return null;
    // Only the low 32 bits are read, so a header claiming 2^63 bytes cannot make this allocate: the check below refuses it instead.
    const high = ((bytes[2]! << 24) | (bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]!) >>> 0;
    const low = ((bytes[6]! << 24) | (bytes[7]! << 16) | (bytes[8]! << 8) | bytes[9]!) >>> 0;
    if (high !== 0) throw new RangeError(`frame length ${String(high)} GiB exceeds what this runtime accepts`);
    length = low;
    offset = 10;
  }
  if (length > maxMessageBytes) throw new RangeError(`frame of ${String(length)} bytes exceeds the ${String(maxMessageBytes)} byte limit`);
  const key = masked ? bytes.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (bytes.length < offset + length) return null;
  const payload = bytes.subarray(offset, offset + length);
  if (key === null) return { final, opcode, payload, consumed: offset + length };
  const unmasked = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) unmasked[index] = payload[index]! ^ key[index & 3]!;
  return { final, opcode, payload: unmasked, consumed: offset + length };
}
