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
 * `base64url`, which Node has and the `buffer` package does not.
 *
 * Measured need: `vite` hashes its resolved config with `base64url` and the dev server died at `Unknown encoding: base64url` inside the
 * package's `slowToString` before it read a single config file. Node has accepted `base64url` since v14.18, so refusing it puts this runtime
 * behind the platform it claims to run, and the refusal arrives as a crash inside an ordinary package rather than as a statement about here.
 *
 * Patched onto the class rather than subclassed around it: `Buffer.from(...)`, `instanceof Buffer` and `Buffer.isBuffer` must keep agreeing with
 * the class packages already hold, and a subclass would make `isBuffer(result)` false for every buffer the polyfill built internally.
 *
 * The form is the standard alphabet with `-`/`_` for `+`/`/` and the padding stripped. Both directions are needed: a package stores or signs the
 * ENCODED form, and hands the same string back to `Buffer.from`.
 */
/**
 * The encodings `Buffer.isEncoding` narrows to.
 *
 * Declared locally because the runtime lane compiles without `@types/node`, so Node's own `BufferEncoding` does not exist here; the members are
 * Node's set plus `base64url`, which this shim adds below. A shared type would be nicer, but a name that only resolves in one of three lanes is
 * how a typecheck passes in the lane that is not shipping.
 */
type BufferEncodingName =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "utf-16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "hex";

const BASE64URL = "base64url";

const urlSafe = (base64: string): string => base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

const padded = (value: string): string => {
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const remainder = standard.length % 4;
  return remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
};

const isBase64Url = (encoding: unknown): boolean => typeof encoding === "string" && encoding.toLowerCase() === BASE64URL;

/** Set on the class once patched, so a second import of this module cannot stack a second wrapper on the first. */
const PATCHED = Symbol.for("standalone-webcontainer.buffer.base64url");

type PatchedClass = typeof Buffer & { readonly [PATCHED]?: true };

/** Unbound originals, typed loosely because each is re-exposed under its own declared signature. */
type AnyFn = (...args: unknown[]) => unknown;

const patchBase64Url = (target: typeof Buffer): void => {
  const patched = target as PatchedClass;
  if (patched[PATCHED] === true) return;
  Object.defineProperty(patched, PATCHED, { value: true, enumerable: false });

  const originalToString = patched.prototype.toString as unknown as (this: Buffer, encoding?: string, start?: number, end?: number) => string;
  patched.prototype.toString = function toString(this: Buffer, encoding?: string, start?: number, end?: number): string {
    if (!isBase64Url(encoding)) return originalToString.call(this, encoding, start, end);
    return urlSafe(originalToString.call(this, "base64", start, end));
  } as typeof patched.prototype.toString;

  // `write` takes the encoding in the LAST position of every overload, so translating that position covers all of them without counting arguments.
  const originalWrite = patched.prototype.write as unknown as AnyFn;
  patched.prototype.write = function write(this: Buffer, text: string, ...rest: unknown[]): number {
    const last = rest[rest.length - 1];
    if (!isBase64Url(last)) return originalWrite.call(this, text, ...rest) as number;
    return originalWrite.call(this, padded(text), ...rest.slice(0, -1), "base64") as number;
  } as typeof patched.prototype.write;

  const originalFrom = patched.from as unknown as AnyFn;
  patched.from = function from(this: unknown, value: unknown, ...rest: unknown[]): Buffer {
    const last = rest[rest.length - 1];
    if (typeof value !== "string" || !isBase64Url(last)) return originalFrom.call(this, value, ...rest) as Buffer;
    return originalFrom.call(this, padded(value), ...rest.slice(0, -1), "base64") as Buffer;
  } as typeof patched.from;

  const originalByteLength = patched.byteLength as unknown as AnyFn;
  patched.byteLength = function byteLength(this: unknown, value: unknown, ...rest: unknown[]): number {
    const last = rest[rest.length - 1];
    if (typeof value !== "string" || !isBase64Url(last)) return originalByteLength.call(this, value, ...rest) as number;
    return originalByteLength.call(this, padded(value), ...rest.slice(0, -1), "base64") as number;
  } as typeof patched.byteLength;

  const originalIsEncoding = patched.isEncoding as (encoding: string) => encoding is BufferEncodingName;
  patched.isEncoding = (encoding: string): encoding is BufferEncodingName =>
    isBase64Url(encoding) || originalIsEncoding(encoding);
};

patchBase64Url(Buffer);

export { Buffer };

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

export interface BufferModule {
  readonly Buffer: typeof Buffer;
  readonly isUtf8: typeof isUtf8;
}

export const bufferModule: BufferModule = { Buffer, isUtf8 };
