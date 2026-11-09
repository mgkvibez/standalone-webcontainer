/**
 * The frame codec, held to what a codec has to be: byte-exact, order-preserving, and loud when the bytes are wrong.
 *
 * The failure that matters here is not a thrown error, it is silent corruption: a payload that arrives as the wrong bytes, a
 * body assigned to the wrong slot, a reference that resolves to the neighbour's data. Every test below exists to make one of
 * those impossible to ship quietly.
 */

import { describe, expect, it } from "vitest";
import { FrameError, framedEncoding } from "../../src/process/frame.js";

const bytes = (length: number, seed = 1): Uint8Array => {
  const body = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    // Not random: deterministic and non-repeating, so a misaligned read shows up as a mismatch rather than passing by luck.
    state = (state * 1103515245 + 12345) % 2147483648;
    body[index] = state % 256;
  }
  return body;
};

const roundTrip = (value: unknown): unknown => framedEncoding.decode(framedEncoding.encode(value));

describe("round trip", () => {
  const lengths = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 63, 64, 255, 256, 1023, 1024, 4096, 65536];

  it.each(lengths)("carries %i bytes unchanged", (length) => {
    const body = bytes(length, length + 1);
    const decoded = roundTrip({ ok: true, value: { kind: "bytes", bytes: body } }) as {
      value: { kind: string; bytes: Uint8Array };
    };
    expect(decoded.value.kind).toBe("bytes");
    expect(decoded.value.bytes.byteLength).toBe(length);
    expect(Buffer.from(decoded.value.bytes).equals(Buffer.from(body))).toBe(true);
  });

  it("keeps structure around the bodies exactly as it was", () => {
    const request = { op: "write", path: "/app/ünïcode/файл.js", data: bytes(32), dataEncoding: "binary", evictable: true };
    const decoded = roundTrip(request) as typeof request;
    expect({ ...decoded, data: undefined }).toEqual({ ...request, data: undefined });
    expect(Buffer.from(decoded.data).equals(Buffer.from(request.data))).toBe(true);
  });

  it("preserves body order across several bodies in one value", () => {
    const first = bytes(16, 3);
    const second = bytes(24, 9);
    const third = bytes(3, 77);
    const decoded = roundTrip({ a: first, nested: { list: [second] }, z: third }) as {
      a: Uint8Array;
      nested: { list: Uint8Array[] };
      z: Uint8Array;
    };
    expect(Buffer.from(decoded.a).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(decoded.nested.list[0] as Uint8Array).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(decoded.z).equals(Buffer.from(third))).toBe(true);
  });

  it("round-trips a value with no bodies at all", () => {
    const value = { op: "stat", path: "/app/main.js", limit: 10, verbose: false, note: null };
    expect(roundTrip(value)).toEqual(value);
  });

  it("sends a message with no bodies as plain JSON, byte for byte", () => {
    // The whole reason for the two-form wire: a `stat` must cost exactly what it cost before framing existed. Measured at
    // +46 bytes per message when everything was framed, which made the small-call mix 27% bigger.
    const value = { op: "stat", path: "/project/src/main.js" };
    const encoded = framedEncoding.encode(value);
    expect(encoded[0]).toBe(0x7b);
    expect(Buffer.from(encoded).equals(Buffer.from(new TextEncoder().encode(JSON.stringify(value))))).toBe(true);
  });

  it("frames a message that does carry a body", () => {
    expect(framedEncoding.encode({ op: "read", value: new Uint8Array(4) })[0]).toBe(0x46);
    // An empty Uint8Array is still a body: it must frame, or a write of zero bytes would silently become a JSON write.
    expect(framedEncoding.encode({ op: "write", data: new Uint8Array(0) })[0]).toBe(0x46);
  });

  it("reads a Uint8Array view without dragging in its neighbours", () => {
    // A view is the normal case: a body sliced out of a larger buffer. Encoding the underlying buffer would send the
    // neighbours' bytes, which is both wrong and a leak between requests.
    const backing = bytes(64, 5);
    const view = backing.subarray(16, 48);
    const decoded = roundTrip({ value: view }) as { value: Uint8Array };
    expect(decoded.value.byteLength).toBe(32);
    expect(Buffer.from(decoded.value).equals(Buffer.from(view))).toBe(true);
  });
});

