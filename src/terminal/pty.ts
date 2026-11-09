/**
 * The terminal a program believes it has.
 *
 * A browser tab has no file descriptor 0, so interactive programs (`readline`, prompts, progress bars) had nothing to talk to:
 * `process.stdin` did not exist and `process.stdout.isTTY` was undefined. This module is the piece that makes "there is a
 * terminal" a fact the shims can report, rather than a claim they make up.
 *
 * The model is the one a POSIX pty presents, reduced to what a browser can honour:
 *
 *   THE PROGRAM SIDE  `stdin` (readable, `isTTY: true`) and the stdout/stderr sinks it already had, now carrying size.
 *   THE UI SIDE       writes text in (`write`), closes the input (`end`), changes the size (`resize`), sends `^C`
 *                     (`interrupt`).
 *
 * What is deliberately NOT here: a line discipline. There is no echo, no erase processing, no `^C` byte interpretation. A
 * real terminal does that in the kernel and `readline` does it in userspace; this layer only moves bytes and reports facts.
 * Pretending otherwise would make `readline` behave differently here than in Node, which is the opposite of the point.
 *
 * Sizes follow Node's `tty.WriteStream`: a resize that does not change the size emits nothing. A terminal that emitted
 * `SIGWINCH` on every keystroke-sized notification would make every full-screen TUI redraw for no reason.
 */

/** The signals this terminal can deliver. Deliberately short: these are the two a UI produces. */
export type TerminalSignal = "SIGWINCH" | "SIGINT";

export const DEFAULT_COLUMNS = 80;
export const DEFAULT_ROWS = 24;

export type InputListener = (chunk: string) => void;
export type EndListener = () => void;
export type SignalListener = () => void;

/**
 * The program's view of stdin.
 *
 * Shaped for `readline`, which is the reason it exists: `readline` requires `on("data")`, `setRawMode`, `resume`, `pause`,
 * and refuses to work without `isTTY` when a prompt needs raw mode. Every method returns `this` because Node's streams do
 * and chaining code is common.
 */
export interface TerminalInput {
  readonly isTTY: true;
  readonly readable: boolean;
  /** Whether raw mode was requested. Tracked so the UI can stop echoing while it is set, and so programs can read it back. */
  readonly isRaw: boolean;
  on(event: "data", listener: InputListener): this;
  on(event: "end", listener: EndListener): this;
  once(event: "data", listener: InputListener): this;
  once(event: "end", listener: EndListener): this;
  off(event: "data", listener: InputListener): this;
  off(event: "end", listener: EndListener): this;
  setRawMode(mode: boolean): this;
  setEncoding(encoding: string): this;
  resume(): this;
  pause(): this;
  destroy(): this;
  readonly listeners: (event: "data" | "end") => number;
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  readonly stdin: TerminalInput;
  /** UI → program. Bytes, as typed. */
  write(text: string): void;
  /** Ctrl-D: the program sees end-of-input. */
  end(): void;
  /** UI → program, `^C`. */
  interrupt(): void;
  /** No-op unless the size actually changed, matching `tty`. */
  resize(columns: number, rows: number): void;
  /** Subscribe to a signal; returns the unsubscribe. Kept off the process shim so a terminal can outlive one process. */
  on(signal: TerminalSignal, listener: SignalListener): () => void;
  /** A snapshot, for `tty.WriteStream#getWindowSize`. */
  size(): TerminalSize;
}

const positiveInteger = (value: number | undefined, fallback: number, what: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`terminal ${what} must be a positive integer, got ${value}`);
  return value;
};

/**
 * Builds the terminal and its program-side input.
 *
 * `ended` matters: after `end()`, further `write()` calls are dropped rather than delivered to a program that has already
 * seen end-of-input. Node's stream destroys itself on end, and a program that keeps receiving data afterwards would loop.
 */
