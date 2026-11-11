/**
 * `crypto`, built on the digest primitives plus WebCrypto for everything asynchronous.
 *
 * The split matters. `createHash(...).update(...).digest()` is synchronous by contract and WebCrypto's `subtle.digest` is a promise,
 * so the synchronous half is implemented locally (`digest.ts`, verified against Node's own crypto in the tests) and the asynchronous
 * half is delegated to `subtle` where it already exists.
 *
 * What is refused, and why: signing, key generation, and anything needing a key store. A shim that returned plausible-looking bytes
 * for `sign()` would be worse than one that says it cannot, because the program would believe it had a signature.
 */

import { EventEmitter } from "./events.js";
import { sha1, sha256 } from "./digest.js";

const UNSUPPORTED = (feature: string): Error => {
  const error = new Error(`ERR_NOT_SUPPORTED: crypto.${feature} is not available in this runtime`) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  return error;
};

const toBytes = (input: unknown): Uint8Array => {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input instanceof SharedArrayBuffer) return new Uint8Array(input);
  return new TextEncoder().encode(String(input));
};

type Encoding = "hex" | "base64" | "base64url" | "utf8" | "utf-8" | "latin1" | "binary" | "ascii" | undefined;

function encode(bytes: Uint8Array, encoding: Encoding | "buffer"): string | Uint8Array {
  if (encoding === "buffer") return bytes;
  switch (encoding) {
    case "hex":
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    case "base64":
    case "base64url": {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);
      return encoding === "base64" ? base64 : base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    case "latin1":
    case "binary":
    case "ascii":
      return [...bytes].map((byte) => String.fromCharCode(byte)).join("");
    default:
      return new TextDecoder().decode(bytes);
  }
}

/** A hash as packages use it: `.update()` chained, `.digest()` once, and a `copy()` that does not disturb the original. */
export class Hash {
  readonly #algorithm: "sha1" | "sha256";
  readonly chunks: Uint8Array[] = [];

  constructor(algorithm: string) {
    const normalised = algorithm.toLowerCase().replace("-", "");
    if (normalised !== "sha1" && normalised !== "sha256") {
      // MD5 disagrees with Node's digest and is refused rather than shipped wrong; see digest.ts.
      throw UNSUPPORTED(`createHash(${JSON.stringify(algorithm)})`);
    }
    this.#algorithm = normalised;
  }

  update(data: unknown, encoding?: Encoding): this {
    if (data instanceof Uint8Array || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
      this.chunks.push(toBytes(data));
    } else {
      this.chunks.push(new TextEncoder().encode(String(data)));
    }
    void encoding; // Present for signature compatibility: our inputs are already bytes by this point.
    return this;
  }

  digest(): Uint8Array;
  digest(encoding: Encoding | "buffer"): string | Uint8Array;
  digest(encoding?: Encoding | "buffer"): string | Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = this.#algorithm === "sha1" ? sha1(joined) : sha256(joined);
    // Node's `digest()` with no argument returns a Buffer of the raw bytes.
    return encoding === undefined ? digest : encode(digest, encoding);
  }

  copy(): Hash {
    const clone = new Hash(this.#algorithm);
    for (const chunk of this.chunks) clone.chunks.push(chunk);
    return clone;
  }
}

/** HMAC over the same primitives, so it works synchronously. */
export class Hmac extends EventEmitter {
  readonly #algorithm: "sha1" | "sha256";
  readonly #key: Uint8Array;
  readonly #inner: Hash;
  #algorithmName: string;

  constructor(algorithm: string, key: unknown) {
    super();
    const normalised = algorithm.toLowerCase().replace("-", "");
    if (normalised !== "sha1" && normalised !== "sha256") throw UNSUPPORTED(`createHmac(${JSON.stringify(algorithm)})`);
    this.#algorithm = normalised;
    this.#algorithmName = normalised;
    this.#key = toBytes(key);
    this.#inner = new Hash(normalised);
  }

  update(data: unknown): this {
    this.#inner.update(data);
    return this;
  }

  digest(): Uint8Array;
  digest(encoding: Encoding | "buffer"): string | Uint8Array;
  digest(encoding?: Encoding | "buffer"): string | Uint8Array {
    const blockSize = 64;
    const key = this.#key.byteLength > blockSize ? (this.#algorithm === "sha1" ? sha1(this.#key) : sha256(this.#key)) : this.#key;
    const padded = new Uint8Array(blockSize);
    padded.set(key);
    const inner = Uint8Array.from(padded);
    const outer = Uint8Array.from(padded);
    for (let index = 0; index < blockSize; index += 1) {
      inner[index] = (inner[index] ?? 0) ^ 0x36;
      outer[index] = (outer[index] ?? 0) ^ 0x5c;
    }
    const innerDigest = this.#inner.chunks.reduce((hash, chunk) => hash.update(chunk), new Hash(this.#algorithm).update(inner)).digest();
    const result = new Hash(this.#algorithm).update(outer).update(innerDigest).digest();
    return encoding === undefined ? result : encode(result, encoding);
  }

  /** Node exposes the algorithm name; some callers read it back. */
  getAlgorithm(): string {
    return this.#algorithmName;
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

export function createHmac(algorithm: string, key: unknown): Hmac {
  return new Hmac(algorithm, key);
}

const webCrypto: Crypto | undefined = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;

export function randomBytes(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0) throw new TypeError("randomBytes: size must be a non-negative integer");
  const bytes = new Uint8Array(size);
  if (webCrypto === undefined) throw UNSUPPORTED("randomBytes");
  webCrypto.getRandomValues(bytes);
  return bytes;
}

export function randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
  if (webCrypto === undefined) throw UNSUPPORTED("randomFillSync");
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size ?? buffer.byteLength - offset);
  webCrypto.getRandomValues(view);
  return buffer;
}