describe("what framing costs", () => {
  it("is smaller than base64 for a body that is not tiny", () => {
    const body = bytes(1024, 11);
    const framed = framedEncoding.encode({ value: { kind: "bytes", bytes: body } }).byteLength;
    const base64 = Buffer.from(JSON.stringify({ ok: true, value: { kind: "bytes", base64: Buffer.from(body).toString("base64") } })).byteLength;
    // Base64 inflates the body and then quotes it; framing adds a prefix and a small header instead.
    expect(framed).toBeLessThan(base64);
    expect(base64 - framed).toBeGreaterThan(300);
  });

  const base64Size = (length: number): number =>
    Buffer.byteLength(
      JSON.stringify({ ok: true, value: { kind: "bytes", base64: Buffer.from(new Uint8Array(length).fill(7)).toString("base64") } }),
    );

  it("wins clearly on the bodies that matter, and is measured rather than assumed", () => {
    const framed = framedEncoding.encode({ ok: true, value: { kind: "bytes", bytes: new Uint8Array(4096).fill(7) } }).byteLength;
    const base64 = base64Size(4096);
    // 4,180 against 5,512 measured: the 33% base64 tax, minus fixed frame overhead.
    expect(framed).toBeLessThan(base64 * 0.8);
  });

  it("LOSES on tiny bodies, and says so instead of pretending otherwise", () => {
    // Measured crossover at ~128 bytes: below it, a frame's prefix, marker object and body table cost more than base64 would
    // have. Pinned deliberately — a test that only checked large bodies would let someone conclude framing is free
    // everywhere, and the first person to notice a 4-byte read growing by 29 bytes would have to trust or redo this.
    const framed = framedEncoding.encode({ ok: true, value: { kind: "bytes", bytes: new Uint8Array(8).fill(7) } }).byteLength;
    expect(framed).toBeGreaterThan(base64Size(8));
    // The loss is bounded to tens of bytes, and the crossover is well under the size of anything a build transfers.
    expect(framed - base64Size(8)).toBeLessThan(64);
    expect(framedEncoding.encode({ ok: true, value: { kind: "bytes", bytes: new Uint8Array(256).fill(7) } }).byteLength).toBeLessThan(
      base64Size(256),
    );
  });
});

describe("refusals", () => {
  const encodeValue = (value: unknown): Uint8Array => framedEncoding.encode(value);
  /** A message that carries a body, so it really is framed. Most protocol messages are not. */
  const encodeWithBody = (): Uint8Array => framedEncoding.encode({ op: "read", value: new Uint8Array(8) });
  const expectCode = (run: () => unknown, code: string): void => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(FrameError);
      expect((error as FrameError).code).toBe(code);
      return;
    }
    throw new Error(`expected a ${code} refusal, nothing was thrown`);
  };

  it("refuses a value that already uses the reserved marker key", () => {
    expectCode(() => encodeValue({ value: { $bytes: 0 } }), "EFRAMERESERVED");
    // Nested counts too: the walk is recursive.
    expectCode(() => encodeValue({ value: { inner: [{ $bytes: 1 }] } }), "EFRAMERESERVED");
  });

  it("refuses a message that is neither a frame nor JSON", () => {
    // No magic byte, and not parseable: the loudest thing available is to name both possibilities.
    expectCode(() => framedEncoding.decode(new Uint8Array([0, 1, 2, 3])), "EFRAMEJSON");
  });

  it("treats a frame whose magic was corrupted as JSON, and refuses it there", () => {
    const frame = encodeWithBody();
    frame[0] = 0x7b;
    // Sniffing has a consequence worth pinning: a corrupted magic is no longer "not a frame", it is "malformed JSON". Still
    // loud, but the error names the right thing.
    expectCode(() => framedEncoding.decode(frame), "EFRAMEJSON");
  });

  it("refuses a magic-prefixed message too short to hold a header", () => {
    expectCode(() => framedEncoding.decode(new Uint8Array([0x46, 1, 0, 0])), "EFRAMESHORT");
  });

  it("refuses an unknown version", () => {
    const frame = encodeWithBody();
    frame[1] = 99;
    expectCode(() => framedEncoding.decode(frame), "EFRAMEVERSION");
  });

  it("refuses a header that runs past the end", () => {
    const frame = encodeWithBody();
    new DataView(frame.buffer, frame.byteOffset).setUint32(2, frame.byteLength * 2, true);
    expectCode(() => framedEncoding.decode(frame), "EFRAMEHEADER");
  });

  it("refuses a header that is not JSON", () => {
    const frame = encodeWithBody();
    // Header length cut to three bytes of "{{{", which is not valid JSON.
    new DataView(frame.buffer, frame.byteOffset).setUint32(2, 3, true);
    frame.set([0x7b, 0x7b, 0x7b], 10);
    expectCode(() => framedEncoding.decode(frame), "EFRAMEHEADER");
  });

  it("refuses a body that runs past the end", () => {
    const frame = framedEncoding.encode({ value: new Uint8Array(64) });
    // Truncate the tail: the header still claims 64 bytes of body.
    expectCode(() => framedEncoding.decode(frame.subarray(0, frame.byteLength - 8)), "EFRAMEBODY");
  });

  it("refuses a reference to a body that is not there", () => {
    // Hand-built so the header can claim a body index the frame does not carry.
    const header = JSON.stringify({ v: { value: { $bytes: 5 } }, b: [4] });
    const headerBytes = new TextEncoder().encode(header);
    const forged = new Uint8Array(10 + headerBytes.byteLength);
    forged[0] = 0x46;
    forged[1] = 1;
    new DataView(forged.buffer).setUint32(2, headerBytes.byteLength, true);
    forged.set(headerBytes, 10);
    expectCode(() => framedEncoding.decode(forged), "EFRAMEBODY");
  });
});
