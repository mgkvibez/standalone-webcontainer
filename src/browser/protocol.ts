/**
 * The page ⇄ Worker wire protocol.
 *
 * Deliberately dumb: JSON values only, no functions, no shared memory, no transferables. Every message is addressed by a
 * request id so a reply can never be mistaken for another run's output, and output arrives as `chunk` messages while the
 * program is still running rather than as one blob at the end.
 *
 * The Worker is a thread boundary, not a security boundary. It exists so a hung script cannot freeze the page; it does not
 * contain hostile code, and nothing here should be described as a sandbox.
 */

/** Terminal dimensions, as plain data: a Terminal object cannot cross a thread boundary. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

import type { ProjectFileContents } from "../container/types.js";

export interface RunRequest {
  readonly type: "run";
  readonly id: number;
  readonly projectId: string;
  readonly processId: number;
  /**
   * Absolute path → contents. The host rebuilds its VFS from this on every run, so projects cannot leak into each other.
   *
   * Bytes are allowed and travel unchanged: `postMessage` uses structured clone, which moves a `Uint8Array` natively. Nothing may JSON-encode this
   * message, because a `Uint8Array` through `JSON.stringify` becomes `{"0":0,"1":97,...}` and the corruption that follows is silent.
   */
  readonly files: Readonly<Record<string, ProjectFileContents>>;
  readonly entry: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /**
   * Present when the run has a terminal. The Worker builds the Terminal from these numbers, because the object itself
   * cannot cross the boundary; keystrokes arrive later as `input` messages addressed to the same processId.
   */
  readonly terminal?: TerminalSize;
}

/** Typed text, on its way to a running program's stdin. */
export interface InputMessage {
  readonly type: "input";
  readonly processId: number;
  readonly text: string;
}

/** A new window size for a running program, which is what makes SIGWINCH reach it. */
export interface ResizeMessage {
  readonly type: "resize";
  readonly processId: number;
  readonly columns: number;
  readonly rows: number;
}

export interface PingRequest {
  readonly type: "ping";
  readonly id: number;
}

export interface ConnectTransportMessage {
  readonly type: "connect-transport";
  readonly id: number;
  /** A generic request/reply channel. The supervisor does not interpret origins or URL hosts. */
  readonly port: MessagePort;
}

export interface DisconnectTransportMessage {
  readonly type: "disconnect-transport";
  readonly id: number;
}

export interface TransportDisconnectedMessage {
  readonly type: "transport-disconnected";
  readonly id: number;
}

export interface StopServersRequest {
  readonly type: "stop-servers";
  readonly id: number;
  readonly ports: readonly number[];
}

export type ClientMessage =
  | RunRequest
  | WriteFileMessage
  | PingRequest
  | ConnectTransportMessage
  | DisconnectTransportMessage
  | StopServersRequest
  | InputMessage
  | ResizeMessage;

/**
 * A file the page just saved, delivered to the project's live filesystem.
 *
 * Without this the kernel only ever learns a project's files when a run STARTS (the run carries a snapshot), so an edit made while a program
 * is running is invisible to that program: a dev server could watch its module forever and never hear about the change (W-26).
 */
export interface WriteFileMessage {
  readonly type: "write-file";
  readonly projectId: string;
  readonly path: string;
  readonly contents: string;
}

