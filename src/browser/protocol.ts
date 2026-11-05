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

export type ClientMessage = RunRequest | PingRequest;

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

export type ServerMessage = OutputChunk | RunResultMessage | FailureMessage | PongMessage;
