/**
 * The wire frame: JSON for structure, raw bytes for binary.
 *
 * The transport used to carry binary as base64 inside JSON, which costs 33% on the wire and CPU on both ends for the
 * encoding and decoding. The measurement in `docs/bench/syscall-metadata.md` said that tax is the only place bytes are
 * genuinely the cost, so this codec removes base64 from the path entirely: any `Uint8Array` in a value is lifted out of the
 * JSON, sent as raw bytes in a tail, and restored on the far side as a `Uint8Array` again.
 *
 * Layout, when the value carries at least one body:
 *
 * ```
 *   0        magic 'F'
 *   1        version 1
 *   2..5     header length, uint32 little-endian
 *   10..     header JSON, then the binary bodies concatenated in the order the header lists them
 * ```
 *
 * A value with NO bodies is sent as plain JSON, byte for byte what the previous encoding produced.
 *
 * That branch is not an optimization, it is the whole point of the codec. Measured through the real client, a frame costs a
 * constant ~46 bytes per message, and a toolchain boot is 96 small calls of which most carry no binary at all: framing
 * everything made the boot mix 27% BIGGER while making binaries 25% smaller. The two cases are not the same problem, so the
 * wire format now says so, and the boot path pays exactly nothing for a feature it does not use.
 *
 * The two forms cannot be confused: a frame starts with 'F', and every JSON value a syscall carries starts with '{'.
 *
 * The header is `{ "v": <value>, "b": [<body length>, ...] }`, with each lifted `Uint8Array` replaced in `v` by
 * `{ "$bytes": <index> }`.
 *
 * Why a version byte and a magic: a client and a kernel are deployed together, but a stale service worker or a cached module
 * can pair a new client with an old kernel. Without them that pairing produces a JSON parse error somewhere unrelated; with
 * them it fails here, by name, on the first call.
 */

import type { Encoding } from "./syscall-channel.js";

/** A value that cannot be framed, or bytes that are not a frame. Both are programming errors, not user errors. */
export class FrameError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

const MAGIC = 0x46; // 'F'
const VERSION = 1;
/** magic + version + header length. */
const PREFIX_BYTES = 10;
/** The key that marks a lifted body inside the header JSON. */
const BODY_KEY = "$bytes";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface HeaderShape {
  readonly v: unknown;
  readonly b: readonly number[];
}

/**
 * Walks a value, replacing every `Uint8Array` with `{ "$bytes": index }` and collecting the bodies.
 *
 * A plain object that ALREADY carries the marker key is refused rather than passed through. Without that refusal a payload
 * containing `{"$bytes": 0}` would be decoded as a reference to the first body: silent corruption of user data, which is the
 * one failure this codec must never produce.
 */
const lift = (value: unknown, bodies: Uint8Array[]): unknown => {
  if (value instanceof Uint8Array) {
    const index = bodies.length;
    bodies.push(value);
    return { [BODY_KEY]: index };
  }
  if (Array.isArray(value)) return value.map((entry) => lift(entry, bodies));
  if (value !== null && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, BODY_KEY)) {
      throw new FrameError(
        `a value contains the reserved key "${BODY_KEY}"; it cannot be framed without ambiguity`,
        "EFRAMERESERVED",
      );
    }
    const lifted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) lifted[key] = lift(entry, bodies);
    return lifted;
  }
  return value;
};

/** The inverse: every `{ "$bytes": index }` becomes the body it names. */
const drop = (value: unknown, bodies: readonly Uint8Array[]): unknown => {
  if (Array.isArray(value)) return value.map((entry) => drop(entry, bodies));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === BODY_KEY) {
      const index = (value as Record<string, unknown>)[BODY_KEY];
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= bodies.length) {
        throw new FrameError(`frame references body ${String(index)} but carries ${bodies.length}`, "EFRAMEBODY");
      }
      return bodies[index];
    }
    const restored: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) restored[key] = drop(entry, bodies);
    return restored;
  }
  return value;
};

/**
 * The framed encoding. Drop-in for `Encoding`, so the channel does not know which one it was given.
 *
 * Deliberately NOT tolerant on decode: a truncated body, a body length that runs past the end, or an unknown version all
 * throw. A codec that guesses produces wrong data at a distance, and the channel has no way to notice.
 */
export const framedEncoding: Encoding = {
  encode: (value) => {
    const bodies: Uint8Array[] = [];
    const lifted = lift(value, bodies);
    // Nothing to frame: emit exactly what the previous codec emitted, so callers without binary never pay for this.
    if (bodies.length === 0) return textEncoder.encode(JSON.stringify(lifted));
    const header: HeaderShape = { v: lifted, b: bodies.map((body) => body.byteLength) };
    const headerBytes = textEncoder.encode(JSON.stringify(header));
    const bodyBytes = bodies.reduce((total, body) => total + body.byteLength, 0);
    const frame = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + bodyBytes);
    frame[0] = MAGIC;
    frame[1] = VERSION;
    new DataView(frame.buffer, frame.byteOffset).setUint32(2, headerBytes.byteLength, true);
    frame.set(headerBytes, PREFIX_BYTES);
    let offset = PREFIX_BYTES + headerBytes.byteLength;
    for (const body of bodies) {
      frame.set(body, offset);
      offset += body.byteLength;
    }
    return frame;
  },

  decode: (bytes) => {
    // No magic means no bodies were framed, which is the common case: plain JSON, exactly what the previous codec produced.
    // Detecting it here rather than demanding a frame everywhere is what keeps the small-call path at its old cost.
    if (bytes.byteLength === 0 || bytes[0] !== MAGIC) {
      try {
        return JSON.parse(textDecoder.decode(bytes));
      } catch (error) {
        throw new FrameError(`message is neither a frame nor JSON: ${(error as Error).message}`, "EFRAMEJSON");
      }
    }
    if (bytes.byteLength < PREFIX_BYTES) {
      throw new FrameError(`a frame needs at least ${PREFIX_BYTES} bytes, got ${bytes.byteLength}`, "EFRAMESHORT");
    }
    if (bytes[1] !== VERSION) {
      throw new FrameError(`frame version ${String(bytes[1])} is not supported (this build speaks ${VERSION})`, "EFRAMEVERSION");
    }
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES).getUint32(2, true);
    if (PREFIX_BYTES + headerLength > bytes.byteLength) {
      throw new FrameError(
        `frame declares a ${headerLength}-byte header but carries ${bytes.byteLength - PREFIX_BYTES}`,
        "EFRAMEHEADER",
      );
    }
    let header: HeaderShape;
    try {
      header = JSON.parse(textDecoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength))) as HeaderShape;
    } catch (error) {
      throw new FrameError(`frame header is not JSON: ${(error as Error).message}`, "EFRAMEHEADER");
    }
    if (header === null || typeof header !== "object" || !Array.isArray(header.b)) {
      throw new FrameError("frame header is missing its body table", "EFRAMEHEADER");
    }

    const bodies: Uint8Array[] = [];
    let offset = PREFIX_BYTES + headerLength;
    for (const [index, length] of header.b.entries()) {
      if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
        throw new FrameError(`frame body ${index} has a non-integer length`, "EFRAMEBODY");
      }
      if (offset + length > bytes.byteLength) {
        throw new FrameError(
          `frame body ${index} runs ${offset + length - bytes.byteLength} bytes past the end`,
          "EFRAMEBODY",
        );
      }
      // A view, not a copy: a 256 KiB read should not be copied twice to hand it to the caller.
      bodies.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    return drop(header.v, bodies);
  },
};
