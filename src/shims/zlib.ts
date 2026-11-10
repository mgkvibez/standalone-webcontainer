/**
 * `zlib`, built on the platform's `CompressionStream` and `DecompressionStream`.
 *
 * The one structural difference from Node is that these are **asynchronous only**. Web APIs have no synchronous gzip, so `gunzipSync`
 * and friends refuse by name instead of returning something wrong; the stream and callback forms do the real work. That covers what
 * servers actually use: `body-parser` decompresses an inflated request body through `zlib.createInflate()` and `createGunzip()`, and
 * `destroy` only imports the module.
 *
 * The transform buffers its input and decompresses once, on flush. Node streams the bytes through incrementally; buffering is the
 * price of a stream that must await a promise, and it is bounded by `MAX_BUFFERED_BYTES` so a hostile body is refused rather than
 * allowed to exhaust the tab's memory.
 */

import { Transform, type StreamOptions } from "./stream.js";

type Format = "gzip" | "deflate" | "deflate-raw";

/** A decompressed body larger than this is refused: a few hundred kilobytes of gzip can expand forever. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

const notSupported = (feature: string): Error => {
  const error = new Error(
    `ERR_NOT_SUPPORTED: zlib.${feature} is not available in this runtime: the platform's compression streams are asynchronous only, so use the stream or callback form`,
  ) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  return error;
};

const toBytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new TextEncoder().encode(String(chunk));
};

async function run(bytes: Uint8Array, format: Format, mode: "compress" | "decompress"): Promise<Uint8Array> {
  const Constructor = mode === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (typeof Constructor !== "function") {
    throw notSupported(mode === "compress" ? "compression" : "decompression");
  }
  const source = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new Constructor(format));
  const output = new Uint8Array(await new Response(source).arrayBuffer());
  if (output.byteLength > MAX_BUFFERED_BYTES) {
    throw new Error(`ERR_BUFFER_TOO_LARGE: zlib output exceeded ${MAX_BUFFERED_BYTES} bytes`);
  }
  return output;
}

/**
 * A transform that accepts compressed (or plain) chunks and emits one decoded chunk when the input ends.
 *
 * `self` is assigned before any callback can run: the hooks are invoked from `finish`, which cannot happen during construction.
 */
class CodecStream extends Transform {
  readonly #chunks: Uint8Array[] = [];
  readonly format: Format;
  readonly mode: "compress" | "decompress";

  constructor(mode: "compress" | "decompress", format: Format, options: StreamOptions & { readonly chunkSize?: number } = {}) {
    let self: CodecStream;
    super({
      ...options,
      transform: (chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) => {
        const bytes = toBytes(chunk);
        self.#chunks.push(bytes);
        callback();
      },
      flush: (callback: (error?: Error | null) => void) => {
        void (async () => {
          try {
            const total = self.#chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            if (total > MAX_BUFFERED_BYTES) throw new Error(`ERR_BUFFER_TOO_LARGE: zlib input exceeded ${MAX_BUFFERED_BYTES} bytes`);
            const joined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of self.#chunks) {
              joined.set(chunk, offset);
              offset += chunk.byteLength;
            }
            self.#chunks.length = 0;
            if (total === 0) {
              self.push(new Uint8Array(0));
              callback();
              return;
            }
            const output = await run(joined, self.format, self.mode);
            self.push(output);
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
    });
    this.format = format;
    this.mode = mode;
    self = this;
  }

  /** Node's streams expose the format; some middleware branches on it. */
  get [Symbol.toStringTag](): string {
    return this.mode === "compress" ? "ZlibCompress" : "ZlibDecompress";
  }
}

export class Gzip extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("compress", "gzip", options);
  }
}

export class Gunzip extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("decompress", "gzip", options);
  }
}

export class Deflate extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("compress", "deflate", options);
  }
}

export class Inflate extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("decompress", "deflate", options);
  }
}

export class DeflateRaw extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("compress", "deflate-raw", options);
  }
}

