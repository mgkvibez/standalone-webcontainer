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
  /** Ports owned by a process that has started an in-memory server. */
  previewPorts?: readonly number[];
}

export interface Session {
  readonly id: string;
  readonly name: string;
  cwd: string;
  /**
   * The session's window size, which becomes the terminal size of any process it runs.
   *
   * Plain numbers rather than a Terminal: the Terminal lives in the Worker with the program, and the page can only describe it.
   */
  columns: number;
  rows: number;
  readonly history: string[];
  readonly scrollback: LogLine[];
  readonly processIds: number[];
}

/** What the container needs from a runtime host. Implemented by the Worker client; faked in tests. */
export interface RuntimeClient {
  run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome>;
  /** Typed text for a running program's stdin. Absent on a client that cannot deliver it, which the container treats as no stdin. */
  write?(processId: number, text: string): void;
  /** A new window size for a running program. */
  resize?(processId: number, columns: number, rows: number): void;
  /** Hard stop. The only cancellation primitive the runtime offers, because a running script cannot be interrupted. */
  reset(): void;
  /** Stop the servers owned by a completed bootstrap process without discarding the project runtime. */
  stopServers?(ports: readonly number[]): void;
}

/**
 * A file's contents in a project snapshot.
 *
 * `Uint8Array` is not a convenience here. A package can legitimately ship bytes (`esbuild`'s `.wasm`, a font, a fixture image), and decoding them as
 * text destroys them. Measured: the container's install did exactly that and vite died on `CompileError: WebAssembly.Module(): unknown section code
 * #0x20 @+133`, because an 11 MB WebAssembly module had been through a UTF-8 decode on its way into the runtime. The bytes were never wrong; only
 * their transport was.
 */
export type ProjectFileContents = string | Uint8Array;

export interface RuntimeRunRequest {
  readonly projectId?: string;
  /** Container process id for supervisor-side lifecycle tracking. */
  readonly processId?: number;
  readonly files: Readonly<Record<string, ProjectFileContents>>;
  readonly entry: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Terminal size for this run. Absent means the program has no terminal, which is the truthful default. */
  readonly terminal?: { readonly columns: number; readonly rows: number };
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
  /** Newly listening in-memory server ports created by this invocation, if any. */
  readonly previewPorts?: readonly number[];
  /** Scheduler evidence, when the runtime has a virtual timer queue. */
  readonly scheduler?: unknown;
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
