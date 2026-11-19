import { describe, expect, it, vi } from "vitest";

import {
  installCloseReport,
  type CloseInvoke,
  type CloseReport,
  type CloseScope,
} from "../../src/process/close-report.js";

/** The production invoker: the same `Reflect.apply` shape the worker passes, read from the real intrinsic. */
const reflectInvoke = Reflect.apply as unknown as CloseInvoke;

interface Recorder {
  readonly scope: CloseScope & { close?: () => void };
  readonly nativeClose: ReturnType<typeof vi.fn>;
  readonly report: ReturnType<typeof vi.fn>;
  readonly thisArg: () => unknown;
}

/** A scope whose `close` behaves like the measured Worker global: own, configurable data property holding a function. */
function recorder(options: { nativeThrows?: boolean } = {}): Recorder {
  const seen: unknown[] = [];
  const nativeClose = vi.fn(function (this: unknown) {
    seen.push(this);
    if (options.nativeThrows === true) throw new Error("native close failed");
  });
  const scope = { close: nativeClose as unknown as () => void };
  return { scope, nativeClose, report: vi.fn(), thisArg: () => seen[0] };
}

function install(rec: Recorder, invoke: CloseInvoke = reflectInvoke, report?: CloseReport) {
  const reporter = report ?? (rec.report as unknown as CloseReport);
  return installCloseReport(rec.scope, reporter, invoke);
}

