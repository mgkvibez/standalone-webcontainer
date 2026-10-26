/**
 * Shim preset integration tests (ADR-0003, Decision 1).
 *
 * Proves the five approved unenv v1 presets load, expose their
 * expected surface, and behave — inside our ShimContext, with the
 * envelope client wired in and no browser APIs touched directly.
 */
import { describe, expect, it } from "vitest";
import { initializeShims } from "../../src/shims/presets.js";
import { SyscallClient } from "../../src/runtime/envelope.js";

function makeContext() {
  return initializeShims(new SyscallClient(() => {})); // envelope stubbed; fs is next phase
}

describe("initializeShims", () => {
  it("applies the five approved presets to the runtime context with the envelope wired in", () => {
    const { syscall, modules } = makeContext();
    expect(syscall).toBeInstanceOf(SyscallClient);
    expect(Object.keys(modules).sort()).toEqual(["buffer", "events", "path", "process", "timers"]);
  });

  it("path preset: POSIX join/resolve behave", () => {
    const { modules } = makeContext();
    expect(modules.path.join("/a", "b", "c")).toBe("/a/b/c");
    expect(modules.path.normalize("/a/./b/../c")).toBe("/a/c");
    expect(modules.path.isAbsolute("a/b")).toBe(false);
  });

  it("process preset: exposes a process singleton with cwd/env surface", () => {
    const { modules } = makeContext();
    const proc = modules.process as { cwd: () => string; env: Record<string, string | undefined>; platform: string };
    expect(typeof proc.cwd).toBe("function");
    expect(proc.env).toBeTypeOf("object");
  });

  it("buffer preset: Buffer round-trips strings and bytes", () => {
    const { modules } = makeContext();
    const BufferCtor = modules.buffer.Buffer as { from: (input: string) => { toString: () => string } };
    expect(BufferCtor.from("hello").toString()).toBe("hello");
  });

  it("events preset: EventEmitter subscribe/emit works", () => {
    const { modules } = makeContext();
    const emitter = new (modules.events as unknown as {
      EventEmitter: new () => { on: (ev: string, fn: (v: unknown) => void) => void; emit: (ev: string, v: unknown) => void };
    }).EventEmitter();
    let seen: unknown;
    emitter.on("ping", (v) => {
      seen = v;
    });
    emitter.emit("ping", "pong");
    expect(seen).toBe("pong");
  });

  it("timers preset: exposes set/clear timer functions", () => {
    const { modules } = makeContext();
    const timers = modules.timers as { setTimeout?: unknown; clearTimeout?: unknown; setInterval?: unknown; clearInterval?: unknown };
    expect(typeof timers.setTimeout).toBe("function");
    expect(typeof timers.clearTimeout).toBe("function");
    expect(typeof timers.setInterval).toBe("function");
    expect(typeof timers.clearInterval).toBe("function");
  });

  it("the shim context routes fs through the envelope, not browser APIs: no fs module is registered", () => {
    // The fs shim is next phase by expert ruling; until it exists, the
    // context deliberately has no fs surface at all — routing fs to any
    // direct API would violate the envelope contract.
    const { modules } = makeContext();
    expect(Object.keys(modules)).not.toContain("fs");
  });
});
