/**
 * `base64url` on the Buffer class this runtime hands to programs.
 *
 * The patch exists because the `buffer` package does not implement the encoding and Node does. These tests run under Node, whose own `Buffer`
 * already accepts `base64url`, so they cannot prove the patch fired here: what they pin is the CONTRACT (URL-safe alphabet, no padding, and the
 * unpadded input `Buffer.from` has to accept back) so the browser build cannot drift from it silently. The patch's own proof is the acceptance
 * journey, where vite hashes its resolved config and the dev server either starts or dies inside the polyfill's `slowToString`.
 */

import { describe, expect, it } from "vitest";
import { Buffer, isUtf8 } from "../../src/shims/buffer.js";

describe("Buffer base64url", () => {
  it("encodes with the URL-safe alphabet and no padding", () => {
    // Bytes chosen so the standard alphabet would emit "+", "/" and "=" - the three characters base64url replaces or drops.
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01, 0x02]);
    const encoded = Buffer.from(bytes).toString("base64url");
    expect(encoded).toBe("-_-_AQI");
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(Buffer.from(bytes).toString("base64")).toBe("+/+/AQI=");
  });

  it("decodes unpadded input back to the same bytes, which is what a stored value looks like", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x01, 0x02]);
    expect([...Buffer.from("-_-_AQI", "base64url")]).toEqual([...bytes]);
    // Every remainder of the length modulo 4, because padding restoration is where a hand-written decoder usually breaks.
    for (const text of ["a", "ab", "abc", "abcd"]) {
      const round = Buffer.from(text).toString("base64url");
      expect([...Buffer.from(round, "base64url")]).toEqual([...Buffer.from(text)]);
    }
  });

  it("handles the empty buffer, which is a valid hash input", () => {
    expect(Buffer.alloc(0).toString("base64url")).toBe("");
    expect(Buffer.from("", "base64url").byteLength).toBe(0);
  });

  it("reports the encoding as supported and measures it", () => {
    expect(Buffer.isEncoding("base64url")).toBe(true);
    expect(Buffer.byteLength("-_-_AQI", "base64url")).toBe(5);
  });

  it("writes a base64url string into an existing buffer", () => {
    const target = Buffer.alloc(5);
    expect(target.write("-_-_AQI", "base64url")).toBe(5);
    expect([...target]).toEqual([0xfb, 0xff, 0xbf, 0x01, 0x02]);
  });

  it("keeps the other encodings unchanged", () => {
    const bytes = Uint8Array.from([0x68, 0x69]);
    expect(Buffer.from(bytes).toString("utf8")).toBe("hi");
    expect(Buffer.from(bytes).toString("hex")).toBe("6869");
    expect(Buffer.from(bytes).toString("base64")).toBe("aGk=");
    expect(isUtf8(bytes)).toBe(true);
    expect(isUtf8(Uint8Array.from([0xff]))).toBe(false);
  });
});
