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
  | PingRequest
  | ConnectTransportMessage
  | DisconnectTransportMessage
  | StopServersRequest
  | InputMessage
  | ResizeMessage;

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

export type TransportMessage = TransportRequest;
export type TransportReply = TransportStart | TransportChunk | TransportResponse | TransportError;

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

export type ServerMessage = OutputChunk | RunResultMessage | FailureMessage | PongMessage | ServersStoppedMessage | TransportDisconnectedMessage;
