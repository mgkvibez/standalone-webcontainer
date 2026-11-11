/**
 * The P1 members docs/audit/api-surface-p0.md added, one block per module.
 *
 * Each block answers the same two questions: does the name exist, and does it answer the way Node answers. The differential proves the answer
 * against real Node (tools/differential/api-cases.ts); these keep the gate able to catch a change without a Node oracle in the loop.
 */

import { describe, expect, it } from "vitest";

import assertModule from "../../src/shims/assert.js";
import { bufferModule, isUtf8 } from "../../src/shims/buffer.js";
import cryptoModule, { getHashes, randomInt } from "../../src/shims/crypto.js";
import { EventEmitter, eventsModule } from "../../src/shims/events.js";
import { createOsShim } from "../../src/shims/os.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { createTimersPromisesShim, createTimersShim } from "../../src/shims/timers.js";
import { parseArgs } from "../../src/shims/util.js";

describe("node:timers", () => {
  it("fires a timeout on the run's own scheduler, then cancels one", async () => {
    const scheduler = new Scheduler();
    const timers = createTimersShim(scheduler);
    const heard: string[] = [];

    timers.setTimeout((...args: unknown[]) => heard.push(`fired:${String(args[0])}`), 1, "arg");
    const cancelled = timers.setTimeout(() => heard.push("must-not-print"), 1);
    timers.clearTimeout(cancelled);
    await scheduler.drain();

    expect(heard).toEqual(["fired:arg"]);
  });

  it("returns Node's handle shape, and close() cancels like clearTimeout", async () => {
    const scheduler = new Scheduler();
    const timers = createTimersShim(scheduler);
    const heard: string[] = [];

    const handle = timers.setTimeout(() => heard.push("closed"), 1);
    expect(typeof handle.ref).toBe("function");
    expect(typeof handle.unref).toBe("function");
    expect(typeof handle.hasRef).toBe("function");
    expect(handle.hasRef()).toBe(true);
    handle.unref();
    expect(handle.hasRef()).toBe(false);
    handle.close();
    await scheduler.drain();

    expect(heard).toEqual([]);
  });

  it("resolves the promise form with the value it was given", async () => {
    const scheduler = new Scheduler();
    const timers = createTimersPromisesShim(scheduler);
    const promise = timers.setTimeout(1, "value");
    await scheduler.drain();
    await expect(promise).resolves.toBe("value");
  });

  it("refuses the promise-form interval by name instead of shipping an untested iterator", () => {
    const timers = createTimersPromisesShim(new Scheduler());
    // The refusal is the feature: an async iterator whose `break` must clear a timer has never been run under this runtime's stop conditions,
    // and an untested one would fail inside the caller's loop rather than at the call.
    expect(() => timers.setInterval(1)).toThrow(/not implemented/);
  });
});

describe("events.once and friends", () => {
  it("resolves with the emitted arguments", async () => {
    const emitter = new EventEmitter();
    const waiting = eventsModule.once(emitter, "ping");
    emitter.emit("ping", "pong", 2);
    await expect(waiting).resolves.toEqual(["pong", 2]);
  });

  it("rejects when an error is emitted while waiting for something else", async () => {
    const emitter = new EventEmitter();
    const waiting = eventsModule.once(emitter, "ping");
    emitter.emit("error", new Error("boom"));
    await expect(waiting).rejects.toThrow("boom");
  });

  it("resolves with the error when it is the error it waited for, as Node does", async () => {
    const emitter = new EventEmitter();
    const waiting = eventsModule.once(emitter, "error");
    const failure = new Error("boom");
    emitter.emit("error", failure);
    await expect(waiting).resolves.toEqual([failure]);
  });

  it("counts and lists listeners through the module, agreeing with the emitter", () => {
    const emitter = new EventEmitter();
    const listener = (): void => {};
    emitter.on("x", listener);
    expect(eventsModule.listenerCount(emitter, "x")).toBe(1);
    expect(eventsModule.getEventListeners(emitter, "x")).toEqual([listener]);
  });

  it("yields emissions through the async iterator and unhooks on return", async () => {
    const emitter = new EventEmitter();
    const iterator = eventsModule.on(emitter, "tick");
    emitter.emit("tick", 1);
    emitter.emit("tick", 2);
    expect(await iterator.next()).toEqual({ value: [1], done: false });
    expect(await iterator.next()).toEqual({ value: [2], done: false });
    await iterator.return?.(undefined);
    expect(eventsModule.listenerCount(emitter, "tick")).toBe(0);
  });
});

