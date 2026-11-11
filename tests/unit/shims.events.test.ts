/**
 * `events` shim behaviour. These assert the three Node semantics that applications actually depend on,
 * because each one silently changes behaviour if it is wrong rather than throwing.
 */

import { describe, expect, it, vi } from "vitest";

import { EventEmitter, eventsModule } from "../../src/shims/events.js";

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

/**
 * `require("events")` is the class, not a namespace holding it.
 *
 * This is the wall vite's boot hit: its bundled chunk opens a module with `import require$$0$7 from 'events'` and then writes
 * `class WebSocket extends require$$0$7`, and Node answers that because the module's value IS the constructor. Handing back
 * `{ EventEmitter }` produced `Class extends value #<Object> is not a constructor`, from a line that named no shim.
 *
 * The shape below is checked against node v20.20.2, not recalled: `require("events") === require("events").EventEmitter` is true
 * there, `defaultMaxListeners` reads 10, and setting it to a non-number or a negative value throws the two errors pinned here.
 */
describe("the events module object", () => {
  it("is the EventEmitter class, with the class attached to itself", () => {
    expect(typeof eventsModule).toBe("function");
    expect(eventsModule).toBe(EventEmitter);
    expect(eventsModule.EventEmitter).toBe(eventsModule);
    // The two call styles a package can use, both reaching the same constructor.
    const viaModule = new eventsModule();
    const viaProperty = new eventsModule.EventEmitter();
    expect(viaModule).toBeInstanceOf(eventsModule);
    expect(viaProperty).toBeInstanceOf(EventEmitter);
    expect(viaModule.listenerCount("nothing")).toBe(0);
  });

  it("can be extended directly, which is what a default import of it produces", () => {
    class WebSocket extends eventsModule {}
    const socket = new WebSocket();
    const seen: unknown[] = [];
    socket.on("open", (value: unknown) => seen.push(value));
    socket.emit("open", "upgrade");
    expect(seen).toEqual(["upgrade"]);
  });

  it("carries defaultMaxListeners with Node's own validation and no warning of its own", () => {
    expect(eventsModule.defaultMaxListeners).toBe(10);
    try {
      eventsModule.defaultMaxListeners = 5;
      expect(eventsModule.defaultMaxListeners).toBe(5);
      // A string is a TypeError, and Node names the type and quotes the value.
      let wrongType: unknown;
      try {
        // @ts-expect-error the point of the test is the runtime refusal, which TypeScript would not allow to be written.
        eventsModule.defaultMaxListeners = "x";
      } catch (error) {
        wrongType = error;
      }
      expect(wrongType).toBeInstanceOf(TypeError);
      expect(wrongType).toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
        message: 'The "defaultMaxListeners" argument must be of type number. Received type string (\'x\')',
      });
      // A negative value and NaN are both out of range, as a RangeError.
      for (const value of [-1, Number.NaN]) {
        let outOfRange: unknown;
        try {
          eventsModule.defaultMaxListeners = value;
        } catch (error) {
          outOfRange = error;
        }
        expect(outOfRange).toBeInstanceOf(RangeError);
        expect(outOfRange).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      }
      // The refusal left the previous value intact rather than storing the bad one.
      expect(eventsModule.defaultMaxListeners).toBe(5);
    } finally {
      eventsModule.defaultMaxListeners = 10;
    }
  });

  it("does not claim the members this runtime cannot honour", () => {
    // Absent rather than stubbed: `errorMonitor` and `captureRejections` promise observation and rejection capture that this emitter does
    // not do, so their presence would be a quiet lie rather than a smaller feature. `once`, `on`, `listenerCount` and `getEventListeners`
    // USED to be on this list and are now implemented (docs/audit/api-surface-p0.md), which is why they are asserted present below instead.
    const dynamic = eventsModule as unknown as Record<string, unknown>;
    for (const name of ["errorMonitor", "captureRejectionSymbol", "captureRejections"]) {
      expect(dynamic[name], `${name} must be absent rather than stubbed`).toBeUndefined();
    }
  });

  it("exposes the module members it now implements", () => {
    // The other half of the guard above: a name that moved off the absent list must actually be there, or the pair says nothing.
    for (const name of ["once", "on", "listenerCount", "getEventListeners"]) {
      expect(typeof (eventsModule as unknown as Record<string, unknown>)[name], `${name} must be callable`).toBe("function");
    }
  });
});