export class InflateRaw extends CodecStream {
  constructor(options: StreamOptions = {}) {
    super("decompress", "deflate-raw", options);
  }
}

/** `createUnzip` picks the format from the bytes, the way Node's does: gzip has a magic number, zlib does not. */
export class Unzip extends Transform {
  readonly #chunks: Uint8Array[] = [];

  constructor(options: StreamOptions = {}) {
    let self: Unzip;
    super({
      ...options,
      transform: (chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) => {
        self.#chunks.push(toBytes(chunk));
        callback();
      },
      flush: (callback: (error?: Error | null) => void) => {
        void (async () => {
          try {
            const total = self.#chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const joined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of self.#chunks) {
              joined.set(chunk, offset);
              offset += chunk.byteLength;
            }
            if (total === 0) {
              self.push(new Uint8Array(0));
              callback();
              return;
            }
            const isGzip = (joined[0] ?? 0) === 0x1f && (joined[1] ?? 0) === 0x8b;
            self.push(await run(joined, isGzip ? "gzip" : "deflate", "decompress"));
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
    });
    self = this;
  }
}

/** The callback form Node exposes: `zlib.gunzip(buffer, callback)`. */
export type AsyncZlib = (input: unknown, callback: (error: Error | null, result?: Uint8Array) => void) => void;

const callbackForm = (mode: "compress" | "decompress", format: Format): AsyncZlib => {
  return (input: unknown, callback: (error: Error | null, result?: Uint8Array) => void): void => {
    if (typeof callback !== "function") throw new TypeError("zlib: a callback is required");
    void (async () => {
      try {
        const bytes = toBytes(input);
        if (bytes.byteLength === 0) {
          callback(null, new Uint8Array(0));
          return;
        }
        callback(null, await run(bytes, format, mode));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };
};

export const createGzip = (options: StreamOptions = {}): Gzip => new Gzip(options);
export const createGunzip = (options: StreamOptions = {}): Gunzip => new Gunzip(options);
export const createDeflate = (options: StreamOptions = {}): Deflate => new Deflate(options);
export const createInflate = (options: StreamOptions = {}): Inflate => new Inflate(options);
export const createDeflateRaw = (options: StreamOptions = {}): DeflateRaw => new DeflateRaw(options);
export const createInflateRaw = (options: StreamOptions = {}): InflateRaw => new InflateRaw(options);
export const createUnzip = (options: StreamOptions = {}): Unzip => new Unzip(options);

export const gzip: AsyncZlib = callbackForm("compress", "gzip");
export const gunzip: AsyncZlib = callbackForm("decompress", "gzip");
export const deflate: AsyncZlib = callbackForm("compress", "deflate");
export const inflate: AsyncZlib = callbackForm("decompress", "deflate");
export const deflateRaw: AsyncZlib = callbackForm("compress", "deflate-raw");
export const inflateRaw: AsyncZlib = callbackForm("decompress", "deflate-raw");
export const unzip: AsyncZlib = callbackForm("decompress", "gzip");

export const gzipSync = (..._args: unknown[]): never => {
  throw notSupported("gzipSync");
};
export const gunzipSync = (..._args: unknown[]): never => {
  throw notSupported("gunzipSync");
};
export const deflateSync = (..._args: unknown[]): never => {
  throw notSupported("deflateSync");
};
export const inflateSync = (..._args: unknown[]): never => {
  throw notSupported("inflateSync");
};
export const deflateRawSync = (..._args: unknown[]): never => {
  throw notSupported("deflateRawSync");
};
export const inflateRawSync = (..._args: unknown[]): never => {
  throw notSupported("inflateRawSync");
};

/** The flush and level constants packages compare against. Values are zlib's own, because callers pass them back to us. */
export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_STRATEGY: 0,
  Z_FIXED: 4,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
};

export default {
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createUnzip,
  gzip,
  gunzip,
  deflate,
  inflate,
  deflateRaw,
  inflateRaw,
  unzip,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  Gzip,
  Gunzip,
  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Unzip,
  constants,
};