export const createTerminal = (options: { readonly columns?: number; readonly rows?: number } = {}): Terminal => {
  let columns = positiveInteger(options.columns, DEFAULT_COLUMNS, "columns");
  let rows = positiveInteger(options.rows, DEFAULT_ROWS, "rows");

  const dataListeners = new Set<InputListener>();
  const endListeners = new Set<EndListener>();
  const signals = new Map<TerminalSignal, Set<SignalListener>>();
  let ended = false;
  let raw = false;
  // Chunks that arrived while nothing was listening stay queued, because a terminal buffers input: keystrokes typed before a
  // prompt appears are not lost, they are simply read when the program starts listening.
  const pending: string[] = [];

  const deliver = (chunk: string): void => {
    if (dataListeners.size === 0) {
      pending.push(chunk);
      return;
    }
    for (const listener of [...dataListeners]) listener(chunk);
  };

  const emitSignal = (signal: TerminalSignal): void => {
    const listeners = signals.get(signal);
    if (listeners === undefined) return;
    // Copy first: a listener that unsubscribes during delivery must not shrink the set being iterated.
    for (const listener of [...listeners]) listener();
  };

  const input: TerminalInput = {
    isTTY: true,
    get readable() {
      return !ended;
    },
    get isRaw() {
      return raw;
    },
    on(event: "data" | "end", listener: InputListener | EndListener): TerminalInput {
      if (event === "data") dataListeners.add(listener as InputListener);
      else endListeners.add(listener as EndListener);
      // A reader that attaches late still gets what was typed earlier, flushed in one chunk in arrival order.
      if (event === "data" && pending.length > 0) {
        const flushed = pending.join("");
        pending.length = 0;
        (listener as InputListener)(flushed);
      }
      return input;
    },
    once(event: "data" | "end", listener: InputListener | EndListener): TerminalInput {
      if (event === "data") {
        const onData = (chunk: string): void => {
          input.off("data", onData);
          (listener as InputListener)(chunk);
        };
        return input.on("data", onData);
      }
      const onEnd = (): void => {
        input.off("end", onEnd);
        (listener as EndListener)();
      };
      return input.on("end", onEnd);
    },
    off(event: "data" | "end", listener: InputListener | EndListener): TerminalInput {
      if (event === "data") dataListeners.delete(listener as InputListener);
      else endListeners.delete(listener as EndListener);
      return input;
    },
    setRawMode(mode: boolean): TerminalInput {
      raw = mode === true;
      return input;
    },
    setEncoding(): TerminalInput {
      // Text is already decoded on the way in. Accepting the call keeps `readline`, which always sets an encoding, working;
      // silently decoding to something else would be a lie, so only text is supported and anything else is ignored.
      return input;
    },
    resume(): TerminalInput {
      return input;
    },
    pause(): TerminalInput {
      return input;
    },
    destroy(): TerminalInput {
      ended = true;
      dataListeners.clear();
      endListeners.clear();
      pending.length = 0;
      return input;
    },
    listeners(event: "data" | "end"): number {
      return event === "data" ? dataListeners.size : endListeners.size;
    },
  };

  return {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    stdin: input,
    write(text: string): void {
      if (ended || text.length === 0) return;
      deliver(text);
    },
    end(): void {
      if (ended) return;
      ended = true;
      for (const listener of [...endListeners]) listener();
    },
    interrupt(): void {
      emitSignal("SIGINT");
    },
    resize(nextColumns: number, nextRows: number): void {
      const validatedColumns = positiveInteger(nextColumns, columns, "columns");
      const validatedRows = positiveInteger(nextRows, rows, "rows");
      // Node's tty: the event is the CHANGE, so an identical size is silent.
      if (validatedColumns === columns && validatedRows === rows) return;
      columns = validatedColumns;
      rows = validatedRows;
      emitSignal("SIGWINCH");
    },
    on(signal: TerminalSignal, listener: SignalListener): () => void {
      const existing = signals.get(signal) ?? new Set<SignalListener>();
      existing.add(listener);
      signals.set(signal, existing);
      return () => {
        existing.delete(listener);
        if (existing.size === 0) signals.delete(signal);
      };
    },
    size(): TerminalSize {
      return { columns, rows };
    },
  };
};
