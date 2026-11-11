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
import { VIRTUAL_ENVIRONMENT } from "../runtime/environment.js";
import { createInertInput, type ProcessStdin, type Terminal, type TerminalInput } from "../terminal/pty.js";
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
  /**
   * Present only when a terminal is attached to the stream. Undefined, not false, when there is none: that is what Node
   * reports for a pipe, and code that checks `if (process.stdout.isTTY)` behaves the same either way while code that
   * compares against `false` gets the truth.
   */
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
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
  /**
   * The program's stdin. Always an object, as in Node.
   *
   * This used to be `null` with no terminal attached, on the reasoning that a program which found nothing could report "no input"
   * honestly. A real package ended that argument: vite's dev server runs `process.stdin.on("end", ...)` unless `process.env.CI` is
   * "true", and `null` made it `TypeError: Cannot read properties of null (reading 'on')` before the server ever listened. So the
   * shim now presents inert input: `isTTY` undefined like a pipe, no data ever, never ending, and `live()` false so a program
   * waiting for input that cannot arrive still finishes instead of hanging. Piped input remains a later piece of work (ADR-0023).
   */
  readonly stdin: ProcessStdin;
  /** Registers a listener for a signal this runtime can deliver. Unknown events are accepted and never fired. */
  readonly on: (event: string, listener: () => void) => ProcessShim;
  readonly off: (event: string, listener: () => void) => ProcessShim;
  /**
   * `on`, removed the first time it fires.
   *
   * Present because vite's dev server opens with `process.once('SIGTERM', …)` (its `setupSIGTERMListener`), and its absence was a
   * `TypeError` that aborted the server before it ever listened: "error when starting dev server: process.once is not a function".
   */
  readonly once: (event: string, listener: () => void) => ProcessShim;
  /** Node's other two names for `on` and `off`. Same functions, because Node documents them as identical. */
  readonly addListener: (event: string, listener: () => void) => ProcessShim;
  readonly removeListener: (event: string, listener: () => void) => ProcessShim;
  /**
   * Drops every signal registration made through this shim.
   *
   * Required because the terminal outlives the process: a UI keeps one terminal across many runs, so a finished program's
   * listener would still fire on the next resize and re-enter code whose scheduler has already run to termination.
   */
  readonly dispose: () => void;
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
  /** The attached terminal, if any. Without one every tty question answers "no" rather than pretending. */
  readonly terminal?: Terminal | null;
  /**
   * The input a program sees, when it has to differ from the terminal's own.
   *
   * The runtime passes a guarded wrapper so that `process.exit` called from a `data` handler ends the run, instead of throwing
   * out of whoever delivered the keystroke. It is an option rather than something the shim builds because the shim has no
   * scheduler to stop: only the run knows how to end itself.
   */
  readonly stdin?: TerminalInput | null;
  /**
   * Called when a listener the runtime invokes throws `process.exit`, so the run can end with that code instead of the throw
   * escaping into whoever happened to call the listener (a resize, a keystroke, a worker message).
   */
  readonly onExit?: (code: number) => void;
}

/**
 * Gives a sink the terminal's live dimensions.
 *
 * Getters, not copies: a program that resizes and then reads `process.stdout.columns` must see the new number, and a snapshot
 * taken at construction would keep answering 80 forever.
 */
const withTerminal = (sink: WritableSink, terminal: Terminal | null | undefined): WritableSink => {
  if (terminal === null || terminal === undefined) return sink;
  return Object.defineProperties(sink, {
    isTTY: { get: () => true, enumerable: true },
    columns: { get: () => terminal.columns, enumerable: true },
    rows: { get: () => terminal.rows, enumerable: true },
  });
};

export const createProcessShim = (options: ProcessOptions = {}): ProcessShim => {
  const terminal = options.terminal ?? null;
  const stdout = withTerminal(options.stdout ?? createSink(), terminal);
  const stderr = withTerminal(options.stderr ?? createSink(), terminal);
  /**
   * Signal wiring. The previous shim returned itself from `on` and registered nothing, which meant `process.on("SIGWINCH", …)`
   * was silently a no-op and a TUI would never redraw: the silent-lie failure this codebase tries not to ship.
   *
   * The map keeps the unsubscribe the terminal handed back, so `off` removes exactly one listener rather than all of them for
   * that event, which is Node's behaviour and the one a listener that re-registers depends on.
   */
  const signalRegistrations = new Map<string, Map<() => void, () => void>>();
  const argv = options.argv !== undefined ? [...options.argv] : ["node"];
  const cwd = options.cwd ?? "/";

  const shim: ProcessShim = {
    // The VM's declared environment underneath whatever the caller passed, so a program starts with the same HOME and TMPDIR whether it
    // runs in-process or inside a Worker. `os.homedir()` reads this very object, which is what makes the two agree by construction rather
    // than by coincidence (see runtime/environment.ts).
    env: { ...VIRTUAL_ENVIRONMENT, ...(options.env ?? {}) },
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
    // Null from the caller (no terminal, or stdin deliberately detached) still yields Node's shape: an object that never speaks.
    stdin: options.stdin ?? (terminal === null ? createInertInput() : terminal.stdin),
    on: (event, listener) => {
      // Only signals the terminal can actually deliver are wired. Anything else is accepted to keep chaining code working, but
      // it is never fired and never claimed: a listener that never runs is better than a listener that runs at the wrong time,
      // and both are worse than the truth, which is that this runtime delivers two signals today.
      if (terminal !== null && (event === "SIGWINCH" || event === "SIGINT")) {
        const existing = signalRegistrations.get(event) ?? new Map<() => void, () => void>();
        if (!existing.has(listener)) {
          // The listener is invoked by the terminal, which knows nothing about exits. Catching here is what keeps
          // `process.exit` inside a SIGWINCH handler from surfacing as an uncaught exception in the page.
          const guard = (): void => {
            try {
              listener();
            } catch (error) {
              if (error instanceof ProcessExit && options.onExit !== undefined) {
                options.onExit(error.code);
                return;
              }
              throw error;
            }
          };
          const unsubscribe = terminal.on(event, guard);
          existing.set(listener, unsubscribe);
          signalRegistrations.set(event, existing);
        }
      }
      return shim;
    },
    once: (event, listener) => {
      // The wrapper is what gets registered, so the removal has to name the wrapper: `off(event, listener)` would look up a key this
      // shim never stored. Building it here and unmounting from inside itself is Node's own shape.
      let fired = false;
      const wrapper = (): void => {
        if (fired) return;
        fired = true;
        shim.off(event, wrapper);
        listener();
      };
      return shim.on(event, wrapper);
    },
    addListener: (event, listener) => shim.on(event, listener),
    removeListener: (event, listener) => shim.off(event, listener),
    dispose: () => {
      for (const registrations of signalRegistrations.values()) for (const unsubscribe of registrations.values()) unsubscribe();
      signalRegistrations.clear();
    },
    off: (event, listener) => {
      const existing = signalRegistrations.get(event);
      const unsubscribe = existing?.get(listener);
      if (unsubscribe !== undefined) {
        unsubscribe();
        existing?.delete(listener);
        if (existing?.size === 0) signalRegistrations.delete(event);
      }
      return shim;
    },
  };

  return shim;
};