export interface TransportRequest {
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * The response has started: status and headers, at the moment the handler's first byte was written.
 *
 * Sent only to a consumer that streams (the preview shell is one); a consumer that waits for a single record still gets
 * `TransportResponse` with the whole body and never sees this.
 */
export interface TransportStart {
  readonly type: "start";
  readonly id: string;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Part of a response body, in write order, before the response ends. */
export interface TransportChunk {
  readonly type: "chunk";
  readonly id: string;
  readonly body: Uint8Array;
}

export interface TransportResponse {
  readonly type: "response";
  readonly id: string;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The body already left in `start`/`chunk` messages, so an empty `body` means it went, not that there was none. */
  readonly streamed?: boolean;
}

export interface TransportError {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
}

/**
 * A websocket, from the page's point of view.
 *
 * The page cannot open one: a service worker never sees a handshake, so the preview proxy cannot route it (ADR-0031), and the previewed document
 * is in another realm where the container's own `WebSocket` does not exist. What crosses this boundary instead is the *content* of the socket —
 * open, send, message, close — and the RFC 6455 protocol itself runs in the runtime Worker, using the same client the container already tests
 * against a real server (ADR-0033).
 *
 * That split is deliberate and it is the whole design: framing, masking, fragmentation, ping/pong and close codes live in ONE place, and the
 * boundary only carries what a user's program would have read.
 *
 * `id` is the page's own, echoed back unchanged, so a previewed page can match replies without knowing anything about the runtime's id space.
 */
export interface SocketOpen {
  readonly type: "socket-open";
  readonly id: number;
  /** The port the page was previewing. The runtime resolves it to a server; it is not a URL the page can aim anywhere. */
  readonly port: number;
  /** Request target for the handshake, path plus query, already resolved against the previewed page's location. */
  readonly path: string;
  readonly protocols: readonly string[];
}

/** Exactly one of `text` and `body` is present: what `WebSocket.send` was given, unchanged. */
export interface SocketSend {
  readonly type: "socket-send";
  readonly id: number;
  readonly text?: string;
  readonly body?: Uint8Array;
}

export interface SocketClose {
  readonly type: "socket-close";
  readonly id: number;
  readonly code?: number;
  readonly reason?: string;
}

export type SocketMessage = SocketOpen | SocketSend | SocketClose;

/** The server accepted the handshake. `protocol` is empty when neither side asked for one. */
export interface SocketOpened {
  readonly type: "socket-opened";
  readonly id: number;
  readonly protocol: string;
}

/** A message the page's handlers receive, in the form `binaryType` would have given it. */
export interface SocketData {
  readonly type: "socket-data";
  readonly id: number;
  readonly text?: string;
  readonly body?: Uint8Array;
}

export interface SocketClosed {
  readonly type: "socket-closed";
  readonly id: number;
  readonly code: number;
  readonly reason: string;
  readonly clean: boolean;
}

/** The connection never opened, with a sentence a user can act on: nothing listening, or nothing that speaks this protocol. */
export interface SocketFailed {
  readonly type: "socket-failed";
  readonly id: number;
  readonly message: string;
}

export type SocketReply = SocketOpened | SocketData | SocketClosed | SocketFailed;

export type TransportMessage = TransportRequest | SocketMessage;
export type TransportReply = TransportStart | TransportChunk | TransportResponse | TransportError | SocketReply;

export interface OutputChunk {
  readonly type: "chunk";
  readonly id: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface RunResultMessage {
  readonly type: "result";
  readonly id: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Timer-queue evidence from the runtime (ADR-0013), passed through unchanged. */
  readonly scheduler: unknown;
  /** Servers started by this entrypoint remain owned by the runtime after bootstrap returns. */
  readonly previewPorts?: readonly number[];
}

/**
 * A live process's serving ports, sent when the process reports them.
 *
 * Separate from `result` because a server's run may never settle: this is what puts "preview 5173" next to a process that is still running.
 */
export interface PortsMessage {
  readonly type: "ports";
  readonly processId: number;
  readonly ports: readonly number[];
}

export interface FailureMessage {
  readonly type: "error";
  readonly id: number;
  readonly code: "RUNTIME_ERROR" | "BAD_REQUEST";
  readonly message: string;
  readonly stack?: string;
}

export interface PongMessage {
  readonly type: "pong";
  readonly id: number;
}

export interface ServersStoppedMessage {
  readonly type: "servers-stopped";
  readonly id: number;
  readonly ports: readonly number[];
}

export type ServerMessage =
  | OutputChunk
  | RunResultMessage
  | PortsMessage
  | FailureMessage
  | PongMessage
  | ServersStoppedMessage
  | TransportDisconnectedMessage;
