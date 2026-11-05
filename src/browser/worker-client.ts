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

import type { RuntimeClient, RuntimeRunOutcome, RuntimeRunRequest } from "../container/types.js";
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
      files: request.files,
      entry: request.entry,
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
    };
    worker.postMessage(message satisfies ClientMessage);
    return outcome;
  }

  /** Kill the host and settle everything in flight. The next `run` starts a new Worker. */
  reset(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      worker.terminate();
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

  #receive(message: ServerMessage): void {
    if (message.type === "pong") return;
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
