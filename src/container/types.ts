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
  /**
   * Push the project's files into a runtime that is already loaded, without starting a run.
   *
   * A run mirrors the snapshot it carries, which is enough while every change to a project arrives as the prelude to a command. It is not
   * enough for a dev server: the editor writes while the server is already running, and a file that reaches the runtime only on the *next*
   * command never reaches the program that is serving the preview right now. That is why an edit was invisible in the preview even after a
   * reload: the bytes were never there to serve.
   *
   * Optional, and absent means "this client cannot deliver files to a live runtime", which the container reports rather than pretends.
   */
  syncFiles?(request: RuntimeSyncRequest): Promise<FileSyncReport>;
}

/**
 * The files to push into a live runtime.
 *
 * Deliberately partial. A run carries the whole project because it is the authoritative snapshot; a save carries the files it touched, because
 * the alternative is re-reading and re-comparing every installed package on the way to writing one line of a source file.
 */
export interface RuntimeSyncRequest {
  readonly projectId?: string;
  readonly files: Readonly<Record<string, ProjectFileContents>>;
  /**
   * Paths the page deleted.
   *
   * Named rather than inferred: a partial sync cannot tell "this file is gone" from "this file was not mentioned", and guessing would delete a
   * project the first time an editor saved one file.
   */
  readonly removed?: readonly string[];
}

/**
 * What a sync actually did, as evidence.
 *
 * `written` and `removed` are counted because "no change" and "the client ignored me" are otherwise the same response, and a caller that
 * cannot tell them apart will report a preview as up to date when nothing was ever pushed.
 */
export interface FileSyncReport {
  /**
   * Whether a runtime was loaded to receive them.
   *
   * `false` is not a failure: a project with no runtime loaded has no files to update, and the next run mirrors the snapshot anyway. It is
   * reported because a caller that cannot tell "nothing changed" from "nothing received it" will call a preview current when it is not.
   */
  readonly live: boolean;
  readonly written: readonly string[];
  readonly removed: readonly string[];
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
