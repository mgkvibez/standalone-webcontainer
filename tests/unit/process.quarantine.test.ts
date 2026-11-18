/**
 * P3-0: the capture the process Worker takes before user code can run.
 *
 * These are behaviour tests, not source inspection: they call the capture, use what it returns, and check what the realm
 * looks like afterwards. What they deliberately do NOT claim is isolation - the capture protects the runtime's own
 * dependencies from a later restriction, and user code still shares this realm.
 */
import { describe, expect, it } from "vitest";
import {
  CAPTURED_REFERENCES,
  captureRealmReferences,
  RealmCaptureError,
  realmReferences,
} from "../../src/process/quarantine.js";

describe("P3-0 realm capture", () => {
  it("holds the realm's own facilities, not copies of them", () => {
    // Identity matters: a later phase removes the ambient global, and the runtime must still be holding the real one.
    expect(realmReferences.Function).toBe(Function);
    expect(realmReferences.Object).toBe(Object);
    expect(realmReferences.Atomics).toBe(Atomics);
    expect(realmReferences.SharedArrayBuffer).toBe(SharedArrayBuffer);
    expect(realmReferences.TextDecoder).toBe(TextDecoder);
    expect(Object.isFrozen(realmReferences)).toBe(true);
  });

  it("produces a Function that compiles and runs code", () => {
    // "Runtime internals can use the capture" is only true if the captured constructor actually works.
    const compile = realmReferences.Function as unknown as (body: string) => () => number;
    expect(compile("return 41 + 1")()).toBe(42);
  });

  it("binds getRandomValues to its receiver so a detached call still fills bytes", () => {
    const bytes = new Uint8Array(16);
    const filled = realmReferences.getRandomValues(bytes);
    expect(filled).toHaveLength(16);
    // The call above is what would throw "Illegal invocation" if the receiver had not been bound at capture time.
    expect(filled.some((byte) => byte !== 0)).toBe(true);
  });

  it("fails with a named error when a required reference is absent, rather than starting and breaking later", () => {
    const partial: Record<string, unknown> = {};
    for (const name of CAPTURED_REFERENCES) {
      partial[name] = (globalThis as unknown as Record<string, unknown>)[name];
    }
    delete partial["WebAssembly"];

    let caught: unknown;
    try {
      captureRealmReferences(partial as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RealmCaptureError);
    expect((caught as RealmCaptureError).reference).toBe("WebAssembly");
    expect((caught as Error).message).toContain("WebAssembly");
  });

  it("attaches nothing to the realm", () => {
    // The capture is module-scope by design: if importing it published a global, user code could read the runtime's
    // references and the whole exercise would be decorative.
    expect(Object.prototype.hasOwnProperty.call(globalThis, "realmReferences")).toBe(false);
    expect("quarantine" in globalThis).toBe(false);
    expect(Object.getOwnPropertyNames(globalThis).filter((name) => /quarantin|captur/i.test(name))).toEqual([]);
  });

  it("does not capture queueMicrotask, which has no production consumer", () => {
    // Recorded as a decision rather than an omission: capturing it would be speculation, and the facade already
    // re-exposes the realm's own for programs that legitimately use it.
    expect(CAPTURED_REFERENCES).not.toContain("queueMicrotask" as never);
    expect(CAPTURED_REFERENCES).toHaveLength(14);
  });
});
