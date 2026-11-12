/**
 * The kernel: a filesystem, a process table, and the servers those processes own.
 *
 * This is the piece the audit called "built, not wired". `ProcessHost` spawns a Worker per process and `ProcessTransportBroker`
 * routes preview requests to the process that owns the port, but nothing yet connected them to a filesystem that outlives a
 * single run, which is what a project needs: `npm install` writes `node_modules`, and a later `node server.js` has to read it.
 * In the serialised supervisor the VFS lives beside one runtime and every run is a new one; here the VFS is the kernel's and the
 * processes are clients of it.
 *
 * Two properties are deliberate and both are tested:
 *
 * 1. **Serving a channel survives idle gaps.** A process that is listening, or awaiting a timer, is not asking for anything. A
 *    kernel loop that stopped at the first quiet 250 ms would look fine in a test where the program is busy and fail the moment a
 *    server idles, which is the normal state of a dev server.
 * 2. **Stopping is per process.** Killing one process closes its channel and drops its ports; the others keep being served. That is
 *    the whole claim of ADR-0018 in one sentence, and it is why this is not the supervisor with a bigger queue.
 *
 * It is not the sandbox either. Every Worker here is on the page origin until ADR-0019 lands (register item W-19).
 */

import { FileSystem } from "../vfs/index.js";
import type { ServeProtocol } from "../network/port-registry.js";
import { createFsSyscallHandler } from "./fs-syscalls.js";
import { ProcessHost, type ProcessWorkerLike, type SpawnWorker } from "./process-host.js";
import type { ProcessEntry, ProcessState } from "./process-table.js";
import { serveChannelAsync, type ChannelAllocation, type ChannelSizes } from "./syscall-channel.js";
import {
  ProcessTransportBroker,
  type MessagePortLike,
  type TransportSink,
  type TransportUpgradeResult,
  type TransportWireRequest,
  type TransportWireResponse,
} from "./process-transport.js";
import type { Socket } from "../shims/socket.js";

export interface ProcessKernelOptions {
  /** Seed files, written before any process starts. Paths are absolute; parents are created. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly spawn?: SpawnWorker;
  readonly maxProcesses?: number;
  readonly onOutput?: (pid: number, channel: "stdout" | "stderr", text: string) => void;
  readonly onChange?: (entry: ProcessEntry<ProcessWorkerLike>) => void;
  /** How long one `serveOne` waits for work before re-checking that the process is still alive. */
  readonly serveTimeoutMs?: number;
  readonly transportTimeoutMs?: number;
  /** Default per-process wall clock. 0 or absent means no limit; a busy loop is still stoppable with `kill`. */
  readonly timeoutMs?: number;
  readonly channelSizes?: ChannelSizes;
}

export interface KernelStartOptions {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Terminal dimensions, when the command has a terminal. Built in the process Worker, beside the program. */
  readonly terminal?: { readonly columns: number; readonly rows: number };
  /** Per-process wall clock. Falls back to the kernel default. */
  readonly timeoutMs?: number;
}

export interface SettledOutcome {
  /** The code the body settled with, or `null` when the process was killed or failed before settling. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly killed: boolean;
  readonly reason?: string;
  /** True when the process is still alive because it owns a listening server. */
  readonly alive: boolean;
}

export interface KernelProcessSummary {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly state: ProcessState;
  readonly exitCode?: number;
  readonly reason?: string;
  readonly ports: readonly number[];
}

/**
 * A port that reports its own changes.
 *
 * The kernel cannot poll a registry inside another thread, and asking the Worker to diff its bindings on a timer would make the
 * preview list lag a `listen()` by up to one tick, which a fixture that asserts on a served request would call flaky. Binding is
 * already the synchronisation point, so the report happens there.
 */
const REPORT_PORTS = "ports";

