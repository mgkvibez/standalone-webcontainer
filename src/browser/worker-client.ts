/**
 * Page-side client for the runtime host.
 *
 * Two responsibilities, both about honesty:
 *
 * 1. **Correlation.** Every request carries an id; a chunk or result for an id nobody is waiting for is dropped rather
 *    than rendered, so a killed run's late output can never appear in a later command's output.
 * 2. **Termination.** `reset()` kills the Worker, which is the only way to stop a script that never yields. Pending runs
 *    resolve as `killed` immediately so the caller is not left waiting on a host that no longer exists.
 *
 * A fresh Worker is started lazily by the next run, so termination costs nothing until it is needed.
 */

import type { FileSyncReport, RuntimeClient, RuntimeRunOutcome, RuntimeRunRequest, RuntimeSyncRequest } from "../container/types.js";
import type { ClientMessage, RunRequest, ServerMessage } from "./protocol.js";

interface Pending {
  readonly resolve: (outcome: RuntimeRunOutcome) => void;
  readonly onOutput: (stream: "stdout" | "stderr", text: string) => void;
  readonly stdout: { text: string };
  readonly stderr: { text: string };
}

const createWorker = (): Worker =>
  new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module", name: "runtime-host" });

export class WorkerRuntimeClient implements RuntimeClient {
  #worker: Worker | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  /** Sync replies, kept apart from runs because they carry a report rather than an outcome and share only the id space. */
  readonly #syncs = new Map<number, { readonly resolve: (report: FileSyncReport) => void; readonly reject: (error: Error) => void }>();
  #lastError: string | null = null;

  /** Why the host last failed, for the UI. Never thrown: an uncaught Worker error would take the page's listener with it. */
  get lastError(): string | null {
    return this.#lastError;
  }

  alive(): boolean {
    return this.#worker !== null;
  }

  #ensureWorker(): Worker {
    if (this.#worker !== null) return this.#worker;
    const worker = createWorker();
    worker.onmessage = (event: MessageEvent<ServerMessage>): void => {
      this.#receive(event.data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      this.#fail(event.message === "" ? "runtime host crashed" : event.message);
    };
    this.#worker = worker;
    return worker;
  }

  async run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    const stdout = { text: "" };
    const stderr = { text: "" };

    const outcome = new Promise<RuntimeRunOutcome>((resolve) => {
      this.#pending.set(id, { resolve, onOutput: request.onOutput, stdout, stderr });
    });

    const message: RunRequest = {
      type: "run",
      id,
      projectId: request.projectId ?? "default",
      processId: request.processId ?? id,
      files: request.files,
      entry: request.entry,
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      ...(request.terminal === undefined ? {} : { terminal: request.terminal }),
    };
    worker.postMessage(message satisfies ClientMessage);
    return outcome;
  }

  /**
   * Typed text, sent to the Worker where the program that reads it actually runs.
   *
   * Fire-and-forget: there is no acknowledgement, because a keystroke has no reply and a program may already have exited by the
   * time this arrives. The Worker drops input for a process it is not running, so a race here is a no-op rather than an error.
   */
  write(processId: number, text: string): void {
    if (this.#worker === null) return;
    this.#worker.postMessage({ type: "input", processId, text } satisfies ClientMessage);
  }

  /** A new window size. This is what delivers SIGWINCH to a running program. */
  resize(processId: number, columns: number, rows: number): void {
    if (this.#worker === null) return;
    this.#worker.postMessage({ type: "resize", processId, columns, rows } satisfies ClientMessage);
  }

  /**
   * Push the page's files into the loaded runtime, without a run.
   *
   * A client with no Worker has no runtime to receive them, so it answers `live: false` immediately rather than starting one: an editor's save
   * is not a reason to boot a host, and the next run mirrors the snapshot regardless.
   */
  syncFiles(request: RuntimeSyncRequest): Promise<FileSyncReport> {
    const worker = this.#worker;
    if (worker === null) return Promise.resolve({ live: false, written: [], removed: [] });
    const id = this.#nextId++;
    const outcome = new Promise<FileSyncReport>((resolve, reject) => {
      this.#syncs.set(id, { resolve, reject });
    });
    worker.postMessage({
      type: "sync-files",
      id,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      files: request.files,
      ...(request.removed === undefined ? {} : { removed: request.removed }),
    } satisfies ClientMessage);
    return outcome;
  }

  /** Kill the host and settle everything in flight. The next `run` starts a new Worker. */
  reset(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      worker.terminate();
    }
    for (const [id, sync] of this.#syncs) {
      this.#syncs.delete(id);
      sync.resolve({ live: false, written: [], removed: [] });
    }
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.resolve({
        stdout: pending.stdout.text,
        stderr: pending.stderr.text,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        killed: true,
      });
    }
  }

  dispose(): void {
    this.reset();
  }

  /** Attach an origin-neutral request/reply channel to the active supervisor. The caller must attach a new port after a Worker reset. */
  connectTransport(port: MessagePort): number {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    worker.postMessage({ type: "connect-transport", id, port }, [port]);
    return id;
  }

  disconnectTransport(id: number): void {
    if (this.#worker === null) return;
    this.#worker.postMessage({ type: "disconnect-transport", id });
  }

  /** Stop in-memory servers without discarding the project's VFS or supervisor. */
  stopServers(ports: readonly number[]): void {
    if (ports.length === 0 || this.#worker === null) return;
    const id = this.#nextId++;
    this.#worker.postMessage({ type: "stop-servers", id, ports: [...ports] });
  }

  #receive(message: ServerMessage): void {
    if (message.type === "files-synced") {
      const sync = this.#syncs.get(message.id);
      this.#syncs.delete(message.id);
      sync?.resolve({ live: message.live, written: message.written, removed: message.removed });
      return;
    }
    if (message.type === "error" && this.#syncs.has(message.id)) {
      const sync = this.#syncs.get(message.id);
      this.#syncs.delete(message.id);
      this.#lastError = message.message;
      sync?.reject(new Error(message.message));
      return;
    }
    if (message.type === "pong" || message.type === "servers-stopped" || message.type === "transport-disconnected") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return; // Late output from a killed run: dropped, never rendered.

    switch (message.type) {
      case "chunk":
        pending.onOutput(message.stream, message.text);
        if (message.stream === "stdout") pending.stdout.text += message.text;
        else pending.stderr.text += message.text;
        return;
      case "result":
        this.#pending.delete(message.id);
        pending.resolve({
          stdout: message.stdout,
          stderr: message.stderr,
          exitCode: message.exitCode,
          durationMs: message.durationMs,
          timedOut: message.timedOut,
          killed: false,
          ...(message.previewPorts === undefined ? {} : { previewPorts: message.previewPorts }),
        });
        return;
      case "error":
        this.#pending.delete(message.id);
        this.#lastError = message.message;
        pending.onOutput("stderr", `${message.message}\n`);
        pending.resolve({
          stdout: pending.stdout.text,
          stderr: `${pending.stderr.text}${message.message}\n`,
          exitCode: 1,
          durationMs: 0,
          timedOut: false,
          killed: false,
        });
        return;
    }
  }

  #fail(message: string): void {
    this.#lastError = message;
    for (const [id, sync] of this.#syncs) {
      this.#syncs.delete(id);
      sync.resolve({ live: false, written: [], removed: [] });
    }
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.onOutput("stderr", `${message}\n`);
      pending.resolve({
        stdout: pending.stdout.text,
        stderr: `${pending.stderr.text}${message}\n`,
        exitCode: 1,
        durationMs: 0,
        timedOut: false,
        killed: false,
      });
    }
    this.#worker = null;
  }
}
