import { createHash as nodeHash, createHmac as nodeHmac, randomBytes as nodeRandom } from "node:crypto";
import { gzipSync as nodeGzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "../../src/shims/crypto.js";
import type { Readable } from "../../src/shims/stream.js";
import { createGunzip, createGzip, gunzip, gunzipSync } from "../../src/shims/zlib.js";

/**
 * Differential, because a hand-written hash that is merely self-consistent passes every test written against itself.
 *
 * Node's own `crypto` is the oracle: these are the exact algorithms and encodings packages call inline, so agreement with Node is the
 * requirement, not a nicety. The cases cover every block boundary that matters: a message shorter than the 56-byte padding limit, one
 * that needs a second block, exact multiples of 64, and multi-byte text.
 */
describe("crypto digests agree with node:crypto", () => {
  const inputs = ["", "a", "abc", "hello world", "The quick brown fox jumps over the lazy dog", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "héllo wörld 🎉"];

  for (const algorithm of ["sha1", "sha256"] as const) {
    it(`matches for every ${algorithm} case in hex, base64 and utf8`, () => {
      for (const input of inputs) {
        for (const encoding of ["hex", "base64"] as const) {
          expect([input.length, encoding, createHash(algorithm).update(input).digest(encoding)]).toEqual([
            input.length,
            encoding,
            nodeHash(algorithm).update(input, "utf8").digest(encoding),
          ]);
        }
      }
    });
  }

  it("matches when the input arrives in chunks, which is how a hash is normally fed", () => {
    const chunks = ["hello ", "world", " ", "again"];
    const mine = chunks.reduce((hash, chunk) => hash.update(chunk), createHash("sha256")).digest("hex");
    const theirs = chunks.reduce((hash, chunk) => hash.update(chunk), nodeHash("sha256")).digest("hex");
    expect(mine).toBe(theirs);
  });

  it("matches HMAC-SHA256, including the case where the key is longer than the block size", () => {
    for (const key of ["key", "k".repeat(64), "k".repeat(100)]) {
      expect(createHmac("sha256", key).update("hello").digest("hex")).toBe(nodeHmac("sha256", key).update("hello").digest("hex"));
    }
  });

  it("refuses MD5 by name instead of returning a digest that disagrees with Node", () => {
    // Recorded as a known limitation: nothing on the express path needs MD5, and a quietly wrong hash is worse than a refusal.
    expect(() => createHash("md5")).toThrow(/ERR_NOT_SUPPORTED/);
    expect(() => createHmac("md5", "key")).toThrow(/ERR_NOT_SUPPORTED/);
  });

  it("produces random bytes of the requested length, and they differ", () => {
    const first = randomBytes(16);
    const second = randomBytes(16);
    expect(first.byteLength).toBe(16);
    expect([...first]).not.toEqual([...second]);
    expect(first.byteLength).toBe(nodeRandom(16).byteLength);
  });

  it("produces a v4 UUID in the shape Node does", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID()).not.toBe(randomUUID());
  });

  it("compares in constant time and rejects a length mismatch the way Node does", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(() => timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toThrow(/same byte length/);
  });
});

describe("zlib decodes real gzip and round-trips its own output", () => {
  const text = "express-static-ok ".repeat(50);
  const gzipBytes = new Uint8Array(nodeGzipSync(Buffer.from(text)));

  // Written without ending the stream: a collector that ends its own stream cannot be given input afterwards ("write after end").
  const collect = (stream: Readable): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      stream.on("data", (chunk: unknown) => chunks.push(chunk as Uint8Array));
      stream.on("end", () => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(joined);
      });
      stream.on("error", reject);
    });

  it("gunzips bytes that Node's zlib produced, through the stream form body-parser uses", async () => {
    const stream = createGunzip();
    const decoded = collect(stream);
    stream.write(gzipBytes);
    stream.end();
    expect(new TextDecoder().decode(await decoded)).toBe(text);
  });

  it("compresses and then decompresses its own output", async () => {
    const compressor = createGzip();
    const bytes = collect(compressor);
    compressor.write(new TextEncoder().encode(text));
    compressor.end();
    const compressed = await bytes;
    expect(compressed.byteLength).toBeGreaterThan(0);
    expect(compressed.byteLength).toBeLessThan(text.length);

    await new Promise<void>((resolve, reject) => {
      gunzip(compressed, (error, result) => {
        if (error !== null) {
          reject(error);
          return;
        }
        expect(new TextDecoder().decode(result)).toBe(text);
        resolve();
      });
    });
  });

  it("refuses the synchronous forms by name, because the platform has no synchronous codec", () => {
    expect(() => gunzipSync(gzipBytes)).toThrow(/ERR_NOT_SUPPORTED/);
    expect(() => gunzipSync(gzipBytes)).toThrow(/asynchronous only/);
  });

  it("emits an empty result for empty input rather than hanging or throwing", async () => {
    const stream = createGunzip();
    const decoded = collect(stream);
    stream.end();
    expect((await decoded).byteLength).toBe(0);
  });
});