export function randomUUID(): string {
  if (webCrypto?.randomUUID !== undefined) return webCrypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Constant-time comparison, as Node's own. Length difference is not secret: it leaks nothing an attacker does not already know. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError("Input buffers must have the same byte length");
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export const webcrypto = webCrypto;

export const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
  if (webCrypto === undefined) throw UNSUPPORTED("getRandomValues");
  return webCrypto.getRandomValues(array as never) as T;
};

export const subtle = {
  digest: async (algorithm: string, data: unknown): Promise<Uint8Array> => {
    const normalised = algorithm.toLowerCase().replace("-", "");
    const bytes = toBytes(data);
    if (normalised === "sha1") return sha1(bytes);
    if (normalised === "sha256") return sha256(bytes);
    if (webCrypto === undefined) throw UNSUPPORTED("subtle.digest");
    return new Uint8Array(await webCrypto.subtle.digest(algorithm.toUpperCase(), bytes as unknown as BufferSource));
  },
};

export function createSign(): never {
  throw UNSUPPORTED("createSign");
}

export function createVerify(): never {
  throw UNSUPPORTED("createVerify");
}

export function generateKeyPairSync(): never {
  throw UNSUPPORTED("generateKeyPairSync");
}

/**
 * A uniform integer in [0, range), by rejection sampling.
 *
 * The modulo shortcut is not used on purpose: `random % range` biases towards the low values whenever range does not divide 2^32, and a
 * session id or a shuffled index that leans is a defect nobody notices until it matters. Drawing again when the value lands in the
 * unrepresentable tail is the standard fix and it terminates with probability 1.
 */
const randomBelow = (range: number): number => {
  if (!Number.isInteger(range) || range <= 0 || range > 0x100000000) {
    throw Object.assign(new RangeError(`The value of "max - min" is out of range. It must be > 0 && <= 281474976710656. Received ${String(range)}`), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  const limit = Math.floor(0x100000000 / range) * range;
  const draw = new Uint32Array(1);
  for (;;) {
    getRandomValues(draw);
    // Indexed once into a local, because a typed array's element type is optional under this project's strict settings while the VALUE a draw
    // returns is always there.
    const value = draw[0] as number;
    if (value < limit) return value % range;
  }
};

/**
 * `crypto.randomInt([min,] max)`, the range-safe random every modern package reaches for instead of `Math.random`.
 *
 * Synchronous, as Node's is, over the same `getRandomValues` the rest of this shim uses. `max` is EXCLUSIVE and `min` is inclusive, which is
 * the part callers get wrong, so the differential case checks the bounds rather than only that a number came back.
 */
export function randomInt(max: number): number;
export function randomInt(min: number, max: number): number;
export function randomInt(minOrMax: number, maybeMax?: number): number {
  const min = maybeMax === undefined ? 0 : minOrMax;
  const max = maybeMax === undefined ? minOrMax : maybeMax;
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw Object.assign(new TypeError(`The "min" and "max" arguments must be integers`), { code: "ERR_INVALID_ARG_TYPE" });
  }
  if (min >= max) {
    throw Object.assign(new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return min + randomBelow(max - min);
}

/**
 * The hash algorithms `createHash` actually accepts, in Node's spelling.
 *
 * Not a longer list: a caller uses `getHashes()` to decide whether the digest it needs is available, so promising md5 and then throwing from
 * `createHash("md5")` would move the failure to a worse place. MD5 is deliberately refused there because this runtime's implementation
 * disagreed with Node's (digest.ts), and an honest short list is the same statement.
 */
export function getHashes(): string[] {
  return ["sha1", "sha256"];
}

export const constants = { RSA_PKCS1_PADDING: 1, RSA_PSS_SALTLEN_DIGEST: -1, SSL_OP_ALL: 0 };

export default {
  createHash,
  createHmac,
  randomBytes,
  randomFillSync,
  randomUUID,
  timingSafeEqual,
  randomInt,
  getHashes,
  webcrypto,
  getRandomValues,
  subtle,
  Hash,
  Hmac,
  createSign,
  createVerify,
  generateKeyPairSync,
  constants,
};
