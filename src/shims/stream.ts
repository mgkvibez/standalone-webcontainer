/**
 * `stream` shim: Readable, Writable, Duplex, Transform, PassThrough and pipeline (ADR-0015).
 *
 * Written against the contract rather than around it. The behaviours that are real here, and not approximated, are the
 * three a fixture would notice:
 *
 * 1. **Lifecycle ordering.** `end`/`finish` fire exactly once and never before the last chunk. Chunks are delivered in
 *    order and never after `end`.
 * 2. **One error per stream.** An error destroys the stream and is emitted at most once. A synchronous throw inside
 *    `_read`/`_write`/`_transform` is caught and routed to that stream's `error`, so one bad stream cannot abort the run.
 * 3. **Backpressure that bites.** `write()` returns false at the high-water mark, `drain` follows when it clears, and
 *    `pipe` actually pauses a fast source instead of buffering without bound.
 *
 * Deliberately absent, and named so the audit sees the boundary: WHATWG `ReadableStream` interop, `cork`/`uncork`,
 * `stream/promises` aliases, and encodings other than utf8 (refused by name, as the fs and http shims do).
 */
import { EventEmitter, type EventListener } from "./events.js";

/** A chunk in byte mode. Object mode admits anything, so the public type stays `unknown`. */
export type StreamChunk = string | Uint8Array;

const DEFAULT_HIGH_WATER_MARK = 16 * 1024;
const DEFAULT_OBJECT_HIGH_WATER_MARK = 16;

export interface StreamOptions {
  readonly highWaterMark?: number;
  readonly objectMode?: boolean;
  readonly read?: () => void;
  readonly write?: (chunk: unknown, encoding: string, callback: (error?: Error) => void) => void;
  readonly transform?: (chunk: unknown, encoding: string, callback: (error?: Error | null, output?: unknown) => void) => void;
  readonly flush?: (callback: (error?: Error | null) => void) => void;
  readonly destroy?: (error: Error | null, callback: (error?: Error | null) => void) => void;
}

/** Node's own error shape for the mistakes application code actually makes. */
class StreamStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Error";
    this.code = code;
  }
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/** Bytes in a chunk, for the watermark. Object mode counts one per chunk, as Node does. */
function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk).length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 1;
}

/**
 * The read half. Kept separate from the write half because `Duplex` needs two independent states: an error on the write
 * side must not silently stop reading, which is the contract's stated behaviour.
 */
export class Readable extends EventEmitter {
  #buffer: unknown[] = [];
  #buffered = 0;
  #ended = false;
  #destroyed = false;
  #flowing = false;
  #pumping = false;
  #emittedEnd = false;
  #encoding: string | undefined;
  readonly #highWaterMark: number;
  readonly #objectMode: boolean;

  constructor(options: StreamOptions = {}) {
    super();
    this.#objectMode = options.objectMode ?? false;
    this.#highWaterMark = options.highWaterMark ?? (this.#objectMode ? DEFAULT_OBJECT_HIGH_WATER_MARK : DEFAULT_HIGH_WATER_MARK);
    if (options.read !== undefined) this._read = options.read;
  }

  /** Overridable demand signal. The default does nothing: this shim is push-driven, as most fixture sources are. */
  _read: (() => void) | undefined;

  get readableEnded(): boolean {
    return this.#ended && this.#buffer.length === 0;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get readableHighWaterMark(): number {
    return this.#highWaterMark;
  }

