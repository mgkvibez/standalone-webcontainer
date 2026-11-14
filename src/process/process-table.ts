/**
 * The process table.
 *
 * ADR-0018 replaces "execute a script" with "own a set of processes". Today `ps` is bookkeeping over a serialised queue
 * and `kill` terminates the only Worker, because there is only one. This table is the structure that changes when each
 * process gets its own Worker: it is the authority on which processes exist, what state they are in, and which
 * transitions are legal.
 *
 * Deliberately pure: no Workers, no timers, no I/O. Every rule below is testable in microseconds, which is the point,
 * because the interesting bugs in a process table are bookkeeping bugs: a pid reused while its Worker still runs, a
 * killed process later reported as exited, a terminal state revived.
 *
 * Terminal states stay terminal. A process that exited, failed or was killed cannot run again, because that is exactly
 * how a pid gets reused while its old Worker is still alive and writing to a stdout nobody reads.
 */

import type { Refusal } from "../runtime/refusal.js";

export type ProcessState = "queued" | "running" | "exited" | "failed" | "killed";

const TERMINAL: readonly ProcessState[] = ["exited", "failed", "killed"];

export const isTerminal = (state: ProcessState): boolean => TERMINAL.includes(state);

/** Where a process may go next. Anything not listed throws rather than being quietly ignored. */
const TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  queued: ["running", "failed", "killed"],
  running: ["exited", "failed", "killed"],
  exited: [],
  failed: [],
  killed: [],
};

export interface ProcessEntry<Handle = unknown> {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly startedAt: number;
  /** Opaque to the table: a Worker, a handle, anything the caller needs to reach the process. */
  readonly handle: Handle;
  state: ProcessState;
  endedAt?: number;
  /** Exit code when the process reported one. Absent while queued or running. */
  exitCode?: number;
  /** Why it failed or was killed, so `ps` can explain itself instead of showing a bare state. */
  reason?: string;
  /**
   * The refusal that ended the process, when the runtime made one on purpose (ADR-0014).
   *
   * It belongs on the ENTRY, not only on the settle notification: `ps`, a change listener and a command boundary all read the table, and a
   * refusal that existed only in one transient callback would be visible to whichever caller happened to be listening at that moment.
   */
  refusal?: Refusal;
}

export class UnknownProcessError extends Error {
  constructor(pid: number) {
    super(`No process with pid ${pid}.`);
    this.name = "UnknownProcessError";
  }
}

export class ProcessLimitError extends Error {
  constructor(limit: number) {
    super(`Refusing to start another process: the limit of ${limit} live processes is already reached.`);
    this.name = "ProcessLimitError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(pid: number, from: ProcessState, to: ProcessState) {
    super(`Process ${pid} cannot go from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

export interface ProcessTableOptions<Handle> {
  /** Live processes (queued or running) allowed at once. A runaway spawn loop must hit a wall, not the tab. */
  readonly maxProcesses?: number;
  readonly now?: () => number;
  /** Called after every successful transition, so a UI can redraw without polling. */
  readonly onChange?: (entry: ProcessEntry<Handle>) => void;
}

export class ProcessTable<Handle = unknown> {
  readonly #entries = new Map<number, ProcessEntry<Handle>>();
  readonly #maxProcesses: number;
  readonly #now: () => number;
  readonly #onChange: ((entry: ProcessEntry<Handle>) => void) | undefined;
  #nextPid = 1;

  constructor(options: ProcessTableOptions<Handle> = {}) {
    this.#maxProcesses = options.maxProcesses ?? 8;
    this.#now = options.now ?? (() => Date.now());
    this.#onChange = options.onChange;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Processes that are queued or running: what the limit counts, and what `ps` should show as alive. */
  live(): readonly ProcessEntry<Handle>[] {
    return [...this.#entries.values()].filter((entry) => !isTerminal(entry.state));
  }

  /** Every process ever started in this table, in pid order. */
  all(): readonly ProcessEntry<Handle>[] {
    return [...this.#entries.values()].sort((left, right) => left.pid - right.pid);
  }

  get(pid: number): ProcessEntry<Handle> {
    const entry = this.#entries.get(pid);
    if (entry === undefined) throw new UnknownProcessError(pid);
    return entry;
  }

  /**
   * Throw if another live process would exceed the limit.
   *
   * Separate from `add` because spawning a Worker is expensive and cannot be undone cheaply: a caller has to be able to
   * refuse *before* it spawns, or a failed `add` leaves an orphan Worker running with no row in the table.
   */
  ensureCapacity(): void {
    if (this.live().length >= this.#maxProcesses) throw new ProcessLimitError(this.#maxProcesses);
  }

  /** Start bookkeeping for a process. Returns the pid, so the caller does not have to guess what it got. */
  add(input: { readonly argv: readonly string[]; readonly handle: Handle; readonly state?: ProcessState }): number {
    this.ensureCapacity();
    const pid = this.#nextPid;
    this.#nextPid += 1;
    const entry: ProcessEntry<Handle> = {
      pid,
      argv: [...input.argv],
      handle: input.handle,
      state: input.state ?? "running",
      startedAt: this.#now(),
    };
    this.#entries.set(pid, entry);
    this.#onChange?.(entry);
    return pid;
  }

  /** Move a process to a new state, enforcing both the transition table and the terminal rule. */
  transition(
    pid: number,
    to: ProcessState,
    detail: { readonly exitCode?: number; readonly reason?: string; readonly refusal?: Refusal } = {},
  ): ProcessEntry<Handle> {
    const entry = this.get(pid);
    if (!TRANSITIONS[entry.state].includes(to)) throw new InvalidTransitionError(pid, entry.state, to);

    entry.state = to;
    if (isTerminal(to)) {
      entry.endedAt = this.#now();
      if (detail.exitCode !== undefined) entry.exitCode = detail.exitCode;
      if (detail.reason !== undefined) entry.reason = detail.reason;
      if (detail.refusal !== undefined) entry.refusal = detail.refusal;
    }
    this.#onChange?.(entry);
    return entry;
  }

  /** Kill a live process. Returns false when there was nothing to do, so a repeated `kill` is not an error. */
  kill(pid: number, reason = "killed"): boolean {
    const entry = this.get(pid);
    if (isTerminal(entry.state)) return false;
    this.transition(pid, "killed", { reason });
    return true;
  }
}
