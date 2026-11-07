/**
 * The two network registries: which server owns which port, and which requests are still alive.
 *
 * Both are liveness infrastructure. The port registry answers routing questions synchronously on the
 * request path; the request registry guarantees that no caller waits forever, which is the specific
 * failure both reference implementations exhibit.
 */

import { describe, expect, it } from "vitest";

import {
  InvalidPortError,
  PortInUseError,
  PortRegistry,
  portKey,
} from "../../src/network/port-registry.js";
import {
  RequestRegistry,
  RequestTimeoutError,
} from "../../src/network/request-registry.js";

describe("PortRegistry", () => {
  it("binds a port and reports it back", () => {
    const registry = new PortRegistry();
    expect(registry.bind("http", 3000)).toEqual({ protocol: "http", port: 3000 });
    expect(registry.has("http", 3000)).toBe(true);
  });

  it("refuses a second bind on the same port with EADDRINUSE", () => {
    const registry = new PortRegistry();
    registry.bind("http", 3000);
    expect(() => registry.bind("http", 3000)).toThrow(PortInUseError);
    try {
      registry.bind("http", 3000);
    } catch (error) {
      expect((error as PortInUseError).code).toBe("EADDRINUSE");
      expect((error as PortInUseError).key).toBe("http:3000");
    }
  });

  it("treats the same number on another protocol as a separate binding", () => {
    const registry = new PortRegistry();
    registry.bind("http", 3000);
    // A browser treats these as different origins, so a shared key would route to the wrong handler.
    expect(() => registry.bind("https", 3000)).not.toThrow();
    expect(registry.list()).toEqual([
      { protocol: "http", port: 3000 },
      { protocol: "https", port: 3000 },
    ]);
  });

  it("rejects port 0 instead of inventing an ephemeral port", () => {
    const registry = new PortRegistry();
    expect(() => registry.bind("http", 0)).toThrow(InvalidPortError);
    expect(() => registry.bind("http", 0)).toThrow(/ephemeral port allocation/);
  });

  it("rejects ports that could never be bound", () => {
    const registry = new PortRegistry();
    for (const bad of [-1, 65536, 3000.5, Number.NaN]) {
      expect(() => registry.bind("http", bad), String(bad)).toThrow(InvalidPortError);
    }
  });

  it("releases a port, and reports whether it was bound", () => {
    const registry = new PortRegistry();
    registry.bind("http", 3000);
    expect(registry.release("http", 3000)).toBe(true);
    expect(registry.release("http", 3000)).toBe(false);
    expect(registry.has("http", 3000)).toBe(false);
  });

  it("lets a released port be bound again", () => {
    const registry = new PortRegistry();
    registry.bind("http", 3000);
    registry.release("http", 3000);
    expect(() => registry.bind("http", 3000)).not.toThrow();
  });

  it("lists bindings in a stable order regardless of insertion order", () => {
    const forward = new PortRegistry();
    forward.bind("http", 8080);
    forward.bind("http", 3000);
    forward.bind("https", 3000);

    const backward = new PortRegistry();
    backward.bind("https", 3000);
    backward.bind("http", 3000);
    backward.bind("http", 8080);

    expect(forward.list()).toEqual(backward.list());
    expect(forward.list()).toEqual([
      { protocol: "http", port: 3000 },
      { protocol: "http", port: 8080 },
      { protocol: "https", port: 3000 },
    ]);
  });

  it("clears everything on teardown and reports what it dropped", () => {
    const registry = new PortRegistry();
    registry.bind("http", 3000);
    const dropped = registry.clear();
    expect(dropped).toEqual([{ protocol: "http", port: 3000 }]);
    expect(registry.list()).toEqual([]);
  });

  it("builds the same key the proxy will use", () => {
    expect(portKey("http", 3000)).toBe("http:3000");
  });
});

describe("RequestRegistry", () => {
  it("settles a request when its reply arrives", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 100, now: 0 });
    expect(registry.settle(pending.id, "pong")).toBe(true);
    await expect(pending.settled).resolves.toBe("pong");
    expect(registry.size).toBe(0);
  });

  it("reaps a request whose deadline has passed, and names it", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 100, now: 0 });
    const reaped = registry.reap(100);
    expect(reaped.map((entry) => entry.id)).toEqual([pending.id]);
    await expect(pending.settled).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("treats a deadline exactly equal to now as expired", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 100, now: 0 });
    registry.reap(99);
    expect(registry.has(pending.id)).toBe(true);
    registry.reap(100);
    expect(registry.has(pending.id)).toBe(false);
    await expect(pending.settled).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("ignores a reply that arrives after the request was reaped", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 100, now: 0 });
    registry.reap(1_000);
    // A late reply is a normal race. Throwing here would turn a deadline into a crash.
    expect(registry.settle(pending.id, "late")).toBe(false);
    await expect(pending.settled).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("keeps live requests when reaping, and reaps them in id order", async () => {
    const registry = new RequestRegistry<string>();
    const first = registry.openWithId("10", { deadline: 50, now: 0 });
    const second = registry.openWithId("9", { deadline: 50, now: 0 });
    const live = registry.openWithId("11", { deadline: 500, now: 0 });

    const reaped = registry.reap(100);
    expect(reaped.map((entry) => entry.id)).toEqual(["10", "9"]);
    expect(registry.has(live.id)).toBe(true);
    expect(registry.settle(live.id, "ok")).toBe(true);

    await expect(first.settled).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(second.settled).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(live.settled).resolves.toBe("ok");
  });

  it("refuses two pending requests under the same id", () => {
    const registry = new RequestRegistry<string>();
    registry.openWithId("abc", { deadline: 100, now: 0 });
    expect(() => registry.openWithId("abc", { deadline: 100, now: 0 })).toThrow(/already pending/);
  });

  it("fails a request for a reason other than its deadline", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 100, now: 0 });
    expect(registry.fail(pending.id, new Error("worker crashed"))).toBe(true);
    await expect(pending.settled).rejects.toThrow("worker crashed");
  });

  it("fails everything on teardown so no caller is left waiting", async () => {
    const registry = new RequestRegistry<string>();
    const a = registry.openWithId("a", { deadline: 10_000, now: 0 });
    const b = registry.openWithId("b", { deadline: 10_000, now: 0 });
    const closed = registry.closeAll(new Error("teardown"));
    expect(closed).toEqual(["a", "b"]);
    expect(registry.size).toBe(0);
    await expect(a.settled).rejects.toThrow("teardown");
    await expect(b.settled).rejects.toThrow("teardown");
  });

  it("reports how long a request was allowed to live", async () => {
    const registry = new RequestRegistry<string>();
    const pending = registry.open({ deadline: 250, now: 0 });
    const reaped = registry.reap(250);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.elapsedMs).toBe(250);
    await expect(pending.settled).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("rejects a deadline or clock that is not a finite number", () => {
    const registry = new RequestRegistry<string>();
    expect(() => registry.open({ deadline: Number.POSITIVE_INFINITY, now: 0 })).toThrow(/finite/);
    expect(() => registry.open({ deadline: 100, now: Number.NaN })).toThrow(/finite/);
    expect(registry.size).toBe(0);
  });
});