describe("W-42 close instrumentation", () => {
  it("reports exactly once for one close, and calls native close with the scope as receiver", () => {
    const rec = recorder();
    expect(install(rec)).toEqual({ installed: true });

    rec.scope.close?.();

    expect(rec.report).toHaveBeenCalledTimes(1);
    expect(rec.report).toHaveBeenCalledWith({ type: "failed", reason: "worker closed itself" });
    expect(rec.nativeClose).toHaveBeenCalledTimes(1);
    expect(rec.thisArg()).toBe(rec.scope);
  });

  it("reports once across repeated closes but terminates every time", () => {
    const rec = recorder();
    install(rec);

    rec.scope.close?.();
    rec.scope.close?.();
    rec.scope.close?.();

    // The count is on the REPORT, not on settlement: one announcement, three terminations.
    expect(rec.report).toHaveBeenCalledTimes(1);
    expect(rec.nativeClose).toHaveBeenCalledTimes(3);
  });

  it("swallows a reporter exception and still terminates", () => {
    const rec = recorder();
    install(rec, reflectInvoke, () => {
      throw new Error("control port is gone");
    });

    expect(() => rec.scope.close?.()).not.toThrow();

    expect(rec.nativeClose).toHaveBeenCalledTimes(1);
    expect(rec.thisArg()).toBe(rec.scope);
  });

  it("keeps one attempt, not one success: a failed report is not retried on the next close", () => {
    const rec = recorder();
    const report = vi.fn(() => {
      throw new Error("control port is gone");
    });
    install(rec, reflectInvoke, report as unknown as CloseReport);

    rec.scope.close?.();
    rec.scope.close?.();

    expect(report).toHaveBeenCalledTimes(1);
    expect(rec.nativeClose).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a genuine exception from native close", () => {
    const rec = recorder({ nativeThrows: true });
    install(rec);

    expect(() => rec.scope.close?.()).toThrow("native close failed");
  });

  it("surfaces the native error, not the reporting one, when both fail", () => {
    const rec = recorder({ nativeThrows: true });
    install(rec, reflectInvoke, () => {
      throw new Error("control port is gone");
    });

    expect(() => rec.scope.close?.()).toThrow("native close failed");
  });

  it("preserves the descriptor flags and the function metadata", () => {
    const rec = recorder();
    const before = Object.getOwnPropertyDescriptor(rec.scope, "close");
    install(rec);
    const after = Object.getOwnPropertyDescriptor(rec.scope, "close");

    expect(after?.writable).toBe(before?.writable);
    expect(after?.enumerable).toBe(before?.enumerable);
    expect(after?.configurable).toBe(before?.configurable);
    expect(rec.scope.close?.name).toBe("close");
    expect(rec.scope.close?.length).toBe(0);
    expect(rec.scope.close).not.toBe(rec.nativeClose);
  });

  it("reports installation failure when close is absent, leaving the scope untouched", () => {
    const scope: CloseScope = {};
    expect(installCloseReport(scope, vi.fn(), reflectInvoke)).toEqual({ installed: false, reason: "absent" });
    expect(Object.getOwnPropertyDescriptor(scope, "close")).toBeUndefined();
  });

  it("reports installation failure when close is not configurable, before attempting to redefine it", () => {
    const nativeClose = vi.fn();
    const scope = {};
    Object.defineProperty(scope, "close", { value: nativeClose, writable: true, configurable: false });
    const define = vi.spyOn(Object, "defineProperty");

    expect(installCloseReport(scope, vi.fn(), reflectInvoke)).toEqual({
      installed: false,
      reason: "not-configurable",
    });
    // The earlier descriptor check is what rejected this, so no redefine was ever attempted for the scope's own property.
    expect(define.mock.calls.filter(([, key]) => key === "close")).toHaveLength(0);
    expect(Object.getOwnPropertyDescriptor(scope, "close")?.value).toBe(nativeClose);
    define.mockRestore();
  });

  it("reports installation failure when defineProperty itself throws, leaving the target untouched", () => {
    // A Proxy is the only honest double here: a frozen object is rejected by the descriptor check above, so it can never
    // reach the throw. This one reports a CONFIGURABLE descriptor for a property the target does not have (legal on an
    // extensible target) and then refuses the write, which is exactly the path being tested.
    const target: Record<string, unknown> = {};
    const scope = new Proxy(target, {
      getOwnPropertyDescriptor: (obj, key) =>
        key === "close" ? { value: () => {}, writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(obj, key),
      defineProperty: () => {
        throw new TypeError("blocked");
      },
    });

    expect(installCloseReport(scope as CloseScope, vi.fn(), reflectInvoke)).toEqual({
      installed: false,
      reason: "define-failed",
    });
    expect(Object.getOwnPropertyDescriptor(target, "close")).toBeUndefined();
  });

  it("reports installation failure when the invoker is missing", () => {
    const rec = recorder();
    expect(installCloseReport(rec.scope, vi.fn(), undefined as unknown as CloseInvoke)).toEqual({
      installed: false,
      reason: "no-invoke",
    });
  });

  it("still terminates when Function.prototype.call has been replaced by user code", () => {
    const rec = recorder();
    install(rec);

    const original = Function.prototype.call;
    try {
      (Function.prototype as unknown as { call: unknown }).call = () => {
        throw new Error("patched call");
      };
      rec.scope.close?.();
    } finally {
      (Function.prototype as unknown as { call: unknown }).call = original;
    }

    expect(rec.nativeClose).toHaveBeenCalledTimes(1);
    expect(rec.thisArg()).toBe(rec.scope);
    expect(rec.report).toHaveBeenCalledTimes(1);
  });

  it("still terminates when Function.prototype.apply has been replaced", () => {
    // Plain functions, not spies: vitest's own machinery invokes implementations through `.apply`, so a spy inside this
    // window would make the test measure the test framework instead of the wrapper.
    const calls: unknown[] = [];
    let reports = 0;
    const scope: { close?: () => void } = {
      close: function (this: unknown) {
        calls.push(this);
      } as unknown as () => void,
    };
    installCloseReport(scope, () => { reports += 1; }, reflectInvoke);

    const original = Function.prototype.apply;
    try {
      (Function.prototype as unknown as { apply: unknown }).apply = () => {
        throw new Error("patched apply");
      };
      scope.close?.();
    } finally {
      (Function.prototype as unknown as { apply: unknown }).apply = original;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(scope);
    expect(reports).toBe(1);
  });

  it("still terminates when Reflect.apply is replaced AFTER installation", () => {
    const rec = recorder();
    // The invoker is the captured value, exactly as the worker passes the P3-0 capture.
    const captured = Reflect.apply;
    install(rec, captured as unknown as CloseInvoke);

    const descriptor = Object.getOwnPropertyDescriptor(Reflect, "apply");
    try {
      Object.defineProperty(Reflect, "apply", { value: () => { throw new Error("patched reflect"); }, configurable: true });
      rec.scope.close?.();
    } finally {
      Object.defineProperty(Reflect, "apply", descriptor as PropertyDescriptor);
    }

    expect(rec.nativeClose).toHaveBeenCalledTimes(1);
    expect(rec.thisArg()).toBe(rec.scope);
  });
});
