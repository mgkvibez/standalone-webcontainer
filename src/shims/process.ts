/**
 * `process` shim. ADR-0002 #7 puts `process` third in shim priority; ADR-0003 #1
 * assigns it to the unenv preset family, realized here directly so the audit
 * surface stays small (ADR-0004, D-1).
 *
 * Deliberate choices the audit should look at (ADR-0004, D-3):
 * - `platform` is "browser", not "linux". Code that branches on platform should
 *   see where it actually runs; pretending to be linux would change behaviour in
 *   packages that special-case Windows/Linux paths.
 * - `version` is a Node-20-shaped string because many packages gate features on
 *   `process.version`, and ADR-0002 #7 names Node 20 LTS as the API target. It is
 *   a compatibility claim, not a claim to be Node's runtime.
 */
import type { TickQueue } from "../runtime/ticks.js";
export class ProcessExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExit";
    this.code = code;
  }
}

export interface WritableSink {
  write(chunk: string | Uint8Array): boolean;
  readonly text: string;
}

export interface ProcessShim {
  readonly env: Record<string, string>;
  readonly argv: string[];
  readonly execArgv: string[];
  readonly platform: string;
  readonly version: string;
  readonly versions: { readonly node: string };
  readonly browser: boolean;
  readonly pid: number;
  cwd(): string;
  exit(code?: number): never;
  nextTick(callback: () => void, ...args: unknown[]): void;
  stdout: WritableSink;
  stderr: WritableSink;
  readonly on: (event: string, listener: () => void) => ProcessShim;
}

/**
 * `onChunk` is how a live terminal sees output while the program is still running. Without it a sink is a buffer that is
 * only read after the run, which is all the fixture harness ever needed and not enough for a process table.
 *
 * The listener is called BEFORE the buffer grows by the same text, so a stream consumer sees exactly what the final
 * snapshot will contain, in the same order, and no framing is invented (no line splitting, no prefixes).
 */
export const createSink = (onChunk?: (text: string) => void): WritableSink => {
  let buffer = "";
  return {
    write(chunk) {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      buffer += text;
      onChunk?.(text);
      return true;
    },
    get text() {
      return buffer;
    },
  };
};

export interface ProcessOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdout?: WritableSink;
  readonly stderr?: WritableSink;
  /**
   * The run's nextTick queue. Passed in rather than created here so the runner can observe it when deciding whether the
   * run has settled; a queue owned by the shim would be invisible to the thing waiting on it.
   */
  readonly ticks?: TickQueue;
}

export const createProcessShim = (options: ProcessOptions = {}): ProcessShim => {
  const stdout = options.stdout ?? createSink();
  const stderr = options.stderr ?? createSink();
  const argv = options.argv !== undefined ? [...options.argv] : ["node"];
  const cwd = options.cwd ?? "/";

  const shim: ProcessShim = {
    env: { ...(options.env ?? {}) },
    argv,
    execArgv: [],
    platform: "browser",
    version: "v20.0.0",
    versions: { node: "20.0.0" },
    browser: true,
    pid: 1,
    cwd: () => cwd,
    exit: (code = 0) => {
      throw new ProcessExit(code);
    },
    nextTick: (callback, ...args) => {
      // A real tick queue, drained before promise continuations (see runtime/ticks.ts). It used to be queueMicrotask,
      // which put ticks in the same queue as promises and produced a different order than Node in three differential
      // cases.
      const ticks = options.ticks;
      if (ticks === undefined) {
        // No runner supplied a queue: still correct on its own, just unobservable to a waiter.
        queueMicrotask(() => callback(...(args as [])));
        return;
      }
      ticks.schedule(callback, args);
    },
    stdout,
    stderr,
    // No signals or real event loop yet. Returning the shim keeps chaining
    // code (`process.on(...).on(...)`) from crashing; the gap is recorded in
    // ADR-0004 rather than hidden by a stub that pretends to work.
    on: () => shim,
  };

  return shim;
};
