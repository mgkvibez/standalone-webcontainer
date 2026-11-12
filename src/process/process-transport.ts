/**
 * Transport to a process that owns the server.
 *
 * ADR-0018's process model puts each program in its own Worker, and a program that calls `listen(3200)` owns a real `Server`
 * object inside THAT Worker. The kernel owns the filesystem, the port table and the gateway a preview request arrives at, so a
 * request for `/preview/3200/` reaches a kernel that knows the port is bound and has no handler to call: the handler is on the
 * other side of a thread boundary.
 *
 * This broker is the missing seam. It is deliberately NOT a syscall: the syscall channel carries filesystem requests in a
 * shared buffer with a single in-flight call per process, and a preview request can take seconds (`vite` rebuilding), which
 * would block every filesystem call that process needs to do the work. So a transport request travels on its own
 * `MessagePort`, one per process, correlated by an id, with its own deadline.
 *
 * The alternative design was to keep the servers in the kernel and have processes ask it to listen. It loses because the
 * request listener is a JavaScript closure the program wrote: forwarding it would mean serialising functions, and every
 * `req`/`res` method would have to become a remote procedure call. Here the program's own handler runs where it was created.
 *
 * WHAT THIS FILE IS NOT: it does not route by hostname, and it does not decide that the port is legitimate. It answers exactly
 * one question, "which process answers for port N", and forwards. Anything else belongs to the gateway that called it.
 */

import type { ServeProtocol } from "../network/port-registry.js";
import { linkSockets, type Socket } from "../shims/socket.js";

/** Default mount prefix, matching the preview gateway's `/preview/<port>/<path>`. */
export const DEFAULT_TRANSPORT_MOUNT = "/preview";

/**
 * A request as it crosses the thread boundary.
 *
 * Plain `Record<string, string>` headers rather than a `Headers` object on purpose: this shape has to survive structured
 * clone in both directions and be reconstructable in a Worker, and the page-to-runtime transport already made the same choice
 * for the same reason. `body` is a `Uint8Array`, not base64: structured clone carries binary for free, and base64 would add
 * 33% to every byte on the preview path.
 */
export interface TransportWireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface TransportWireResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /**
   * The body left in events while the handler was still writing, so `body` is empty because it already went, not because there was
   * nothing to send. Absent or false means the body is here, whole.
   */
  readonly streamed?: boolean;
}

/**
 * One thing a streaming handler made visible, forwarded as it happened.
 *
 * The `start` event carries the status and headers at the moment the first byte was written, because a consumer that wants to render
 * the first chunk cannot wait for the headers to arrive at the end.
 */
export type TransportEvent =
  | { readonly kind: "start"; readonly statusCode: number; readonly statusMessage: string; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: "chunk"; readonly body: Uint8Array };

/** Receives a response as it is written. A caller that passes none gets one buffered record, as before. */
export type TransportSink = (event: TransportEvent) => void;

/** Kernel to process. */
export interface TransportRequestMessage {
  readonly type: "transport-request";
  readonly id: number;
  readonly request: TransportWireRequest;
  /**
   * Whether the caller asked for the response as it is written.
   *
   * It has to travel WITH the request, because the decision is made on the far side: the process Worker is the one that installs the
   * sink, and a Worker that always installs one turns every response into a stream. A caller with no sink then receives `streamed: true`
   * and an empty body, which reads as "the handler wrote nothing" — the exact silent-empty-output shape ADR-0029 warns about.
   */
  readonly stream?: boolean;
}

/**
 * Process to kernel: part of a response that is still being written. Sent between `transport-request` and the final reply, in write
 * order, and only to a kernel that asked for them by passing a sink.
 */
export interface TransportEventMessage {
  readonly type: "transport-event";
  readonly id: number;
  readonly event: TransportEvent;
}

/** Process to kernel: the answer, or why there is none. */
export type TransportReplyMessage =
  | { readonly type: "transport-reply"; readonly id: number; readonly response: TransportWireResponse }
  | { readonly type: "transport-error"; readonly id: number; readonly reason: string }
  | TransportEventMessage;

