/**
 * `readline`: the cursor primitives, and a line reader over whatever stdin this runtime has.
 *
 * Vite uses exactly three members: `cursorTo` and `clearScreenDown` to redraw its banner, and `createInterface({ input: process.stdin })` to read
 * one key press plus Enter for its dev-server shortcuts. The cursor functions are two ANSI writes, which is all they are in Node too.
 *
 * The line reader is written against this runtime's stdin stream rather than over a raw-mode keypress decoder: `'line'` fires on a newline either
 * way, and a terminal in this runtime delivers keystrokes through the same stream. `question()` is the one place a prompt is written, and it writes
 * to `output` when the caller gave one.
 */

// The project's own events shim rather than `node:events`: this package has no @types/node, and a shim that imports a Node type it cannot see
// would make the typecheck depend on a dependency the runtime deliberately does not take.
import { EventEmitter } from "./events.js";

/** A destination for ANSI writes: what Node calls a `stream.Writable` here. */
interface WriteStream {
  write(chunk: string): boolean | void;
}

/** Node's `readline.cursorTo(stream, x, y)`: move the cursor, with an optional row. */
export function cursorTo(stream: WriteStream, x: number, y?: number): boolean {
  if (typeof y === "number") {
    stream.write(`\u001b[${y + 1};${x + 1}H`);
  } else {
    stream.write(x > 0 ? `\u001b[${x + 1}G` : "\r");
  }
  return true;
}

export function moveCursor(stream: WriteStream, dx: number, dy: number): boolean {
  if (dx < 0) stream.write(`\u001b[${-dx}D`);
  else if (dx > 0) stream.write(`\u001b[${dx}C`);
  if (dy < 0) stream.write(`\u001b[${-dy}A`);
  else if (dy > 0) stream.write(`\u001b[${dy}B`);
  return true;
}

export function clearLine(stream: WriteStream, dir: number): boolean {
  stream.write(dir < 0 ? "\u001b[1K" : dir > 0 ? "\u001b[0K" : "\u001b[2K");
  return true;
}

export function clearScreenDown(stream: WriteStream): boolean {
  stream.write("\u001b[0J");
  return true;
}

/** The stream shape a caller passes as `input`: an event emitter with an optional `setRawMode`. */
export interface ReadableInput {
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  isTTY?: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface InterfaceOptions {
  readonly input: ReadableInput;
  readonly output?: WriteStream;
  readonly terminal?: boolean;
  readonly prompt?: string;
}

/**
 * The smallest interface that answers a line.
 *
 * Deliberately not a reimplementation of Node's full editing surface: no history, no completion, no vi/emacs bindings. Those exist to serve an
 * interactive editor, and a program that needs one can tell it is missing because `terminal` is reported as whatever the caller asked for rather
 * than silently claimed.
 */
export class Interface extends EventEmitter {
  readonly #input: ReadableInput;
  readonly #output: WriteStream | undefined;
  #buffer = "";
  #closed = false;
  #prompt: string;
  readonly #onData: (chunk: unknown) => void;

  constructor(options: InterfaceOptions) {
    super();
    this.#input = options.input;
    this.#output = options.output;
    this.#prompt = options.prompt ?? "";
    this.#onData = (chunk: unknown): void => {
      this.#buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(index + 1);
        this.emit("line", line);
        index = this.#buffer.indexOf("\n");
      }
    };
    this.#input.on("data", this.#onData);
    this.#input.resume?.();
  }

  setPrompt(prompt: string): void {
    this.#prompt = prompt;
  }

  getPrompt(): string {
    return this.#prompt;
  }

  prompt(): void {
    this.#output?.write(this.#prompt);
  }

  /** Ask one question and resolve with the next line, which is how vite reads a shortcut key. */
  question(query: string, callback?: (answer: string) => void): Promise<string> {
    this.#output?.write(query);
    return new Promise((resolve) => {
      // Declared with the emitter's own listener shape (`...args: unknown[]`) rather than a narrowed parameter: a narrower signature is not
      // assignable to it, and the narrowing that matters is the one at the point of use.
      const done = (...args: unknown[]): void => {
        const answer = String(args[0] ?? "");
        this.off("line", done);
        callback?.(answer);
        resolve(answer);
      };
      this.on("line", done);
    });
  }

  pause(): this {
    this.#input.pause?.();
    return this;
  }

  resume(): this {
    this.#input.resume?.();
    return this;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off("data", this.#onData);
    this.emit("close");
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;
    let ended = false;
    const push = (...args: unknown[]): void => {
      const line = String(args[0] ?? "");
      if (resolveNext !== null) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: line, done: false });
      } else {
        queue.push(line);
      }
    };
    this.on("line", push);
    this.once("close", () => {
      ended = true;
      if (resolveNext !== null) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as never, done: true });
      }
    });
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift() as string, done: false });
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<string> {
        return this;
      },
    };
  }
}

export function createInterface(options: InterfaceOptions): Interface {
  return new Interface(options);
}

export default { cursorTo, moveCursor, clearLine, clearScreenDown, createInterface, Interface };
