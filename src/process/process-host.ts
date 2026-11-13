/**
 * One Worker per process, each one running the real runtime.
 *
 * The structural change ADR-0018 asks for is easy to state: execution used to be serialised behind one queue, `kill`
 * terminated the only Worker, and `ps` was bookkeeping over that queue. Here each process gets its own Worker, its own
 * syscall channel, and a row in a real process table, so two processes genuinely run at once and killing one leaves the
 * other alone.
 *
 * The Worker entry is `process-worker.ts`: it builds a filesystem port over the channel and runs the program from the
 * kernel's filesystem. So a process is not a module that happens to be loaded; it is an argv.
 *
 * The Worker factory is injected because that is the only way to unit-test the bookkeeping in Node, where `Worker` does
 * not exist. The browser lane uses the real one, and the default is a *static* `new URL(...)` so the bundler emits the
 * entry rather than leaving it to be resolved at runtime.
 */

import { allocateChannel, type ChannelAllocation, type ChannelSizes } from "./syscall-channel.js";
import type { MessagePortLike } from "./process-transport.js";
import { ProcessTable, type ProcessEntry, type ProcessState } from "./process-table.js";

/** The slice of the Worker API this module needs. Narrow on purpose: it is also the seam tests replace. */
export interface ProcessWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export type SpawnWorker = () => ProcessWorkerLike;

export interface StartProcessOptions {
  /** `["node", "/main.js"]`. The entry path is resolved against the kernel's filesystem, not against a module URL. */
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /**
   * A dedicated reply channel for preview requests addressed to a server this process owns.
   *
   * Separate from the syscall channel on purpose: a preview request can take seconds (a dev server rebuilding), and the syscall
   * channel carries one in-flight call at a time, so routing HTTP over it would block every filesystem call the program needs in
   * order to answer. Transferred to the Worker, which then owns that end.
   */
  readonly transport?: MessagePortLike;
  /** Channel capacities. Small by default: a syscall payload is a path or a small buffer, not a file. */
  readonly channelSizes?: ChannelSizes;
  /**
   * Terminal dimensions, when the program has a terminal.
   *
   * Forwarded because the Terminal object is built in the Worker that runs the program: `process.stdout.columns` and SIGWINCH belong to
   * the thread reading them, and dims are the only part that can cross.
   */
  readonly terminal?: { readonly columns: number; readonly rows: number };
}

export interface StartedProcess {
  readonly pid: number;
  readonly allocation: ChannelAllocation;
}

export interface ProcessHostOptions {
  readonly spawn?: SpawnWorker;
  readonly maxProcesses?: number;
  readonly onChange?: (entry: ProcessEntry<ProcessWorkerLike>) => void;
  /**
   * Messages the host does not interpret, in arrival order.
   *
   * The host owns three messages (output, exit, failed) and must not grow a case for every subsystem that wants one: ports belong
   * to the transport broker, and a host that parsed them would be a second authority on which process serves what.
   */
  readonly onMessage?: (pid: number, data: unknown) => void;
  /**
   * Whether a process that reported exit must be kept alive anyway.
   *
   * Node's rule, and it is not a detail: a listening server is a ref'd handle, so the event loop stays alive and the process does not
   * exit. The runtime here returns as soon as the program body settles, which is correct for a script and wrong for a dev server, so
   * without this the first `npm run dev` would have its Worker terminated the moment its body returned and the preview would answer
   * 503 for a server that had just printed "listening on 3000".
   *
   * The predicate is asked AT EXIT TIME rather than tracked here, because what keeps a process alive is a property of the process's
   * own servers, which this class does not own.
   */
  readonly holdOpen?: (pid: number) => boolean;
  /**
   * The program's body has settled, whether or not the process is over.
   *
   * This is the event a command boundary waits for, and it is NOT the same as exit: a process held open by a listening server has
   * settled and will never exit on its own. A caller that waited for exit instead would block its terminal on `npm run dev` forever,
   * which is the shape the serialised supervisor already had.
   */
  readonly onSettled?: (pid: number, code: number) => void;
  /**
   * Output as it is written, before the process exits. Without this a long-running program is silent until it ends,
   * which is the difference between a terminal and a log dump.
   */
  readonly onOutput?: (pid: number, channel: "stdout" | "stderr", text: string) => void;
}

export class ProcessWorkerUnavailableError extends Error {
  constructor() {
    super("No Worker constructor in this environment and no spawn function was supplied.");
    this.name = "ProcessWorkerUnavailableError";
  }
}

/**
 * Request 512 KiB, response 256 KiB.
 *
 * The request region was 64 KiB, which is smaller than the files real packages write: vite's optimizer emits a 1.7 MB pre-bundled dependency in one
 * `writeFileSync`, and the write threw on capacity before any of it reached the kernel. 512 KiB lets a chunked write (see `remote-fs.ts`) carry 256 KiB
 * of file per call, so a 2 MB bundle costs eight round trips instead of failing, at a cost of 448 KiB of shared memory per process.
 */
const DEFAULT_CHANNEL_SIZES: ChannelSizes = { requestBytes: 512 * 1024, responseBytes: 256 * 1024 };