export class ProcessKernel {
  readonly #files: FileSystem;
  readonly #host: ProcessHost;
  readonly #broker: ProcessTransportBroker;
  /** Per-pid stop functions for the serve loops, so a kill ends the loop rather than leaving it waiting on a dead channel. */
  readonly #serves = new Map<number, () => void>();
  /** Kept so a channel can be closed on teardown even if the loop is mid-wait. */
  readonly #channels = new Map<number, ChannelAllocation>();
  readonly #serveTimeoutMs: number;
  readonly #channelSizes: ChannelSizes | undefined;
  readonly #defaultTimeoutMs: number;
  /** One deferred per process, resolved when its body settles or it reaches a terminal state. */
  readonly #settled = new Map<number, (outcome: SettledOutcome) => void>();
  /** Settles already known, kept so a waiter that arrives late gets the answer instead of hanging. */
  readonly #settlements = new Map<number, SettledOutcome>();
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Scheduler evidence each program reported, so a command boundary can show what its timers actually did. */
  readonly #schedulers = new Map<number, unknown>();
  readonly #changeHandlers: ((entry: ProcessEntry<ProcessWorkerLike>) => void)[] = [];
  #closed = false;

  constructor(options: ProcessKernelOptions = {}) {
    this.#files = new FileSystem();
    for (const [path, contents] of Object.entries(options.files ?? {})) this.writeFile(path, contents);
    this.#serveTimeoutMs = options.serveTimeoutMs ?? 250;
    this.#channelSizes = options.channelSizes;
    this.#defaultTimeoutMs = options.timeoutMs ?? 0;
    this.#broker = new ProcessTransportBroker({
      ...(options.transportTimeoutMs === undefined ? {} : { timeoutMs: options.transportTimeoutMs }),
    });
    this.#host = new ProcessHost({
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
      // `alive` means "held open by something it owns", not "still in a live state": at the moment the exit message arrives the process is
      // still running in the table, so asking the table would call every finished process alive.
      onSettled: (pid, code) => this.#recordSettled(pid, { exitCode: code, timedOut: false, killed: false, alive: this.#broker.portsOf(pid).length > 0 }),
      onChange: (entry) => {
        // A terminal process has no channel to serve and no ports to route. Retiring it here rather than in `kill` covers the
        // ordinary path too, where the program exits by itself.
        if (entry.state === "exited" || entry.state === "failed" || entry.state === "killed") {
          // A killed or failed process may never have settled, and a caller waiting on it must not wait forever: a terminal state is
          // also an answer, and it is the only answer a `while (true)` ever gives.
          this.#recordSettled(entry.pid, {
            exitCode: entry.exitCode ?? null,
            timedOut: false,
            killed: entry.state === "killed",
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
            alive: false,
          });
          this.#retire(entry.pid);
        }
        if (options.onChange !== undefined) options.onChange(entry);
        for (const handler of this.#changeHandlers) handler(entry);
      },
      holdOpen: (pid) => this.#broker.portsOf(pid).length > 0,
      onMessage: (pid, data) => {
        // Ports belong to the broker, which validates the report: two validators for one message is how a port ends up trusted in
        // one place and refused in the other.
        if (typeof data !== "object" || data === null) return;
        const type = (data as { readonly type?: unknown }).type;
        if (type === REPORT_PORTS) this.#broker.accept(pid, data);
        if (type === "scheduler") this.#schedulers.set(pid, (data as { readonly evidence?: unknown }).evidence);
      },
    });
  }

  get files(): FileSystem {
    return this.#files;
  }

  /** Subscribe to process state changes. Returns an unsubscribe function, because a caller that outlives a notification must be able to stop. */
  onProcessChange(handler: (entry: ProcessEntry<ProcessWorkerLike>) => void): () => void {
    this.#changeHandlers.push(handler);
    return () => {
      const index = this.#changeHandlers.indexOf(handler);
      if (index !== -1) this.#changeHandlers.splice(index, 1);
    };
  }

  writeFile(path: string, contents: string | Uint8Array): void {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (parent !== "") this.#files.mkdirSync(parent, { recursive: true });
    this.#files.writeFileSync(path, contents);
  }

  processes(): readonly KernelProcessSummary[] {
    return this.#host.table.all().map((entry) => ({
      pid: entry.pid,
      argv: [...entry.argv],
      state: entry.state,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ports: this.#broker.portsOf(entry.pid).map((binding) => binding.port),
    }));
  }

  /** Ports any live process is serving. What the preview list shows, and what the supervisor reports as `previewPorts`. */
  ports(): readonly { readonly pid: number; readonly protocol: ServeProtocol; readonly port: number }[] {
    return this.#broker.bindings();
  }

  /**
   * Start a process and begin serving its filesystem channel.
   *
   * `start` returns as soon as the Worker exists: the caller is a terminal, and a terminal that blocked until a server exited
   * could not start a second command, which is the entire point of the process model.
   */
  start(options: KernelStartOptions): number {
    if (this.#closed) throw new Error("The kernel has been disposed.");
    const channel = new MessageChannelPort();
    const started = this.#host.start({
      argv: options.argv,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(this.#channelSizes === undefined ? {} : { channelSizes: this.#channelSizes }),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      transport: channel.processSide,
    });
    this.#channels.set(started.pid, started.allocation);
    this.#broker.attach(started.pid, channel.kernelSide);
    void this.#serve(started.pid, started.allocation);

    const limit = options.timeoutMs ?? this.#defaultTimeoutMs;
    if (limit > 0) {
      // A wall clock per process, enforced by terminating ONE Worker. Under the serialised supervisor the same expiry could only be
      // reported for async gaps, because a synchronous loop kept the whole thread hostage; here the thread is the process's own.
      const timer = setTimeout(() => {
        this.#timers.delete(started.pid);
        if (!this.isAlive(started.pid)) return;
        this.kill(started.pid, `timeout after ${String(limit)} ms`);
        this.#recordSettled(started.pid, { exitCode: null, timedOut: true, killed: true, reason: `timeout after ${String(limit)} ms`, alive: false });
      }, limit);
      this.#timers.set(started.pid, timer);
    }
    return started.pid;
  }

  /** Whether a process is still in a live state. */
  isAlive(pid: number): boolean {
    const entry = this.#host.table.get(pid);
    return entry !== undefined && (entry.state === "queued" || entry.state === "running");
  }

  /**
   * Wait until a process's body settles, or it reaches a terminal state.
   *
   * Settling and exiting are different questions and a command boundary needs the first one: a server that has printed "listening" has
   * settled and may stay alive for hours, and a terminal that waited for exit could not run a second command.
   */
  settled(pid: number): Promise<SettledOutcome> {
    const existing = this.#settlements.get(pid);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.#settled.set(pid, resolve);
    });
  }

  /** Type into a process's stdin. `false` when the program is over, which for a keystroke is a no-op rather than an error. */
  input(pid: number, text: string): boolean {
    return this.#host.post(pid, { type: "input", text });
  }

  resize(pid: number, columns: number, rows: number): boolean {
    return this.#host.post(pid, { type: "resize", columns, rows });
  }

  /** Stop the processes that own these ports. What a "stop this server" button asks for. */
  stopServers(ports: readonly number[]): readonly number[] {
    const stopped: number[] = [];
    for (const port of ports) {
      const pid = this.#broker.ownerOf(port);
      if (pid === undefined) continue;
      if (this.kill(pid, `stopped: port ${String(port)}`)) stopped.push(port);
    }
    return stopped;
  }

  /** What the program's scheduler reported, or undefined when it had not finished. */
  schedulerOf(pid: number): unknown {
    return this.#schedulers.get(pid);
  }

  readFile(path: string): string | null {
    try {
      const value = this.#files.readFileSync(path.startsWith("/") ? path : `/${path}`, "utf8");
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }

  unlink(path: string): void {
    try {
      this.#files.unlinkSync(path);
    } catch {
      // A file the program already removed is the ordinary case; the caller's snapshot is authoritative either way.
    }
  }

  /** Forward a preview request to the process that owns the port. Never throws: every failure is a status code. */
  transport(request: TransportWireRequest, sink?: TransportSink): Promise<TransportWireResponse> {
    return this.#broker.handle(request, sink);
  }

  /**
   * Open a connection to the server a process owns, for a protocol switch.
   *
   * The same door `gateway.upgrade()` is inside one runtime, moved across the thread boundary. Never throws: a port nobody serves is a
   * refusal with the sentence the gateway would have used.
   */
  upgrade(port: number, path: string, headers: Readonly<Record<string, string>>): Promise<TransportUpgradeResult> {
    return this.#broker.upgrade(port, path, headers);
  }

  /** Tell a process a connection is finished, rather than leaving its handler writing into a socket nobody reads. */
  closeSocket(socket: Socket): void {
    this.#broker.closeSocket(socket);
  }

  kill(pid: number, reason = "killed"): boolean {
    const killed = this.#host.kill(pid, reason);
    if (killed) this.#retire(pid);
    return killed;
  }

  /** Wait until every process has reached a terminal state. Used by tests and by a `--wait` runner, never by the terminal. */
  async idle(timeoutMs = 30_000): Promise<readonly KernelProcessSummary[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#host.table.live().length === 0) return this.processes();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.processes();
  }

  dispose(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const pid of this.#host.table.live().map((entry) => entry.pid)) this.#host.kill(pid, "kernel disposed");
    this.#broker.close();
    for (const pid of [...this.#serves.keys()]) this.#retire(pid);
  }

  /**
   * Serve one process's filesystem channel until it ends.
   *
   * The loop re-checks liveness every `serveTimeoutMs` rather than awaiting a close event, because there is no close event: a
   * killed process simply stops asking, and a loop waiting forever on a channel nobody writes is a leaked task per kill.
   */
  async #serve(pid: number, allocation: ChannelAllocation): Promise<void> {
    const end = await serveChannelAsync(allocation);
    const handler = createFsSyscallHandler(this.#files, { owner: `pid:${String(pid)}` });
    let stopped = false;
    this.#serves.set(pid, () => {
      stopped = true;
    });
    try {
      while (!stopped && !end.closed()) {
        const answered = await end.serveOne(handler, { timeoutMs: this.#serveTimeoutMs });
        // `false` means either "the channel closed" or "nothing arrived in time". Both are re-checked at the top of the loop, and
        // yielding first keeps a quiet process from starving the others on a single thread.
        if (!answered) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch {
      // A channel that throws is a process that died mid-call. Its table entry already says so; there is nothing to report twice.
    } finally {
      this.#serves.delete(pid);
      try {
        end.close();
      } catch {
        // Closing a channel the other side already abandoned is the expected case here.
      }
    }
  }

  /** Record a settle once. First answer wins, because a killed process settles twice: once as a kill, once as an exit message. */
  #recordSettled(pid: number, outcome: SettledOutcome): void {
    if (this.#settlements.has(pid)) return;
    this.#settlements.set(pid, outcome);
    const timer = this.#timers.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(pid);
    }
    const waiter = this.#settled.get(pid);
    if (waiter !== undefined) {
      this.#settled.delete(pid);
      waiter(outcome);
    }
  }

  #retire(pid: number): void {
    const timer = this.#timers.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(pid);
    }
    this.#serves.get(pid)?.();
    this.#channels.delete(pid);
    this.#broker.detach(pid);
  }
}

/**
 * A `MessageChannel` pair, with the process end typed to what `ProcessHost` transfers.
 *
 * Wrapped rather than used directly so the type of the transferable stays in one place, and so a Node test (where `MessageChannel`
 * exists but `Transferable` does not) does not need a cast at every call site.
 */
class MessageChannelPort {
  readonly #channel = new MessageChannel();
  readonly processSide: MessagePortLike = this.#channel.port1 as unknown as MessagePortLike;
  readonly kernelSide: MessagePortLike = this.#channel.port2 as unknown as MessagePortLike;
}
