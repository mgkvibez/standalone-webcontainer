/**
 * `events` shim behaviour. These assert the three Node semantics that applications actually depend on,
 * because each one silently changes behaviour if it is wrong rather than throwing.
 */

import { describe, expect, it, vi } from "vitest";

import { EventEmitter } from "../../src/shims/events.js";

describe("EventEmitter", () => {
  it("calls listeners in registration order", () => {
    const emitter = new EventEmitter();
    const order: string[] = [];
    emitter.on("go", () => order.push("first"));
    emitter.on("go", () => order.push("second"));
    emitter.emit("go");
    expect(order).toEqual(["first", "second"]);
  });

  it("passes arguments through and reports whether anyone listened", () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    emitter.on("data", (...args) => seen.push(...args));
    expect(emitter.emit("data", 1, "two", { three: true })).toBe(true);
    expect(seen).toEqual([1, "two", { three: true }]);
    expect(emitter.emit("nobody-listening")).toBe(false);
  });

  it("removes a once listener before calling it, so a re-emit does not fire twice", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn(() => {
      emitter.emit("again");
    });
    emitter.once("tick", listener);
    emitter.emit("tick");
    emitter.emit("tick");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not call a listener that was added during the same emit", () => {
    const emitter = new EventEmitter();
    const late = vi.fn();
    emitter.on("start", () => {
      emitter.on("start", late);
    });
    emitter.emit("start");
    expect(late).not.toHaveBeenCalled();
    emitter.emit("start");
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("throws an unhandled error event instead of swallowing it", () => {
    const emitter = new EventEmitter();
    const boom = new Error("boom");
    // Node throws, and application code relies on that to surface failures.
    expect(() => emitter.emit("error", boom)).toThrow(boom);
  });

  it("delivers an error event when a listener is present", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on("error", listener);
    expect(() => emitter.emit("error", new Error("boom"))).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("turns a non-Error error payload into an Error", () => {
    const emitter = new EventEmitter();
    expect(() => emitter.emit("error", "just a string")).toThrow(/Unhandled error event: just a string/);
  });

  it("removes one listener by identity and leaves the others", () => {
    const emitter = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("x", first);
    emitter.on("x", second);
    emitter.off("x", first);
    emitter.emit("x");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("forgets an event entirely once its last listener is removed", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on("x", listener);
    emitter.off("x", listener);
    expect(emitter.listenerCount("x")).toBe(0);
    expect(emitter.eventNames()).toEqual([]);
  });

  it("ignores removal of an unknown listener or event", () => {
    const emitter = new EventEmitter();
    expect(() => emitter.off("never-registered", () => undefined)).not.toThrow();
    expect(emitter.listenerCount("never-registered")).toBe(0);
  });

  it("clears one event or all of them", () => {
    const emitter = new EventEmitter();
    emitter.on("a", vi.fn());
    emitter.on("b", vi.fn());
    emitter.removeAllListeners("a");
    expect(emitter.eventNames()).toEqual(["b"]);
    emitter.removeAllListeners();
    expect(emitter.eventNames()).toEqual([]);
  });

  it("rejects a listener that is not a function", () => {
    const emitter = new EventEmitter();
    // @ts-expect-error deliberately wrong type: the guard must hold at runtime for untyped callers.
    expect(() => emitter.on("x", "not a function")).toThrow(TypeError);
  });

  it("lists listeners without exposing internal state", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on("x", listener);
    const listed = emitter.listeners("x");
    expect(listed).toEqual([listener]);
    expect(Object.isFrozen(listed)).toBe(false);
  });
});