/**
 * The ports a process currently has bound.
 *
 * Sent whenever the set changes rather than derived in the kernel, because the registry lives in the serving Worker: a kernel
 * that guessed would route to a process that had already closed its server.
 */
export interface PortsMessage {
  readonly type: "ports";
  readonly ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[];
}

/**
 * Kernel to process: open a connection to a server this process owns, for a protocol switch.
 *
 * The same door `gateway.upgrade()` is in-process, moved to the other side of a thread boundary. It is a distinct message from
 * `transport-request` because the shape is different in the one way that matters: a request has an answer and an end, a connection stays open
 * and both sides speak whenever they like.
 */
export interface TransportSocketOpenMessage {
  readonly type: "socket-open";
  readonly id: number;
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Kernel to process, after the open. */
export type TransportSocketDownstreamMessage =
  | TransportSocketOpenMessage
  | { readonly type: "socket-data"; readonly id: number; readonly data: Uint8Array }
  | { readonly type: "socket-end"; readonly id: number }
  | { readonly type: "socket-close"; readonly id: number; readonly reason?: string };

/** Process to kernel: whether the switch was accepted, then the same three events in the other direction. */
export type TransportSocketUpstreamMessage =
  | { readonly type: "socket-accepted"; readonly id: number }
  | { readonly type: "socket-refused"; readonly id: number; readonly reason: string }
  | { readonly type: "socket-data"; readonly id: number; readonly data: Uint8Array }
  | { readonly type: "socket-end"; readonly id: number }
  | { readonly type: "socket-close"; readonly id: number; readonly reason?: string };

/** What an upgrade attempt came to: either the far side accepted and here is one end, or why it did not. */
export type TransportUpgradeResult = { readonly accepted: true; readonly socket: Socket } | { readonly accepted: false; readonly reason: string };

export type ProcessToKernelMessage = TransportReplyMessage | PortsMessage | TransportSocketUpstreamMessage;

export type KernelToProcessMessage = TransportRequestMessage | TransportSocketDownstreamMessage;

/**
 * Relay one end of a connection over messages, in both directions.
 *
 * Symmetric on purpose: the kernel and the process Worker run this same function, which is the only way to be sure the two sides agree about
 * ordering and about what `end` means. The caller passes the end IT holds; the peer of that end is the reader or writer on the far side of the
 * thread boundary.
 *
 * The bytes a peer wrote before this was called are delivered, not lost, and that is load-bearing rather than tidy. A `dispatchUpgrade` handler
 * writes its `101` SYNCHRONOUSLY, inside the call that hands it the connection, so those bytes are already queued in this end by the time a
 * relay can be attached. Attaching the `data` listener drains them — Node's flowing-mode switch, which `Socket` reproduces — so the handshake
 * reaches the client that is waiting for it. An implementation that read the queue only on future writes would present as a connection that
 * opened and then said nothing.
 */
export function relaySocket(socket: Socket, post: (message: TransportSocketUpstreamMessage) => void, id: number): (message: { readonly type: string; readonly data?: unknown; readonly reason?: unknown }) => void {
  socket.on("data", (chunk: unknown) => post({ type: "socket-data", id, data: chunk as Uint8Array }));
  socket.on("end", () => post({ type: "socket-end", id }));
  socket.on("close", () => post({ type: "socket-close", id }));
  return (message) => {
    // Every inbound message is written INTO this end rather than somewhere else, because the peer is whatever the local side linked: on the
    // process side that is the handler's own socket, on the kernel side it is the client. One call, and neither side knows which it is.
    if (message.type === "socket-data") {
      if (message.data instanceof Uint8Array) socket.write(message.data);
      return;
    }
    if (message.type === "socket-end") {
      socket.end();
      return;
    }
    if (message.type === "socket-close") {
      socket.destroy(message.reason === undefined ? undefined : new Error(String(message.reason)));
    }
  };
}

/** The slice of `MessagePort` this module needs. Narrow so a test can supply a pair without a browser. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  close?(): void;
}

export interface ProcessTransportOptions {
  /** How long a forwarded request may wait. Matches the preview gateway's own default so a caller sees one number. */
  readonly timeoutMs?: number;
  readonly mountPath?: string;
  /**
   * Ports a process reported, announced when it reports them.
   *
   * A server that keeps serving never settles its run, so a preview list cannot wait for a result to learn its ports (ADR-0034).
   */
  readonly onPorts?: (pid: number, ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]) => void;
}