/** Only names the Worker in devtools; the pid is assigned by the table after the Worker exists. */
let spawned = 0;

const defaultSpawn: SpawnWorker = () => {
  if (typeof Worker === "undefined") throw new ProcessWorkerUnavailableError();
  spawned += 1;
  // The `new URL(...)` form is what lets the bundler see this entry at build time. A runtime-built string would work in
  // dev and 404 in production, which is the kind of bug that only shows up after deploy.
  const worker = new Worker(new URL("./process-worker.ts", import.meta.url), {
    type: "module",
    name: `process-${spawned}`,
  });
  return worker as unknown as ProcessWorkerLike;
};

export class ProcessHost {
  readonly #table: ProcessTable<ProcessWorkerLike>;
  readonly #spawn: SpawnWorker;
  readonly #channels = new Map<number, ChannelAllocation>();
  readonly #onOutput: ProcessHostOptions["onOutput"];
  readonly #onMessage: ProcessHostOptions["onMessage"];
  readonly #holdOpen: ProcessHostOptions["holdOpen"] | undefined;
  readonly #onSettled: ProcessHostOptions["onSettled"] | undefined;

  constructor(options: ProcessHostOptions = {}) {
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#onOutput = options.onOutput;
    this.#onMessage = options.onMessage;
    this.#holdOpen = options.holdOpen;
    this.#onSettled = options.onSettled;
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
    const worker = this.#spawn();

    const pid = this.#table.add({ argv: options.argv, handle: worker });
    this.#channels.set(pid, allocation);

    worker.onmessage = (event) => this.#onWorkerMessage(pid, event.data);
    worker.onerror = (event) => this.#fail(pid, event.message ?? "worker error");
    const transport = options.transport;
    worker.postMessage(
      {
        type: "start",
        pid,
        argv: [...options.argv],
        env: { ...(options.env ?? {}) },
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
        buffer: allocation.buffer,
        sizes: allocation.sizes,
        ...(transport === undefined ? {} : { transport }),
      },
      // Transfer, not copy: a MessagePort that is cloned rather than transferred arrives with no channel behind it, and the
      // failure looks like a server that never answers.
      transport === undefined ? undefined : [transport as unknown as Transferable],
    );

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
  /**
   * Send a message to a live process Worker.
   *
   * The kernel's only use is a terminal: keystrokes and window sizes belong to a program that runs over THERE, and the object that
   * receives them cannot cross the boundary. `false` means the process is over, which for a keystroke is a no-op rather than an error.
   */
  post(pid: number, message: unknown): boolean {
    const entry = this.#table.get(pid);
    const worker = entry?.handle;
    if (worker === undefined) return false;
    try {
      worker.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  kill(pid: number, reason = "killed"): boolean {
    const entry = this.#table.get(pid);
    const killed = this.#table.kill(pid, reason);
    if (killed) this.#retire(pid, entry.handle);
    return killed;
  }

  /** Mark a process finished. Called from the Worker's own exit report or from a failure. */
  finish(
    pid: number,
    state: Extract<ProcessState, "exited" | "failed">,
    detail: { readonly exitCode?: number; readonly reason?: string } = {},
  ): void {
    const entry = this.#table.get(pid);
    if (!["exited", "failed"].includes(entry.state)) {
      this.#table.transition(pid, state, detail);
      this.#retire(pid, entry.handle);
    }
  }

  #onWorkerMessage(pid: number, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const message = data as {
      readonly type?: unknown;
      readonly code?: unknown;
      readonly reason?: unknown;
      readonly channel?: unknown;
      readonly text?: unknown;
    };
    if (message.type === "output") {
      const channel = message.channel === "stderr" ? "stderr" : "stdout";
      if (typeof message.text === "string") this.#onOutput?.(pid, channel, message.text);
      return;
    }
    if (message.type === "exit") {
      this.#onSettled?.(pid, typeof message.code === "number" ? message.code : 0);
      // Held open by something the process still owns (a listening server). Its state stays live, so it can still be killed and can
      // still be routed to; the exit is remembered rather than acted on.
      if (this.#holdOpen?.(pid) === true) return;
      this.finish(pid, "exited", {
        ...(typeof message.code === "number" ? { exitCode: message.code } : {}),
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      });
      return;
    }
    if (message.type === "failed") {
      this.finish(pid, "failed", {
        reason: typeof message.reason === "string" ? message.reason : "worker reported failure",
      });
      return;
    }
    this.#onMessage?.(pid, data);
  }

  #fail(pid: number, reason: string): void {
    this.finish(pid, "failed", { reason });
  }

  /**
   * Terminate the Worker and drop the channel. Once per process: after this the pid is history, not a handle. Dropping
   * the channel matters because its buffer is shared memory that would otherwise be retained by a table of dead pids.
   */
  #retire(pid: number, worker: ProcessWorkerLike): void {
    this.#channels.delete(pid);
    try {
      worker.terminate();
    } catch {
      // A Worker that already died throws on terminate in some engines. The outcome is what we wanted anyway.
    }
  }
}
