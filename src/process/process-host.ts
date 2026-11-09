/**
 * One Worker per process.
 *
 * This is the structural change ADR-0018 asks for, and the difference it makes is easy to state: today execution is
 * serialised behind `#runQueue`, `kill` terminates the only Worker, and `ps` is bookkeeping over a queue. Here, each
 * process gets its own Worker, its own syscall channel, and a row in a real process table, so two processes genuinely run
 * at the same time and killing one leaves the other alone.
 *
 * The Worker is injected (`spawn`) because that is the only way to unit-test the bookkeeping in Node, where `Worker` does
 * not exist. The browser lane uses the real one.
 *
 * What this deliberately does not do yet: run the runtime inside the Worker. The Worker is handed its channel, argv, env
 * and pid, and is expected to report `exit` or `failed`; wiring the loader, the shims and the VFS into that Worker is the
 * next step, and pretending it already works would make this file a lie.
 */

import { allocateChannel, type ChannelAllocation, type ChannelSizes } from "./syscall-channel.js";
import { ProcessTable, type ProcessEntry, type ProcessState } from "./process-table.js";

/** The slice of the Worker API this module needs. Narrow on purpose: it is also the seam tests replace. */
export interface ProcessWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export type SpawnWorker = (moduleUrl: string) => ProcessWorkerLike;

export interface StartProcessOptions {
  /** Module URL of the process Worker. Absolute in a browser, which a blob's base URL makes unavoidable. */
  readonly moduleUrl: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Channel capacities. Small by default: a syscall payload is a path or a small buffer, not a file. */
  readonly channelSizes?: ChannelSizes;
}

export interface StartedProcess {
  readonly pid: number;
  readonly allocation: ChannelAllocation;
}

export class ProcessWorkerUnavailableError extends Error {
  constructor() {
    super("No Worker constructor in this environment and no spawn function was supplied.");
    this.name = "ProcessWorkerUnavailableError";
  }
}

const DEFAULT_CHANNEL_SIZES: ChannelSizes = { requestBytes: 64 * 1024, responseBytes: 256 * 1024 };

const defaultSpawn: SpawnWorker = (moduleUrl) => {
  if (typeof Worker === "undefined") throw new ProcessWorkerUnavailableError();
  // eslint-disable-next-line no-undef -- the browser lane provides Worker; Node does not, which is why spawn is injectable.
  const worker = new Worker(moduleUrl, { type: "module" });
  return worker as unknown as ProcessWorkerLike;
};

export interface ProcessHostOptions {
  readonly spawn?: SpawnWorker;
  readonly maxProcesses?: number;
  readonly onChange?: (entry: ProcessEntry<ProcessWorkerLike>) => void;
}

export interface ProcessExitReport {
  readonly type: "exit";
  readonly code?: number;
  readonly reason?: string;
}

export class ProcessHost {
  readonly #table: ProcessTable<ProcessWorkerLike>;
  readonly #spawn: SpawnWorker;
  readonly #channels = new Map<number, ChannelAllocation>();

  constructor(options: ProcessHostOptions = {}) {
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#table = new ProcessTable<ProcessWorkerLike>({
      maxProcesses: options.maxProcesses ?? 8,
      ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
    });
  }

  get table(): ProcessTable<ProcessWorkerLike> {
    return this.#table;
  }

  /** Allocate a channel, spawn the Worker, tell it who it is. Throws before spawning if the limit is reached. */
  start(options: StartProcessOptions): StartedProcess {
    const sizes = options.channelSizes ?? DEFAULT_CHANNEL_SIZES;
    // Refuse before spawning: a Worker that exists is already doing work, and a rejected `add` would leave it orphaned
    // with no row in the table, which is exactly the leak a process table is supposed to prevent.
    this.#table.ensureCapacity();
    // Allocation happens before the pid so a spawn failure cannot leave a half-registered process behind.
    const allocation = allocateChannel(sizes);
    const worker = this.#spawn(options.moduleUrl);

    const pid = this.#table.add({ argv: options.argv, handle: worker });
    this.#channels.set(pid, allocation);

    worker.onmessage = (event) => this.#onWorkerMessage(pid, event.data);
    worker.onerror = (event) => this.#fail(pid, event.message ?? "worker error");
    worker.postMessage({
      type: "start",
      pid,
      argv: [...options.argv],
      env: { ...(options.env ?? {}) },
      buffer: allocation.buffer,
      sizes: allocation.sizes,
    });

    return { pid, allocation };
  }

  channelFor(pid: number): ChannelAllocation {
    const allocation = this.#channels.get(pid);
    if (allocation === undefined) throw new Error(`No syscall channel for pid ${pid}.`);
    return allocation;
  }

  /** Live channels, in pid order, for a kernel loop that serves them. */
  channels(): readonly { readonly pid: number; readonly allocation: ChannelAllocation }[] {
    return this.#table
      .live()
      .map((entry) => ({ pid: entry.pid, allocation: this.channelFor(entry.pid) }));
  }

  /** Terminate a process. Idempotent: killing something already finished returns false rather than throwing. */
  kill(pid: number, reason = "killed"): boolean {
    const entry = this.#table.get(pid);
    const killed = this.#table.kill(pid, reason);
    if (killed) this.#retire(entry.handle);
    return killed;
  }

  /** Mark a process finished. Called from the Worker's own exit report or from a failure. */
  finish(pid: number, state: Extract<ProcessState, "exited" | "failed">, detail: { readonly exitCode?: number; readonly reason?: string } = {}): void {
    const entry = this.#table.get(pid);
    if (!["exited", "failed"].includes(entry.state)) {
      this.#table.transition(pid, state, detail);
      this.#retire(entry.handle);
    }
  }

  #onWorkerMessage(pid: number, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const message = data as { readonly type?: unknown; readonly code?: unknown; readonly reason?: unknown };
    if (message.type === "exit") {
      this.finish(pid, "exited", {
        ...(typeof message.code === "number" ? { exitCode: message.code } : {}),
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      });
      return;
    }
    if (message.type === "failed") {
      this.finish(pid, "failed", { reason: typeof message.reason === "string" ? message.reason : "worker reported failure" });
    }
  }

  #fail(pid: number, reason: string): void {
    this.finish(pid, "failed", { reason });
  }

  /** Terminate the Worker and drop the channel. Called once per process: after this the pid is history, not a handle. */
  #retire(worker: ProcessWorkerLike): void {
    try {
      worker.terminate();
    } catch {
      // A Worker that already died throws on terminate in some engines. The outcome is what we wanted anyway.
    }
  }
}