interface Peer {
  readonly port: MessagePortLike;
  ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[];
}

/** A connection that the far side accepted, with the relay that feeds it. */
interface OpenConnection {
  readonly pid: number;
  readonly socket: Socket;
  readonly deliver: (message: { readonly type: string; readonly data?: unknown; readonly reason?: unknown }) => void;
}

interface OpeningConnection {
  readonly pid: number;
  readonly socket: Socket;
  readonly settle: (result: TransportUpgradeResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Pending {
  readonly resolve: (response: TransportWireResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Where partial events for this request go, when the caller asked to receive the response as it is written. */
  readonly sink: TransportSink | undefined;
}

const text = (statusCode: number, message: string): TransportWireResponse => ({
  statusCode,
  statusMessage: "",
  headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(new TextEncoder().encode(message).byteLength) },
  body: new TextEncoder().encode(message),
});

/**
 * The port a preview URL addresses, or `undefined`.
 *
 * Lives here rather than in the gateway because the kernel needs the same answer to pick a process, and two parsers for one
 * path convention is how `/preview/3000/preview/4000/x` starts routing to port 3000 in one place and 4000 in another.
 */
export function portFromPreviewUrl(url: string, mountPath = DEFAULT_TRANSPORT_MOUNT): number | undefined {
  let path = url;
  // Absolute URLs are legal here: a Node-side probe has no browser to strip the origin for it.
  const scheme = path.indexOf("://");
  if (scheme !== -1) {
    const slash = path.indexOf("/", scheme + 3);
    path = slash === -1 ? "/" : path.slice(slash);
  }
  const query = path.indexOf("?");
  if (query !== -1) path = path.slice(0, query);
  const hash = path.indexOf("#");
  if (hash !== -1) path = path.slice(0, hash);

  const prefix = mountPath.endsWith("/") ? mountPath.slice(0, -1) : mountPath;
  if (!path.startsWith(`${prefix}/`)) return undefined;
  const rest = path.slice(prefix.length + 1);
  const slash = rest.indexOf("/");
  const candidate = slash === -1 ? rest : rest.slice(0, slash);
  if (candidate === "" || !/^\d+$/.test(candidate)) return undefined;
  const port = Number(candidate);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export class ProcessTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessTransportError";
  }
}

/**
 * Routes preview requests to the process that owns the port, and back.
 *
 * Every failure is answered rather than thrown at the caller, because the caller is a service worker answering a real browser
 * request: a rejection there is a network error with no explanation, and the two failures a user actually meets (nothing is
 * listening, something is listening and stuck) deserve different words.
 */
export class ProcessTransportBroker {
  readonly #peers = new Map<number, Peer>();
  /** Who to tell when a process reports its ports. A list, not one hook: the kernel forwards and a test may observe. */
  readonly #portListeners = new Set<(pid: number, ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]) => void>();
  /** Open connections, by their own id space: a request id and a connection id answering to different maps is what keeps one from settling the other. */
  readonly #open = new Map<number, OpenConnection>();
  readonly #opening = new Map<number, OpeningConnection>();
  #nextSocketId = 1;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  readonly #timeoutMs: number;
  readonly #mountPath: string;

  constructor(options: ProcessTransportOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (options.onPorts !== undefined) this.#portListeners.add(options.onPorts);
    this.#mountPath = options.mountPath ?? DEFAULT_TRANSPORT_MOUNT;
  }

