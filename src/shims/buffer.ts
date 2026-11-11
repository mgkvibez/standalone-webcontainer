/**
 * `buffer`, the MODULE — which is not the same object as the global.
 *
 * `Buffer` reaches every program as a global, so `Buffer.from(...)` worked and `require("buffer")` felt unnecessary. It is not: modern packages
 * import the module by name, and `const { isUtf8 } = require("buffer")` was a destructure of `undefined`. `isUtf8` in particular is the fast
 * validity check a parser runs before trusting a byte stream as text, and its absence failed at the call site.
 *
 * The class is passed through rather than re-exported around, so `bufferModule.Buffer === globalThis.Buffer` and `instanceof` cannot disagree
 * depending on which one a caller reached.
 */
import { Buffer } from "buffer";

/**
 * Whether a byte sequence is well-formed UTF-8.
 *
 * Decoded with `fatal: true` rather than by inspecting lead bytes: the decoder is the same implementation that will parse the text afterwards,
 * so the answer agrees with what the caller is about to do. A lone continuation byte, a truncated multi-byte sequence and an overlong encoding
 * are all rejected, as in Node.
 */
export const isUtf8 = (input: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
};

/** Node's shape for the module: the class, plus the helpers that live only on it. */
export interface BufferModule {
  readonly Buffer: typeof Buffer;
  readonly isUtf8: typeof isUtf8;
}

export const bufferModule: BufferModule = { Buffer, isUtf8 };
