/**
 * `http` shim: the server half of the runtime.
 *
 * ADR-0002 puts the service-worker network proxy fourth in shim priority, and this module is what that
 * proxy calls into. The shape is deliberately narrow: create a server, listen on a port, receive one
 * buffered request, produce one buffered response.
 *
 * **Bodies are bytes, never strings.** A proxy that decoded every body as UTF-8 would corrupt any
 * binary response and nobody would notice until an image or a font arrived damaged. `write` accepts a
 * string for convenience but always stores `Uint8Array`, and `setEncoding` only affects what the
 * *reader* sees.
 *
 * Four things are intentionally not implemented, stated here so the audit reads a boundary instead of
 * inferring one: chunked transfer encoding (a response is buffered whole and sent with a computed
 * `content-length`), keep-alive (one request per connection), TLS/HTTP2, and the `upgrade` event, which
 * is why websockets in the browser lane are a later, separate problem. Streaming a response before it
 * ends would also require the proxy to stream, and neither side does that yet.
 *
 * `IncomingMessage` follows Node's async delivery contract: `data` and `end` fire after the request
 * handler returns, not during it, so a handler that attaches listeners synchronously receives them.
 * `pause` and `resume` are absent because the body is already in memory; pretending to honour
 * backpressure that cannot occur would be a lie with a nicer API.
 */

import { EventEmitter } from "./events.js";
import {
  InvalidPortError,
  PortInUseError,
  PortRegistry,
  type ServeProtocol,
} from "../network/port-registry.js";

export type Headers = Record<string, string>;

/** A request as it arrives from the preview proxy. Transport-shaped, not yet a Node object. */
export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** A response as it leaves the shim. The proxy turns this into a real `Response`. */
export interface WireResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const TEXT_ENCODER = new TextEncoder();

function toBytes(chunk: string | Uint8Array, encoding?: string): Uint8Array {
  if (typeof chunk === "string") {
    // Only utf8 is supported. Silently accepting "latin1" and encoding utf8 would produce mojibake in
    // the one case where the caller was careful about encoding.
    if (encoding !== undefined && encoding.toLowerCase() !== "utf8" && encoding.toLowerCase() !== "utf-8") {
      throw new TypeError(`encoding ${encoding} is not supported; only utf8 is available`);
    }
    return TEXT_ENCODER.encode(chunk);
  }
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("chunk must be a string or a Uint8Array");
}