  /** Start answering for a process. The reply channel is the process's, and its lifecycle is the process's. */
  attach(pid: number, port: MessagePortLike): void {
    this.detach(pid);
    const peer: Peer = { port, ports: [] };
    this.#peers.set(pid, peer);
    port.onmessage = (event) => this.#onMessage(pid, event.data);
  }

  /** Feed a raw `ports` message from a process. Validation lives here, so one message cannot be trusted in two places. */
  accept(pid: number, data: unknown): void {
    this.#onMessage(pid, data);
  }

  /**
   * Where a port report is ANNOUNCED, as opposed to where it is validated.
   *
   * Announced from this funnel rather than from `accept`, because a real process's report arrives on its own MessagePort and never passes
   * through `accept` at all: a hook there fires for the kernel's tests and never for a program.
   */
  onPorts(listener: (pid: number, ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]) => void): void {
    this.#portListeners.add(listener);
  }

  /** Replace a process's port list. Idempotent: a Worker that reports the same list twice is not an error. */
  setPorts(pid: number, ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]): void {
    const peer = this.#peers.get(pid);
    if (peer === undefined) return;
    peer.ports = [...ports];
  }

  portsOf(pid: number): readonly { readonly protocol: ServeProtocol; readonly port: number }[] {
    return [...(this.#peers.get(pid)?.ports ?? [])];
  }

  /** Which process answers for this port. First pid wins, because a duplicate binding is a bug in the binder, not a tie. */
  ownerOf(port: number, protocol: ServeProtocol = "http"): number | undefined {
    for (const [pid, peer] of this.#peers) {
      if (peer.ports.some((binding) => binding.protocol === protocol && binding.port === port)) return pid;
    }
    return undefined;
  }

  /** Every port any process is serving, in pid order. What a preview list shows. */
  bindings(): readonly { readonly pid: number; readonly protocol: ServeProtocol; readonly port: number }[] {
    return [...this.#peers.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([pid, peer]) => peer.ports.map((binding) => ({ pid, protocol: binding.protocol, port: binding.port })));
  }

  /**
   * Open a connection to the server a process owns on `port`, for a protocol switch.
   *
   * Asynchronous where the in-process `gateway.upgrade()` is synchronous, and for an honest reason: the listener lives in another global, so
   * the answer has to come back as a message. The refusal wording matches the gateway's, because a user meets both as the same sentence.
   *
   * The socket is created BEFORE the request is sent, so bytes the handler writes inside its `upgrade` handler have somewhere to land: a
   * handshake written synchronously is the ordinary case, and it would otherwise arrive for a connection the kernel had not built yet.
   */
  upgrade(port: number, path: string, headers: Readonly<Record<string, string>>): Promise<TransportUpgradeResult> {
    const pid = this.ownerOf(port);
    const peer = pid === undefined ? undefined : this.#peers.get(pid);
    if (pid === undefined || peer === undefined) {
      return Promise.resolve({ accepted: false, reason: `No preview server is listening on port ${port}. Start one with server.listen(${port}).` });
    }
    const transport = peer.port;
    const id = this.#nextSocketId;
    this.#nextSocketId += 1;
    // A linked pair, so the client holds one end and the relay watches the other. That is what makes this function the SAME code the process
    // Worker runs: a peerless socket would need a second mechanism for the outbound direction, and two mechanisms are two orderings.
    const { local, remote } = linkSockets();
    const socket = remote;
    let live = true;
    const deliver = relaySocket(local, (message) => {
      // A connection to a detached process is closed, not written into: the port's owner is gone and its onmessage is null.
      if (live) transport.postMessage(message);
    }, id);

    return new Promise<TransportUpgradeResult>((resolve) => {
      const timer = setTimeout(() => {
        // The far side never said yes or no. Both maps drop the entry and the socket is destroyed, so nothing is left waiting for a
        // connection that will not be accepted.
        this.#opening.delete(id);
        this.#open.delete(id);
        socket.destroy();
        resolve({ accepted: false, reason: `port ${port} did not accept the upgrade within ${this.#timeoutMs} ms` });
      }, this.#timeoutMs);
      this.#opening.set(id, { pid, socket, settle: resolve, timer });
      this.#open.set(id, { pid, socket, deliver });
      const message: TransportSocketOpenMessage = { type: "socket-open", id, port, path, headers };
      transport.postMessage(message);
    });
  }

  /** Close a connection the kernel opened, telling the process rather than leaving it to notice. */
  closeSocket(socket: Socket): void {
    for (const [id, connection] of this.#open) {
      if (connection.socket !== socket) continue;
      this.#open.delete(id);
      this.#opening.delete(id);
      this.#peers.get(connection.pid)?.port.postMessage({ type: "socket-close", id } satisfies TransportSocketDownstreamMessage);
      return;
    }
  }

  /**
   * Drop a process. Any request waiting on it fails NOW rather than at its deadline: the process is gone, so waiting is
   * waiting for something that cannot arrive, and a killed server should read as "nothing is listening" immediately.
   */
  detach(pid: number): void {
    const peer = this.#peers.get(pid);
    if (peer === undefined) return;
    peer.port.onmessage = null;
    this.#peers.delete(pid);
    // A connection to a dead process is not idle, it is over. Destroying it here is what makes the client see `close` instead of waiting
    // for a frame that can never arrive.
    for (const [id, connection] of [...this.#open]) {
      if (connection.pid !== pid) continue;
      this.#open.delete(id);
      this.#opening.delete(id);
      connection.socket.destroy();
    }
    for (const [id, opening] of [...this.#opening]) {
      if (opening.pid !== pid) continue;
      this.#opening.delete(id);
      clearTimeout(opening.timer);
      opening.settle({ accepted: false, reason: `The process serving this port (pid ${pid}) has stopped.` });
    }
    for (const [id, pending] of this.#pending) {
      if (this.#waitingFor.get(id) !== pid) continue;
      this.#waitingFor.delete(id);
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(text(503, `The process serving this request (pid ${pid}) has stopped.`));
    }
  }

  /** Which pid a pending request belongs to, so `detach` can fail exactly its own. Separate map to keep the hot path small. */
  readonly #waitingFor = new Map<number, number>();

  close(): void {
    for (const pid of [...this.#peers.keys()]) this.detach(pid);
    for (const opening of this.#opening.values()) clearTimeout(opening.timer);
    this.#opening.clear();
    this.#open.clear();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(text(503, "The runtime was torn down before this request was answered."));
    }
    this.#waitingFor.clear();
  }

  /**
   * Forward a preview request to the process that answers for its port.
   *
   * Three answers, each naming what actually happened: 400 for a URL that addresses no port, 503 for a port nobody is
   * serving, 504 for a process that accepted the request and did not answer in time.
   */
  async handle(request: TransportWireRequest, sink?: TransportSink): Promise<TransportWireResponse> {
    const port = portFromPreviewUrl(request.url, this.#mountPath);
    if (port === undefined) return text(400, `Not a preview request: ${request.url}`);
    const pid = this.ownerOf(port);
    if (pid === undefined) return text(503, `Nothing is listening on port ${String(port)}.`);
    const peer = this.#peers.get(pid);
    if (peer === undefined) return text(503, `Nothing is listening on port ${String(port)}.`);

    const id = this.#nextId;
    this.#nextId += 1;
    const answer = new Promise<TransportWireResponse>((resolve) => {
      const timer = setTimeout(() => {
        // The correlation entry is removed BEFORE resolving: a late reply must find nothing, or it resolves a request that has
        // already been answered and the next request's id maps to the wrong promise.
        this.#pending.delete(id);
        this.#waitingFor.delete(id);
        resolve(text(504, `port ${String(port)} did not answer within ${String(this.#timeoutMs)} ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, timer, sink });
      this.#waitingFor.set(id, pid);
    });

    try {
      const message: TransportRequestMessage = {
        type: "transport-request",
        id,
        request,
        ...(sink === undefined ? {} : { stream: true }),
      };
      peer.port.postMessage(message);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        this.#waitingFor.delete(id);
      }
      return text(503, `Could not reach the process serving port ${String(port)}: ${(error as Error).message}`);
    }

    return answer;
  }

  #onMessage(pid: number, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const message = data as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly ports?: unknown;
      readonly response?: unknown;
      readonly reason?: unknown;
      readonly event?: unknown;
      readonly data?: unknown;
    };
    if (message.type === "ports") {
      if (!Array.isArray(message.ports)) return;
      // Validated once and used twice, so the announcement and the peer's list can never disagree about what a process reported. The
      // announcement does not depend on the peer still being attached, because a port report can arrive as its process is ending.
      const reported = message.ports.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { protocol, port } = entry as { readonly protocol?: unknown; readonly port?: unknown };
        if (protocol !== "http" && protocol !== "https") return [];
        if (typeof port !== "number" || !Number.isInteger(port)) return [];
        return [{ protocol, port } satisfies { readonly protocol: ServeProtocol; readonly port: number }];
      });
      for (const listener of this.#portListeners) listener(pid, reported);
      this.setPorts(pid, reported);
      return;
    }
    if (message.type === "socket-accepted" || message.type === "socket-refused") {
      if (typeof message.id !== "number") return;
      const opening = this.#opening.get(message.id);
      if (opening === undefined) return;
      clearTimeout(opening.timer);
      this.#opening.delete(message.id);
      if (message.type === "socket-accepted") {
        opening.settle({ accepted: true, socket: opening.socket });
        return;
      }
      // A refusal is a finished connection, not a waiting one: the socket is destroyed so a client that ignored the refusal sees `close`
      // rather than a connection that never says anything.
      this.#open.delete(message.id);
      opening.socket.destroy();
      opening.settle({ accepted: false, reason: typeof message.reason === "string" ? message.reason : "the process refused the upgrade" });
      return;
    }
    if (message.type === "socket-data" || message.type === "socket-end" || message.type === "socket-close") {
      if (typeof message.id !== "number") return;
      const connection = this.#open.get(message.id);
      if (connection === undefined) return;
      if (message.type === "socket-close") this.#open.delete(message.id);
      connection.deliver({ type: message.type, data: message.data, reason: message.reason });
      return;
    }
    if (message.type === "transport-event") {
      if (typeof message.id !== "number") return;
      const waiting = this.#pending.get(message.id);
      // No pending entry means the request already answered or timed out. Forwarding now would deliver bytes for a response the caller
      // has stopped listening to, out of order, into whatever came next.
      if (waiting?.sink === undefined) return;
      const event = message.event as TransportEvent | undefined;
      if (event === undefined || (event.kind !== "start" && event.kind !== "chunk")) return;
      if (event.kind === "start") {
        if (typeof event.statusCode !== "number") return;
        waiting.sink({
          kind: "start",
          statusCode: event.statusCode,
          statusMessage: typeof event.statusMessage === "string" ? event.statusMessage : "",
          headers: (event.headers ?? {}) as Readonly<Record<string, string>>,
        });
        return;
      }
      waiting.sink({ kind: "chunk", body: event.body instanceof Uint8Array ? event.body : new Uint8Array() });
      return;
    }
    if (message.type !== "transport-reply" && message.type !== "transport-error") return;
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    this.#waitingFor.delete(message.id);
    if (message.type === "transport-error") {
      const reason = typeof message.reason === "string" ? message.reason : "the process failed while answering";
      pending.resolve(text(500, reason));
      return;
    }
    const response = message.response as TransportWireResponse | undefined;
    if (response === undefined || typeof response.statusCode !== "number") {
      pending.resolve(text(500, "The process answered with a malformed response."));
      return;
    }
    pending.resolve({
      statusCode: response.statusCode,
      statusMessage: typeof response.statusMessage === "string" ? response.statusMessage : "",
      headers: response.headers ?? {},
      body: response.body ?? new Uint8Array(),
      ...(response.streamed === true ? { streamed: true } : {}),
    });
  }
}