describe("assert.rejects and assert.doesNotReject", () => {
  it("passes when the promise rejects, with and without a matcher", async () => {
    await expect(assertModule.rejects(Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    await expect(assertModule.rejects(Promise.reject(new Error("boom")), /boom/)).resolves.toBeUndefined();
    await expect(assertModule.rejects(Promise.reject(new Error("boom")), "boom")).resolves.toBeUndefined();
  });

  it("fails when the promise fulfils, which is the case it exists to catch", async () => {
    await expect(assertModule.rejects(Promise.resolve("fine"))).rejects.toThrow(/Missing expected rejection/);
  });

  it("fails when the rejection does not match the matcher", async () => {
    await expect(assertModule.rejects(Promise.reject(new Error("boom")), /different/)).rejects.toThrow(/did not match/);
  });

  it("is reachable on strict, where a test file that set `.strict` looks for it", async () => {
    await expect(assertModule.strict.rejects(Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    await expect(assertModule.strict.doesNotReject(Promise.resolve(1))).resolves.toBeUndefined();
    await expect(assertModule.doesNotReject(Promise.reject(new Error("boom")))).rejects.toThrow(/unwanted rejection/);
  });
});

describe("os.availableParallelism", () => {
  it("reports at least one, whatever the environment says", () => {
    const os = createOsShim({ platform: "browser" } as never);
    expect(os.availableParallelism()).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(os.availableParallelism())).toBe(true);
  });
});

describe("buffer.isUtf8", () => {
  it("accepts well-formed UTF-8 and rejects a lone continuation byte", () => {
    expect(isUtf8(new TextEncoder().encode("héllo"))).toBe(true);
    expect(isUtf8(new Uint8Array([0x80]))).toBe(false);
    expect(isUtf8(new Uint8Array([0xc3]))).toBe(false);
  });

  it("is exported on the module, beside the class callers already had", () => {
    expect(bufferModule.isUtf8).toBe(isUtf8);
    expect(typeof bufferModule.Buffer.from).toBe("function");
  });
});

describe("crypto.randomInt and getHashes", () => {
  it("stays inside an exclusive upper bound across many draws", () => {
    const seen = new Set<number>();
    for (let draw = 0; draw < 500; draw += 1) {
      const value = randomInt(3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(3);
      seen.add(value);
    }
    // Every value must be reachable, or the sampling is not uniform in the way the rejection loop promises.
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it("honours a min and an exclusive max", () => {
    for (let draw = 0; draw < 200; draw += 1) expect(randomInt(5, 6)).toBe(5);
    expect(() => randomInt(3, 3)).toThrow(/greater than the value of "min"/);
  });

  it("lists only the hashes createHash will actually accept", () => {
    expect(getHashes()).toEqual(["sha1", "sha256"]);
    expect(cryptoModule.createHash("sha256")).toBeDefined();
  });
});

describe("util.parseArgs", () => {
  it("reads a string option, a boolean flag and a negated flag", () => {
    const { values } = parseArgs({
      args: ["--name", "ada", "--verbose", "--no-color"],
      options: { name: { type: "string" }, verbose: { type: "boolean" }, color: { type: "boolean" } },
    });
    expect(values).toEqual({ name: "ada", verbose: true, color: false });
  });

  it("accepts --name=value and a short alias", () => {
    const { values } = parseArgs({
      args: ["--name=ada", "-n", "grace"],
      options: { name: { type: "string", short: "n" } },
    });
    expect(values.name).toBe("grace");
  });

  it("collects a repeatable option into an array", () => {
    const { values } = parseArgs({ args: ["--tag", "a", "--tag", "b"], options: { tag: { type: "string", multiple: true } } });
    expect(values.tag).toEqual(["a", "b"]);
  });

  it("refuses an unknown option and an unexpected positional by name", () => {
    expect(() => parseArgs({ args: ["--nope"] })).toThrow(/Unknown option/);
    expect(() => parseArgs({ args: ["stray"] })).toThrow(/Unexpected argument/);
  });

  it("takes positionals after -- and when they are allowed", () => {
    const { positionals } = parseArgs({ args: ["--", "--not-a-flag", "x"], allowPositionals: true });
    expect(positionals).toEqual(["--not-a-flag", "x"]);
  });

  it("refuses grouped short flags rather than misreading them as a value", () => {
    expect(() => parseArgs({ args: ["-abc"], options: { a: { type: "boolean", short: "a" } } })).toThrow(/Grouped short options/);
  });
});
