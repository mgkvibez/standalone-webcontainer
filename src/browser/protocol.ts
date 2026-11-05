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

export interface RunRequest {
  readonly type: "run";
  readonly id: number;
  readonly projectId: string;
  readonly processId: number;
  /** Absolute path → contents. The host rebuilds its VFS from this on every run, so projects cannot leak into each other. */
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface PingRequest {
  readonly type: "ping";
  readonly id: number;
}

export interface ConnectTransportMessage {
  readonly type: "connect-transport";
  /** A generic request/reply channel. The supervisor does not interpret origins or URL hosts. */
  readonly port: MessagePort;
}

export interface StopServersRequest {
  readonly type: "stop-servers";
  readonly id: number;
  readonly ports: readonly number[];
}

export type ClientMessage = RunRequest | PingRequest | ConnectTransportMessage | StopServersRequest;

export interface TransportRequest {
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface TransportResponse {
  readonly type: "response";
  readonly id: string;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface TransportError {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
}

export type TransportMessage = TransportRequest;
export type TransportReply = TransportResponse | TransportError;

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

export type ServerMessage = OutputChunk | RunResultMessage | FailureMessage | PongMessage | ServersStoppedMessage;
