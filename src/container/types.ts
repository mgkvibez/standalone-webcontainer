/**
 * The container layer's vocabulary.
 *
 * A "process" here is a runtime-managed execution, NOT an operating-system process. There is no fork, no signal, no
 * address space and no scheduler preemption: the browser has one thread inside our Worker, and a script that never yields
 * cannot be preempted. Everything in this file is shaped around that constraint rather than pretending otherwise.
 */

/** Where a process is in its life. `queued` exists because executions are serialised, not concurrent. */
export type ProcessState = "queued" | "running" | "exited" | "failed" | "killed";

export type OutputStream = "stdout" | "stderr";

/** What the terminal shows: program output, our own diagnostics, and the echoed command. */
export type LogStream = OutputStream | "system" | "input";

export interface LogLine {
  readonly stream: LogStream;
  readonly text: string;
}

export interface ProcessRecord {
  readonly pid: number;
  readonly sessionId: string;
  /** The line the user typed, kept verbatim for the process list. */
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly startedAt: number;
  state: ProcessState;
  endedAt?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface Session {
  readonly id: string;
  readonly name: string;
  cwd: string;
  readonly history: string[];
  readonly scrollback: LogLine[];
  readonly processIds: number[];
}

/** What the container needs from a runtime host. Implemented by the Worker client; faked in tests. */
export interface RuntimeClient {
  run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome>;
  /** Hard stop. The only cancellation primitive the runtime offers, because a running script cannot be interrupted. */
  reset(): void;
}

export interface RuntimeRunRequest {
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly onOutput: (stream: OutputStream, text: string) => void;
}

export interface RuntimeRunOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** True when the host was hard-stopped, so the outcome is a termination rather than the program's own exit. */
  readonly killed: boolean;
}

/** The project files the container's file commands operate on. Implemented by the page's project store. */
export interface ProjectFiles {
  /** Stable identity for volatile runtime data such as installed dependencies. */
  readonly projectId?: string;
  /** Every file path, absolute, e.g. `/index.js`. */
  list(): readonly string[];
  /** Every directory path, including ones derived from file paths. */
  listDirs(): readonly string[];
  read(path: string): string | null;
  write(path: string, contents: string): void;
  mkdir(path: string): boolean;
  remove(path: string): boolean;
}
