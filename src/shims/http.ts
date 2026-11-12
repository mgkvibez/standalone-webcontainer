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

/**
 * A response as it leaves the shim. The proxy turns this into a real `Response`.
 *
 * `streamed` says the body did NOT travel in this record: it left in events while the handler was still writing. A consumer that
 * installed a sink must use those events, and a consumer that did not gets `streamed: false` and the whole body, as before.
 */
export interface WireResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly streamed?: boolean;
}

/**
 * What a streaming handler makes visible, and when.
 *
 * `start` is the headers at the moment the first byte is written, which is what Node calls sending the headers. Everything after it
 * is body bytes in write order. There is no `end` event: the response record that follows carries the status, and the absence of a
 * further chunk is the end.
 */
export type ResponseEvent =
  | { readonly kind: "start"; readonly statusCode: number; readonly statusMessage: string; readonly headers: Headers }
  | { readonly kind: "chunk"; readonly body: Uint8Array };

/** Receives a response as it is written. Installed by a transport that can carry partial responses; absent means buffering. */
export type ResponseSink = (event: ResponseEvent) => void;

const TEXT_ENCODER = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);

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
  /** Set by a transport that can carry a partial response. Null means buffer everything and answer once. */
  #sink: ResponseSink | null = null;

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

  /**
   * Send this response as it is written, instead of in one piece at `end()`.
   *
   * Called by the transport before the handler is invoked, because the first `write` may happen inside it. Headers leave on the first
   * byte, so a handler that sets a header after writing is now an error, which is Node's rule and the reason `headersSent` exists.
   */
  attachSink(sink: ResponseSink): void {
    this.#sink = sink;
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

  /**
   * Writes a chunk. Always reports "not full": with a sink the bytes have already left, and without one they are memory-resident, so
   * there is no backpressure either way to report.
   */
  write(chunk: string | Uint8Array, encoding?: string): boolean {
    if (this.writableEnded) throw new Error("ERR_STREAM_WRITE_AFTER_END: write after end");
    const bytes = toBytes(chunk, encoding);
    if (this.#sink !== null) {
      this.#sendStart();
      if (bytes.length > 0) this.#sink({ kind: "chunk", body: bytes });
      return true;
    }
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return true;
  }

  /**
   * Send the headers, once.
   *
   * No `content-length`: a streamed body's length is unknown when the headers go out, and a wrong one truncates the response at the
   * proxy. A handler that set one explicitly keeps it, since it may know something we do not (a HEAD response, a byte-range).
   */
  #sendStart(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.#sink?.({ kind: "start", statusCode: this.statusCode, statusMessage: this.statusMessage, headers: this.getHeaders() });
  }

  /** Finish the response and settle the proxy's promise. Idempotent, because `end` is often called twice by mistake. */
  end(chunk?: string | Uint8Array, encoding?: string): this {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.finished = true;
    const last = chunk === undefined ? undefined : toBytes(chunk, encoding);

    if (this.#sink !== null) {
      this.#sendStart();
      if (last !== undefined && last.length > 0) this.#sink({ kind: "chunk", body: last });
      this.emit("finish");
      // The body is empty ON PURPOSE: it travelled as events. `streamed` is how a consumer tells "no bytes" from "bytes already sent",
      // which is the difference between an empty page and a page whose content arrived in pieces.
      this.#resolve({ statusCode: this.statusCode, statusMessage: this.statusMessage, headers: this.getHeaders(), body: EMPTY_BYTES, streamed: true });
      return this;
    }

    if (last !== undefined) {
      this.#chunks.push(last);
      this.#length += last.length;
    }
    this.headersSent = true;

    const headers = this.getHeaders();
    // Content-Length is always computed for a buffered response, overriding anything the handler set. This is a deliberate deviation
    // from Node, which trusts the handler: a buffered body's length is known exactly, so a wrong hand-written value can only truncate
    // or stall the response. A streamed response makes the opposite choice for the opposite reason (see #sendStart).
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
/**
 * Node's method list, in its own order.
 *
 * Servers iterate it to build per-method route tables (`express` lower-cases every entry), so the *set* is functional data rather
 * than decoration: a method missing here is a route that can never match.
 */
export const METHODS = [
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY",
  "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "REBIND",
  "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
] as const;

/** The status codes Node ships with; `ServerResponse` reads them when only a code is given. */
export const STATUS_CODES: Readonly<Record<number, string>> = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content",
  205: "Reset Content", 206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
  305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout",
  409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed",
  418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency",
  425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage",
  508: "Loop Detected", 509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
};

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
  async dispatch(wire: WireRequest, sink?: ResponseSink): Promise<WireResponse> {
    const request = new IncomingMessage(wire);
    const response = new ServerResponse();
    // Installed BEFORE the handler runs: the handler's first `write` may happen inside the call below, and a sink attached afterwards
    // would see a response that had already sent bytes nobody recorded.
    if (sink !== undefined) response.attachSink(sink);

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

/**
 * Node's HTTP CLIENT is not provided here, and says so. See docs/decisions/ADR-0025.md.
 *
 * The audit's criticism was not that `http.get` was missing; it was that the absence was SILENT: `http.get(url)` produced
 * `TypeError: http.get is not a function` with nothing about why, what to use instead, or that a boundary had been reached. Silence is the
 * worst of the three options (implement it, refuse it by name, say nothing) because it reads as a broken runtime rather than a decision.
 *
 * What a program must do instead: use the global `fetch()`, which the browser supplies. It is not the same contract, and the difference is worth
 * naming — `fetch` is CORS-governed, has no sockets, no keep-alive agent, no `Expect: 100-continue`, and streams through WHATWG
 * `ReadableStream` rather than Node's `stream.Readable`. Code reaching for `http.get` to control any of those cannot be served by a wrapper over
 * fetch without misrepresenting it.
 */
function refuseClient(member: string): never {
  const error = new Error(
    `ERR_NOT_SUPPORTED: http.${member} is not available in this runtime: there are no sockets, so Node's HTTP client cannot exist here. ` +
      "Use the global fetch(), which the browser provides with CORS semantics (no agent, no socket options, WHATWG streams). " +
      "See docs/decisions/ADR-0025.md.",
  ) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  throw error;
}

/**
 * Refused rather than absent, because a caller reaches for it to configure a client that cannot exist: an `Agent` with `keepAlive` is
 * meaningless without sockets, and an inert object would let `new Agent({ keepAlive: true })` appear to have worked.
 */
export class Agent {
  constructor(_options?: unknown) {
    refuseClient("Agent");
  }
}

/** Refused for the same reason: a request object cannot be built without a socket to carry it. */
export class ClientRequest extends EventEmitter {
  constructor() {
    super();
    refuseClient("ClientRequest");
  }
}

export function request(..._args: unknown[]): never {
  return refuseClient("request");
}

export function get(..._args: unknown[]): never {
  return refuseClient("get");
}

/**
 * Node's maximum header size, as a real number rather than a placeholder: 16 KiB is what Node reports, and a caller sizing a buffer from it gets
 * a true figure. Nothing here enforces it — the preview gateway applies its own limit.
 */
export const maxHeaderSize = 16384;

/**
 * `validateHeaderName`, IMPLEMENTED rather than refused, because it is a pure function: libraries call it to fail early, so a refusal would break
 * code that works.
 *
 * Node's rule is an RFC 7230 token — letters, digits and a small set of punctuation, with no space, colon, quote or control character — and the
 * error code is Node's, because callers match on `code` rather than on the wording.
 */
export function validateHeaderName(name: unknown): void {
  const text = String(name);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(text)) {
    const error = new TypeError(`Header name must be a valid HTTP token ["${text}"]`) as TypeError & { code: string };
    error.code = "ERR_INVALID_HTTP_TOKEN";
    throw error;
  }
}

/**
 * `validateHeaderValue`, implemented for the same reason.
 *
 * Two refusals, both Node's: an `undefined` value (`ERR_HTTP_INVALID_HEADER_VALUE`) and a value carrying a character that would split the header
 * (`ERR_INVALID_CHAR`). The second is the one that matters — a newline in a value is header injection, and a validator that accepted it would be
 * worse than no validator at all.
 */
export function validateHeaderValue(name: string, value: unknown): void {
  if (value === undefined) {
    const error = new TypeError(`Invalid value "undefined" for header "${name}"`) as TypeError & { code: string };
    error.code = "ERR_HTTP_INVALID_HEADER_VALUE";
    throw error;
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(String(value))) {
    const error = new TypeError(`Invalid character in header content ["${name}"]`) as TypeError & { code: string };
    error.code = "ERR_INVALID_CHAR";
    throw error;
  }
}
