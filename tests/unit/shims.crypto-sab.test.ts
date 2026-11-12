/**
 * `crypto.getRandomValues` / `randomFillSync` over a SharedArrayBuffer-backed view.
 *
 * The defect this pins was found by the November audit and is invisible in every existing test, because no test in this suite had ever handed
 * the shim a shared view. Node fills one without complaint; the Web Crypto algorithm browsers implement REFUSES one. The shim calls the
 * browser's function, so a program in the process lane (where SharedArrayBuffers live) would have failed where Node succeeds.
 *
 * Assertions are deliberately about observable contract, not exact bytes: the bytes are random, so what is checked is that the call does not
 * throw, that the range requested is the range filled, that bytes OUTSIDE it are untouched, and that something other than zeros was written.
 */

import { describe, expect, it, vi } from "vitest";

import * as cryptoShim from "../../src/shims/crypto.js";

const notAllZero = (bytes: Uint8Array): boolean => bytes.some((byte) => byte !== 0);

describe("randomFillSync over a SharedArrayBuffer", () => {
  it("fills the whole view", () => {
    const view = new Uint8Array(new SharedArrayBuffer(32));
    const returned = cryptoShim.randomFillSync(view);
    expect(returned).toBe(view);
    expect(notAllZero(view)).toBe(true);
  });

  it("fills only the window it was given, leaving the rest untouched", () => {
    const view = new Uint8Array(new SharedArrayBuffer(16));
    cryptoShim.randomFillSync(view, 4, 8);
    expect(view.subarray(4, 12).some((byte) => byte !== 0)).toBe(true);
    expect([...view.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...view.subarray(12)]).toEqual([0, 0, 0, 0]);
  });

  it("fills a shared view that starts at a non-zero byteOffset", () => {
    // A DataView over the same shared buffer catches an offset that was applied twice, which a Uint8Array-only test would miss.
    const shared = new SharedArrayBuffer(24);
    const whole = new Uint8Array(shared);
    const window = new DataView(shared, 8, 8);
    cryptoShim.randomFillSync(window);
    expect(notAllZero(whole.subarray(8, 16))).toBe(true);
    expect([...whole.subarray(0, 8)]).toEqual(new Array(8).fill(0));
    expect([...whole.subarray(16)]).toEqual(new Array(8).fill(0));
  });

  it("still fills an ordinary ArrayBuffer view", () => {
    const view = new Uint8Array(16);
    cryptoShim.randomFillSync(view);
    expect(notAllZero(view)).toBe(true);
  });
});

describe("getRandomValues over a SharedArrayBuffer", () => {
  it("does not throw, and writes into the shared memory", () => {
    const view = new Uint8Array(new SharedArrayBuffer(16));
    const returned = cryptoShim.getRandomValues(view);
    expect(returned).toBe(view);
    expect(notAllZero(view)).toBe(true);
  });

  it("honours a non-zero byteOffset on a shared buffer", () => {
    const shared = new SharedArrayBuffer(16);
    const whole = new Uint8Array(shared);
    const window = new DataView(shared, 4, 4);
    cryptoShim.getRandomValues(window);
    expect(notAllZero(whole.subarray(4, 8))).toBe(true);
    expect([...whole.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

/**
 * The same question, asked against the rule the BROWSER applies.
 *
 * Node fills a shared view happily, so the tests above would have passed before the fix too and prove nothing about the defect. Browsers follow
 * the Web Crypto algorithm, which refuses shared memory, so this block installs a spec-compliant `getRandomValues` (fill, but throw on a shared
 * buffer) and imports the shim FRESH so it captures that global. Without the copy-through in `fill`, every assertion here fails.
 */
describe("against a spec-compliant Web Crypto, where shared memory is refused", () => {
  const deterministic = (view: Uint8Array): Uint8Array => {
    for (let index = 0; index < view.length; index += 1) view[index] = (index * 31 + 7) & 0xff;
    return view;
  };

  it("fills a shared view instead of raising, and fills the CORRECT bytes", async () => {
    const fresh = await freshShimWhereSharedThrows();
    const view = new Uint8Array(new SharedArrayBuffer(8));
    expect(() => fresh.randomFillSync(view)).not.toThrow();
    // Exact bytes, so a copy-back into the wrong window fails rather than merely "something happened".
    expect([...view]).toEqual([7, 38, 69, 100, 131, 162, 193, 224]);
  });

  it("serves getRandomValues from a plain buffer too", async () => {
    const fresh = await freshShimWhereSharedThrows();
    const view = new Uint8Array(new SharedArrayBuffer(4));
    expect(() => fresh.getRandomValues(view)).not.toThrow();
    expect([...view]).toEqual([7, 38, 69, 100]);
  });

  it("leaves the bytes outside the requested window alone", async () => {
    const fresh = await freshShimWhereSharedThrows();
    const view = new Uint8Array(new SharedArrayBuffer(8));
    fresh.randomFillSync(view, 2, 4);
    expect([...view]).toEqual([0, 0, 7, 38, 69, 100, 0, 0]);
  });

  async function freshShimWhereSharedThrows(): Promise<typeof import("../../src/shims/crypto.js")> {
    vi.stubGlobal("crypto", {
      getRandomValues(view: Uint8Array) {
        if (typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer) {
          throw new TypeError("The provided ArrayBufferView is backed by a SharedArrayBuffer, which is not supported");
        }
        return deterministic(view);
      },
    });
    vi.resetModules();
    return import("../../src/shims/crypto.js");
  }
});