  /** Accepts a chunk. Returns false when the buffer is at the watermark: advice, not rejection (ADR-0015). */
  push(chunk: unknown): boolean {
    if (this.#destroyed) return false;
    if (chunk === null) {
      this.#ended = true;
      this.#maybeEnd();
      return false;
    }
    this.#buffer.push(this.#decode(chunk));
    this.#buffered += byteLength(chunk);
    this.#pump();
    return this.#buffered < this.#highWaterMark;
  }

  read(): unknown {
    const chunk = this.#buffer.shift();
    if (chunk === undefined) return null;
    this.#buffered -= byteLength(chunk);
    return chunk;
  }

  setEncoding(encoding: string): this {
    if (encoding.toLowerCase().replace("-", "") !== "utf8") {
      throw new TypeError(`stream encoding ${encoding} is not supported; only utf8 is available`);
    }
    this.#encoding = encoding;
    return this;
  }

  pause(): this {
    this.#flowing = false;
    return this;
  }

  resume(): this {
    if (this.#destroyed) return this;
    this.#flowing = true;
    this.#pump();
    return this;
  }

  /** Starts flowing and returns the emitter, as Node does. */
  on(event: string, listener: EventListener): this {
    super.on(event, listener);
    if (event === "data" && !this.#destroyed) {
      this.#flowing = true;
      this.#pump();
    }
    return this;
  }

  pipe<T extends Writable>(destination: T, options: { end?: boolean } = {}): T {
    const shouldEnd = options.end ?? true;
    this.on("data", ((...args: unknown[]) => {
      const accepted = destination.write(args[0]);
      // Real backpressure: a source that ignores this turns a bounded buffer into unbounded memory.
      if (!accepted) {
        this.pause();
        destination.once("drain", () => this.resume());
      }
    }) as EventListener);
    if (shouldEnd) this.once("end", () => destination.end());
    // A destination that dies must not leave the source pumping into a dead stream.
    destination.once("error", (error: unknown) => this.destroy(asError(error)));
    this.resume();
    return destination;
  }

  /** Emits `error` at most once, then `close`. Idempotent, so a double destroy is harmless. */
  destroy(error?: Error): this {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    this.#buffer = [];
    this.#buffered = 0;
    if (error !== undefined) this.emit("error", error);
    this.emit("close");
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    while (true) {
      const buffered = this.read();
      if (buffered !== null) {
        yield buffered;
        continue;
      }
      if (this.#ended || this.#destroyed) return;
      // The chunk that wakes this wait must be KEPT: resolving a bare promise dropped whatever `data` carried, which lost
      // the first chunk of every source that had not been buffered yet.
      const next = await new Promise<{ chunk?: unknown }>((resolve) => {
        const settle = (chunk?: unknown): void => resolve(chunk === undefined ? {} : { chunk });
        this.once("data", (...args: unknown[]) => settle(args[0]));
        this.once("end", () => settle());
        this.once("close", () => settle());
        this.resume();
      });
      if (next.chunk === undefined) continue;
      yield next.chunk;
    }
  }

  /** `Readable.from`, which is how fixture-style sources are usually written. Arrays, strings and sync iterables. */
  static from(source: Iterable<unknown> | string, options: StreamOptions = {}): Readable {
    const objectMode = options.objectMode ?? typeof source !== "string";
    const stream = new Readable({ ...options, objectMode });
    // Queued as a microtask rather than pushed inline so a listener attached after `from` still receives every chunk.
    queueMicrotask(() => {
      if (stream.destroyed) return;
      if (typeof source === "string") {
        // One chunk, not one per character: `Readable.from("hello")` emits "hello".
        stream.push(source);
        stream.push(null);
        return;
      }
      for (const item of source as Iterable<unknown>) {
        if (stream.destroyed) return;
        stream.push(item);
      }
      stream.push(null);
    });
    return stream;
  }

  /** Synchronously signals end-of-source, for subclasses that push directly. */
  protected endReadable(): void {
    this.#ended = true;
    this.#maybeEnd();
  }

  /** Routes an internal failure to this stream's `error`, per contract rule 2. */
  protected failRead(error: unknown): void {
    this.destroy(asError(error));
  }

  #decode(chunk: unknown): unknown {
    if (this.#encoding === undefined) return chunk;
    if (typeof chunk === "string") return chunk;
    if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
    return chunk;
  }

  /** One chunk per microtask while flowing, so ordering is observable and cannot starve the host. */
  #pump(): void {
    if (this.#pumping || !this.#flowing || this.#destroyed) return;
    this.#pumping = true;
    queueMicrotask(() => {
      this.#pumping = false;
      if (this.#destroyed || !this.#flowing) return;
      // Never emit what nobody is listening for: an emit with zero listeners silently DESTROYS the chunk, which is how
      // the async iterator lost every chunk the pump delivered while it was awaiting its own wake-up.
      if (this.listenerCount("data") === 0) {
        this.#flowing = false;
        return;
      }
      const chunk = this.read();
      if (chunk !== null) {
        this.emit("data", chunk);
        this.#pump();
        return;
      }
      // Demand signal: a source that produces on request gets told the buffer is dry, exactly as Node does.
      try {
        this._read?.();
      } catch (error) {
        this.failRead(error);
        return;
      }
      this.#maybeEnd();
    });
  }

  #maybeEnd(): void {
    if (!this.#ended || this.#emittedEnd || this.#buffer.length > 0 || this.#destroyed) return;
    this.#emittedEnd = true;
    this.emit("end");
    this.emit("close");
  }
}

export class Writable extends EventEmitter {
  #queue: Array<{ chunk: unknown; callback?: (error?: Error) => void }> = [];
  #buffered = 0;
  #draining = false;
  #needDrain = false;
  #ending = false;
  #finished = false;
  #destroyed = false;
  readonly #highWaterMark: number;
  readonly #objectMode: boolean;
  _write: (chunk: unknown, encoding: string, callback: (error?: Error) => void) => void;

  constructor(options: StreamOptions = {}) {
    super();
    this.#objectMode = options.objectMode ?? false;
    this.#highWaterMark = options.highWaterMark ?? (this.#objectMode ? DEFAULT_OBJECT_HIGH_WATER_MARK : DEFAULT_HIGH_WATER_MARK);
    this._write =
      options.write ??
      ((_chunk, _encoding, callback) => {
        callback();
      });
  }

  get writableFinished(): boolean {
    return this.#finished;
  }

  get writableLength(): number {
    return this.#buffered;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get writableHighWaterMark(): number {
    return this.#highWaterMark;
  }

  /** False means "at the watermark, stop producing until drain" (ADR-0015). It never rejects the chunk. */
  write(chunk: unknown, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean {
    if (this.#destroyed) return false;
    if (this.#ending) {
      // Loud on purpose: npm's own code relies on this being an error rather than a no-op.
      this.destroy(new StreamStateError("ERR_STREAM_WRITE_AFTER_END", "write after end"));
      return false;
    }
    // The encoding is accepted for signature compatibility; utf8 is the only one this milestone implements.
    const done: ((error?: Error) => void) | undefined =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    this.#queue.push(done === undefined ? { chunk } : { chunk, callback: done });
    this.#buffered += byteLength(chunk);
    this.#pump();
    if (this.#buffered >= this.#highWaterMark) {
      this.#needDrain = true;
      return false;
    }
    return true;
  }

  end(chunkOrCallback?: unknown, encodingOrCallback?: string | (() => void), callback?: () => void): this {
    if (this.#finished || this.#destroyed) return this;
    if (chunkOrCallback !== undefined && typeof chunkOrCallback !== "function") this.write(chunkOrCallback);
    const done: (() => void) | undefined =
      typeof chunkOrCallback === "function"
        ? (chunkOrCallback as () => void)
        : typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : callback;
    this.#ending = true;
    if (done !== undefined) this.once("finish", done);
    this.#pump();
    this.#maybeFinish();
    return this;
  }

  destroy(error?: Error): this {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    this.#queue = [];
    this.#buffered = 0;
    if (error !== undefined) this.emit("error", error);
    this.emit("close");
    return this;
  }

  /** Used by Duplex/Transform to route their own failures through the one-error rule. */
  protected get isEnding(): boolean {
    return this.#ending;
  }

  protected hasPendingWrites(): boolean {
    return this.#queue.length > 0 || this.#draining;
  }

  #pump(): void {
    if (this.#draining || this.#destroyed) return;
    const next = this.#queue.shift();
    if (next === undefined) {
      this.#maybeFinish();
      return;
    }
    this.#draining = true;
    const settle = (error?: Error): void => {
      this.#buffered = Math.max(0, this.#buffered - byteLength(next.chunk));
      this.#draining = false;
      if (next.callback !== undefined) next.callback(error);
      if (error !== undefined) {
        this.destroy(error);
        return;
      }
      if (this.#needDrain && this.#buffered < this.#highWaterMark) {
        this.#needDrain = false;
        this.emit("drain");
      }
      this.#pump();
    };
    try {
      this._write(next.chunk, "utf8", settle);
    } catch (error) {
      // Contract rule 2: a synchronous throw is routed to this stream, not thrown at the caller.
      settle(asError(error));
    }
  }

  #maybeFinish(): void {
    if (!this.#ending || this.#finished || this.#destroyed) return;
    if (this.#queue.length > 0 || this.#draining) return;
    this.#finished = true;
    this.emit("finish");
  }
}

/** Read and write halves with independent states; `destroy(err)` kills both. */
export class Duplex extends Readable {
  readonly #side: Writable;

  constructor(options: StreamOptions = {}) {
    super(options);
    this.#side = new Writable(options);
    this.#side.on("drain", () => this.emit("drain"));
    this.#side.on("finish", () => this.emit("finish"));
    // A write-side error is this stream's error, and it destroys the read side too.
    this.#side.on("error", (error: unknown) => this.destroy(asError(error)));
  }

  get writableFinished(): boolean {
    return this.#side.writableFinished;
  }

  get writableLength(): number {
    return this.#side.writableLength;
  }

  get writableHighWaterMark(): number {
    return this.#side.writableHighWaterMark;
  }

  write(chunk: unknown, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean {
    return this.#side.write(chunk, encodingOrCallback, callback);
  }

  end(chunkOrCallback?: unknown, encodingOrCallback?: string | (() => void), callback?: () => void): this {
    this.#side.end(chunkOrCallback, encodingOrCallback, callback);
    return this;
  }

  /** The write half, for subclasses that must push or fail on the read side. */
  protected get writeSide(): Writable {
    return this.#side;
  }
}

export class Transform extends Duplex {
  readonly #transformHook: (
    chunk: unknown,
    encoding: string,
    callback: (error?: Error | null, output?: unknown) => void,
  ) => void;
  readonly #flushHook: ((callback: (error?: Error | null) => void) => void) | undefined;
  #flushed = false;

  constructor(options: StreamOptions = {}) {
    super({
      ...options,
      write: (chunk, _encoding, callback) => {
        try {
          this.#transformHook(chunk, "utf8", (error, output) => {
            // `callback(null, value)` is the canonical Node form, not `callback(undefined, value)`. Treating null as an
            // error rejected the idiomatic call with "Error: null".
            if (error !== undefined && error !== null) {
              callback(asError(error));
              return;
            }
            if (output !== undefined) this.push(output);
            callback();
          });
        } catch (error) {
          // A throw inside the user's transform reaches the pipeline, not the caller's stack.
          callback(asError(error));
        }
      },
    });
    this.#transformHook =
      options.transform ??
      ((chunk, _encoding, callback) => {
        callback(undefined, chunk);
      });
    this.#flushHook = options.flush;
    this.on("finish", () => this.#flushOnce());
  }

  _transform(chunk: unknown, encoding: string, callback: (error?: Error | null, output?: unknown) => void): void {
    this.#transformHook(chunk, encoding, callback);
  }

  #flushOnce(): void {
    if (this.#flushed) return;
    this.#flushed = true;
    if (this.#flushHook === undefined) {
      this.endReadable();
      return;
    }
    try {
      this.#flushHook((error?: Error | null) => {
        if (error !== undefined && error !== null) this.failRead(asError(error));
        else this.endReadable();
      });
    } catch (error) {
      this.failRead(error);
    }
  }
}

/** Identity transform, which is how most plumbing is written. */
export class PassThrough extends Transform {
  constructor(options: StreamOptions = {}) {
    super(options);
  }
}

type PipelineStream = Readable | Writable | Duplex;

/**
 * Structural, not `instanceof`.
 *
 * `Duplex` composes a write side rather than extending `Writable`, so a `Transform` is NOT an `instanceof Writable`. The
 * `instanceof` version of these guards therefore skipped every transform in a pipeline, which deadlocked the chain and
 * looked exactly like a hang in someone else's code.
 */
function isReadable(stream: PipelineStream): stream is Readable {
  return stream instanceof Readable || typeof (stream as { pipe?: unknown }).pipe === "function";
}

function isWritable(stream: PipelineStream): stream is Writable {
  return stream instanceof Writable || typeof (stream as { write?: unknown }).write === "function";
}

/**
 * `pipeline(...streams)`, promise and callback forms.
 *
 * On the first error every stream is destroyed and that error is reported exactly once (ADR-0015). It never resolves after
 * an error, because a pipeline that reports success after failure is worse than one that reports nothing.
 */
export function pipeline(...args: Array<PipelineStream | ((error?: Error | null) => void)>): Promise<void> {
  const callback = typeof args[args.length - 1] === "function" ? (args[args.length - 1] as (error?: Error | null) => void) : undefined;
  const streams = (callback === undefined ? args : args.slice(0, -1)) as PipelineStream[];
  if (streams.length < 2) {
    const error = new StreamStateError("ERR_STREAM_PIPELINE", "pipeline requires at least two streams");
    callback?.(error);
    return Promise.reject(error);
  }

  const settled = new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      for (const stream of streams) stream.destroy(error);
      if (error === undefined) {
        callback?.(null);
        resolve();
      } else {
        callback?.(error);
        reject(error);
      }
    };

    for (const stream of streams) stream.on("error", (error: unknown) => finish(asError(error)));
    const last = streams[streams.length - 1];
    if (last !== undefined && isWritable(last)) last.on("finish", () => finish());

    for (let index = 0; index < streams.length - 1; index += 1) {
      const source = streams[index];
      const destination = streams[index + 1];
      if (source !== undefined && destination !== undefined && isReadable(source) && isWritable(destination)) {
        // Always end the destination: a stage that is never ended never finishes, and the chain waits forever. The cast is
        // the same structural fact the guards above use: a Transform writes without being a Writable subclass.
        source.pipe(destination as unknown as Writable);
      }
    }
  });

  return settled;
}
