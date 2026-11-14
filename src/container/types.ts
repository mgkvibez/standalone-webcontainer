/**
 * The container layer's vocabulary.
 *
 * A "process" here is a runtime-managed execution, NOT an operating-system process. There is no fork, no signal, no
 * address space and no scheduler preemption: the browser has one thread inside our Worker, and a script that never yields
 * cannot be preempted. Everything in this file is shaped around that constraint rather than pretending otherwise.
 */

import type { Refusal } from "../runtime/refusal.js";

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
  /**
   * Present only when the runtime declined a capability ON PURPOSE and the program did not handle it (ADR-0014).
   *
   * Without this field the container read a refusal as an ordinary exit 1 with a stack on stderr, which is exactly how a
   * fixture that exists to prove the refusal would have scored a PASS: the assertions pass, the verdict is PASS, and the
   * by-design bucket the gate treats as legitimate stays empty. Carried by reference, never rebuilt from the text.
   */
  refusal?: Refusal;
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
  /** A saved file, handed to the live filesystem so a running program can see the change without a restart. */
  writeFile?(projectId: string, path: string, contents: string): void;
  /** A new window size for a running program. */
  resize?(processId: number, columns: number, rows: number): void;
  /** Hard stop. The only cancellation primitive the runtime offers, because a running script cannot be interrupted. */
  reset(): void;
  /** Stop the servers owned by a completed bootstrap process without discarding the project runtime. */
  stopServers?(ports: readonly number[]): void;
  /**
   * Ports a process is serving, as it reports them.
   *
   * A server that keeps serving never settles its run, so a caller that only learns ports from `run`'s outcome learns them never: this is the
   * channel a preview list needs (ADR-0034).
   */
  onPorts?(listener: (processId: number, ports: readonly number[]) => void): () => void;
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
  /**
   * Present only when an unhandled refusal ended the program (ADR-0014).
   *
   * Optional because most hosts cannot see one: the harness's in-process client carries it, and the product's process Worker
   * does not yet (the exit message it posts is `{type:"exit", code}`). An absent field therefore means "not reported", not
   * "no refusal", and only the fixture lane may treat it as evidence.
   */
  readonly refusal?: Refusal;
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

/**
 * A boundary the terminal keeps on purpose, as opposed to a capability it has not built yet.
 *
 * The distinction is load-bearing for scoring. `restricted` is a legitimate by-design outcome (ADR-0010 amendment 2), and the
 * gate is not allowed to fill that bucket with our own unfinished work, so a policy record exists only where the container
 * means to decline the operation permanently. A named manager it has not implemented (pnpm, yarn) and a shell it has not built
 * carry a reason and no boundary, and reach a verdict as the ordinary failures they are.
 */
export interface CommandBoundary {
  /** Stable policy id, lowercase kebab-case, e.g. `closed-command-set`. */
  readonly policy: string;
  /**
   * Why the boundary exists, in the container's own words.
   *
   * The terminal's message to a user and this sentence answer different questions ("cannot run that" versus "cannot run anything
   * outside this set, because there is no PATH"), and a verdict that quotes only the first is a shrug.
   */
  readonly reason: string;
  /** What to do instead, in the words the terminal would use. */
  readonly alternative: string;
}

/** A line the container declined to run, with everything a verdict needs to explain why. */
export interface CommandBlock {
  /**
   * `refused`: the name is recognised and declined. `unsupported`: the line is outside the closed command set, or is not a
   * well-formed line at all.
   */
  readonly kind: "refused" | "unsupported";
  /** The command name, or the syntax error when the line could not be tokenized. */
  readonly name: string;
  /** Why it did not run, verbatim as the terminal showed it. */
  readonly reason: string;
  /** Present iff the container declines this permanently. Absent means "not implemented yet", which is a failure, not a policy. */
  readonly boundary?: CommandBoundary;
}

/**
 * What one line did, as a value rather than as scrollback.
 *
 * `execute` returns this instead of nothing because the alternative is what the fixture harness used to do: read the terminal
 * afterwards and infer meaning from text a refusal never writes. Sequencing inside the container still uses the exit code; this
 * is the same decision, handed to callers that are not the container.
 */
export interface CommandOutcome {
  /** The status this line left behind: what a `&&` or `||` in a script sequences on. */
  readonly exitCode: number;
  /** Present only when the line was declined rather than run, and the line's own status is a failure. */
  readonly blocked?: CommandBlock;
  /** Present only when a program the line started ended with an unhandled refusal (ADR-0014). */
  readonly refusal?: Refusal;
}