function concat(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) {
    const [only] = chunks;
    if (only !== undefined) return only;
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The request as the handler sees it. Reads like `http.IncomingMessage` for the fields applications
 * actually use, and nothing more.
 */
export class IncomingMessage extends EventEmitter {
  public readonly method: string;
  public readonly url: string;
  public readonly headers: Headers;
  public readonly httpVersion = "1.1";
  public readonly complete = true;
  public readonly aborted = false;

  readonly #body: Uint8Array;
  #encoding: string | null = null;
  #delivered = false;

  constructor(wire: WireRequest) {
    super();
    this.method = wire.method;
    this.url = wire.url;
    this.headers = wire.headers;
    this.#body = wire.body;
  }

  /** Decode `data` events as text instead of bytes. Mirrors the one `setEncoding` use that matters. */
  setEncoding(encoding: string): this {
    const normalised = encoding.toLowerCase();
    if (normalised !== "utf8" && normalised !== "utf-8") {
      throw new TypeError(`encoding ${encoding} is not supported; only utf8 is available`);
    }
    this.#encoding = normalised;
    return this;
  }

  /** The whole body, regardless of whether it was emitted. Used by handlers that prefer to pull. */
  rawBody(): Uint8Array {
    return this.#body;
  }

  /**
   * Emit `data` then `end`, asynchronously. Called once by the server after it invokes the handler, so
   * the ordering matches Node: the handler runs first, listeners it attached synchronously are present,
   * and delivery happens on a later microtask.
   */
  deliverBody(): void {
    if (this.#delivered) return;
    this.#delivered = true;
    queueMicrotask(() => {
      const decoder = this.#encoding === null ? null : new TextDecoder(this.#encoding);
      if (this.#body.length > 0) {
        const chunk: string | Uint8Array = decoder === null ? this.#body : decoder.decode(this.#body);
        this.emit("data", chunk);
      }
      this.emit("end");
    });
  }
}

/**
 * The response a handler writes into. Buffered by design; `end()` settles the promise the proxy awaits.
 */
export class ServerResponse extends EventEmitter {
  public statusCode = 200;
  public statusMessage = "";
  public headersSent = false;
  public writableEnded = false;
  public finished = false;

  readonly #headers = new Map<string, { readonly name: string; value: string }>();
  readonly #chunks: Uint8Array[] = [];
  #length = 0;
  readonly #settled: Promise<WireResponse>;
  #resolve!: (response: WireResponse) => void;

  constructor() {
    super();
    this.#settled = new Promise<WireResponse>((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Resolves when the handler calls `end()`. Rejects only if the connection is torn down first. */
  get done(): Promise<WireResponse> {
    return this.#settled;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.#assertHeadersMutable();
    const normalised =
      typeof value === "number"
        ? String(value)
        : typeof value === "string"
          ? value
          : (value as readonly string[]).join(", ");
    this.#headers.set(name.toLowerCase(), { name, value: normalised });
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.#headers.get(name.toLowerCase())?.value;
  }

  getHeaders(): Headers {
    const out: Headers = {};
    for (const { name, value } of this.#headers.values()) out[name.toLowerCase()] = value;
    return out;
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.#assertHeadersMutable();
    this.#headers.delete(name.toLowerCase());
  }

  /**
   * Set status and headers in one call, as middleware libraries do. Accepts the Node signatures that
   * omit the message: `writeHead(404)` and `writeHead(404, { ... })` both work.
   */
  writeHead(statusCode: number, headersOrMessage?: Headers | string, maybeHeaders?: Headers): this {
    if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT: cannot write headers after they were sent");
    this.statusCode = statusCode;
    let headers: Headers | undefined;
    if (typeof headersOrMessage === "string") {
      this.statusMessage = headersOrMessage;
      headers = maybeHeaders;
    } else {
      headers = headersOrMessage;
    }
    if (headers !== undefined) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  /** Buffers a chunk. Always reports "not full": the body is memory-resident, so there is no backpressure to report. */
  write(chunk: string | Uint8Array, encoding?: string): boolean {
    if (this.writableEnded) throw new Error("ERR_STREAM_WRITE_AFTER_END: write after end");
    const bytes = toBytes(chunk, encoding);
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return true;
  }

  /** Finish the response and settle the proxy's promise. Idempotent, because `end` is often called twice by mistake. */
  end(chunk?: string | Uint8Array, encoding?: string): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined) {
      const bytes = toBytes(chunk, encoding);
      this.#chunks.push(bytes);
      this.#length += bytes.length;
    }
    this.writableEnded = true;
    this.finished = true;
    this.headersSent = true;

    const headers = this.getHeaders();
    // Content-Length is always computed, overriding anything the handler set. This is a deliberate
    // deviation from Node, which trusts the handler: since responses here are buffered whole, a wrong
    // hand-written value can only cause a truncated or stalled response, and there is no streaming case
    // where a handler would legitimately need to override it.
    headers["content-length"] = String(this.#length);

    this.emit("finish");
    this.#resolve({
      statusCode: this.statusCode,
      statusMessage: this.statusMessage,
      headers,
      body: concat(this.#chunks, this.#length),
    });
    return this;
  }

  #assertHeadersMutable(): void {
    if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT: cannot change headers after they were sent");
  }
}

/** A request handler, shaped like Node's `request` listener. */
export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export interface CreateServerOptions {
  /** Defaults to a shared registry so `http.createServer()` works standalone, as in Node. */
  readonly registry?: PortRegistry;
  readonly protocol?: ServeProtocol;
}

/**
 * The shared registry used when a caller does not supply one.
 *
 * A module-level singleton is a pragmatic default: Node lets any module call `createServer()` without
 * ceremony, and code ported into the runtime should not have to learn our wiring to work. Embedded uses
 * (the preview gateway, tests) pass their own so two runtimes in one page cannot see each other's ports.
 */
const DEFAULT_REGISTRY = new PortRegistry();

/**
 * An `http.Server`. Registering the port is a real act: it is what makes `/preview/<port>/` route to
 * this handler, and it is why a second server on the same port fails here exactly as it would on a
 * socket.
 */
export class Server extends EventEmitter {
  public readonly handler: RequestListener;
  readonly #registry: PortRegistry;
  readonly #protocol: ServeProtocol;
  #boundPort: number | null = null;

  constructor(handler: RequestListener | undefined, options: CreateServerOptions = {}) {
    super();
    this.#registry = options.registry ?? DEFAULT_REGISTRY;
    this.#protocol = options.protocol ?? "http";
    // Node's default: a server with no request listener answers 404. Keeping that avoids a hang, which
    // is what an empty handler would otherwise produce.
    this.handler = handler ?? ((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
  }

  get listening(): boolean {
    return this.#boundPort !== null;
  }

  /**
   * Bind a port. Accepts the signatures applications actually use: `listen(3000)`, `listen(3000, cb)`,
   * `listen(3000, "127.0.0.1", cb)`, `listen(cb)` (which needs a port we do not have, so it throws).
   *
   * The host argument is accepted and ignored. Ignoring it is safe because the runtime has one namespace
   * of previews: there is no interface to bind to, and pretending otherwise would imply isolation we do
   * not provide.
   */
  listen(port: number | (() => void), hostOrCallback?: string | (() => void), callback?: () => void): this {
    if (typeof port === "function") {
      throw new InvalidPortError(0);
    }
    const done = typeof hostOrCallback === "function" ? hostOrCallback : callback;

    if (this.#boundPort !== null) throw new PortInUseError(`${this.#protocol}:${this.#boundPort}`);
    this.#registry.bind(this.#protocol, port, "http.Server.listen");
    this.#boundPort = port;
    // Synchronous, and deliberately not called "listening": Node emits `listening` on a later tick, but
    // routing must be correct the instant listen() returns, or a request arriving in between gets a bogus
    // 404 for a server that is demonstrably running.
    this.emit("bind", port);

    if (done !== undefined) this.once("listening", done);
    // Asynchronous like Node: a listener attached after `listen()` still receives `listening`.
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  /** Release the port. Safe to call twice, because Node's `close()` is likewise forgiving. */
  close(callback?: () => void): this {
    if (this.#boundPort !== null) {
      const released = this.#boundPort;
      this.#registry.release(this.#protocol, released);
      this.#boundPort = null;
      this.emit("unbind", released);
    }
    if (callback !== undefined) this.once("close", callback);
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  /** Node's `address()`, with the shape applications expect. */
  address(): { address: string; family: "IPv4"; port: number } | null {
    if (this.#boundPort === null) return null;
    return { address: "0.0.0.0", family: "IPv4", port: this.#boundPort };
  }

  /**
   * Handle one request. This is the function the preview gateway calls, and it is where a handler's
   * failure becomes a 500 instead of a hung preview.
   */
  async dispatch(wire: WireRequest): Promise<WireResponse> {
    const request = new IncomingMessage(wire);
    const response = new ServerResponse();

    const surfaceFailure = (cause: unknown): void => {
      if (response.writableEnded) {
        // The response is already on its way; there is nowhere to report the error except the listener.
        if (this.listenerCount("clientError") > 0) this.emit("clientError", cause, request);
        return;
      }
      response.statusCode = 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(cause instanceof Error ? cause.message : "Internal Server Error");
      if (this.listenerCount("clientError") > 0) this.emit("clientError", cause, request);
    };

    try {
      // Node ignores a handler's return value, and so do we; the cast is only so an async handler's
      // promise can be inspected instead of becoming an unhandled rejection.
      const returned: unknown = (this.handler as (a: IncomingMessage, b: ServerResponse) => unknown)(
        request,
        response,
      );
      // Node ignores a returned promise, and so do we. But an ignored rejection would become an
      // unhandled rejection that kills the page, so it is caught and surfaced as a failed response.
      if (returned instanceof Promise) returned.catch(surfaceFailure);
    } catch (error) {
      surfaceFailure(error);
    }

    request.deliverBody();
    return response.done;
  }
}

/** `http.createServer(handler)`. */
export function createServer(handler?: RequestListener, options?: CreateServerOptions): Server {
  return new Server(handler, options);
}
