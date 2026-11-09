/**
 * The kernel's watch registry, without Workers or a filesystem.
 *
 * Every rule that decides whether a program hears about a change is tested here, because getting matching wrong produces the
 * worst kind of bug: a watcher that looks configured and silently reports nothing, or reports events about files it was never
 * asked to watch.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_EVENTS,
  WatchNotFoundError,
  WatchRegistry,
  WatchTargetMissingError,
  type WatchRegistryOptions,
} from "../../src/process/watch-registry.js";

const registryWith = (
  kinds: Record<string, "file" | "dir"> = { "/": "dir", "/app": "dir", "/app/main.js": "file" },
  options: Partial<WatchRegistryOptions> = {},
): WatchRegistry => {
  return new WatchRegistry({
    statKind: (path) => {
      const kind = kinds[path];
      if (kind === undefined) throw new Error(`ENOENT: ${path}`);
      return kind;
    },
    ...options,
  });
};

describe("watch registry registration", () => {
  it("hands out distinct ids and remembers them per owner", () => {
    const registry = registryWith();
    const first = registry.watch({ owner: "1", path: "/app" });
    const second = registry.watch({ owner: "1", path: "/app/main.js" });
    expect(first).not.toBe(second);
    expect(registry.size).toBe(2);
    expect(registry.stats()).toEqual([{ owner: "1", watches: 2, pending: 0, dropped: 0 }]);
  });

  it("refuses a path that does not exist, with ENOENT", () => {
    const registry = registryWith();
    expect(() => registry.watch({ owner: "1", path: "/ghost" })).toThrow(WatchTargetMissingError);
    try {
      registry.watch({ owner: "1", path: "/ghost" });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ENOENT");
    }
  });

  it("refuses a relative path, a trailing slash, and an empty path", () => {
    const registry = registryWith();
    expect(() => registry.watch({ owner: "1", path: "app" })).toThrow(RangeError);
    expect(() => registry.watch({ owner: "1", path: "/app/" })).toThrow(RangeError);
    expect(() => registry.watch({ owner: "1", path: "" })).toThrow(TypeError);
  });

  it("allows watching the root, which is the one path where a trailing slash is not a mistake", () => {
    const registry = registryWith();
    expect(registry.watch({ owner: "1", path: "/" })).toBeGreaterThan(0);
  });
});

describe("watch matching", () => {
  it("reports a direct child of a watched directory, and not a grandchild", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/deep/nested.js" });
    expect(registry.poll("1", id).events).toEqual([{ kind: "change", path: "/app/main.js" }]);
  });

  it("reports everything beneath a recursive directory watch", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app", recursive: true });
    registry.notify({ kind: "change", path: "/app/deep/nested.js" });
    expect(registry.poll("1", id).events).toEqual([{ kind: "change", path: "/app/deep/nested.js" }]);
  });

  it("reports only the watched path for a file watch, not its siblings or its parent", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/other.js" });
    registry.notify({ kind: "change", path: "/app" });
    expect(registry.poll("1", id).events).toEqual([{ kind: "change", path: "/app/main.js" }]);
  });

  it("matches both sides of a rename, so a move out and a move in are both reported", () => {
    const registry = registryWith({ "/": "dir", "/src": "dir", "/dst": "dir", "/src/a.js": "file" });
    const out = registry.watch({ owner: "1", path: "/src" });
    const into = registry.watch({ owner: "1", path: "/dst" });
    registry.notify({ kind: "rename", path: "/dst/a.js", previousPath: "/src/a.js" });
    expect(registry.poll("1", out).events).toEqual([{ kind: "rename", path: "/dst/a.js", previousPath: "/src/a.js" }]);
    expect(registry.poll("1", into).events).toEqual([{ kind: "rename", path: "/dst/a.js", previousPath: "/src/a.js" }]);
  });

  it("tells one owner nothing about another owner's watch", () => {
    const registry = registryWith();
    const mine = registry.watch({ owner: "1", path: "/app/main.js" });
    const theirs = registry.watch({ owner: "2", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    expect(registry.poll("1", mine).events).toHaveLength(1);
    expect(() => registry.poll("2", theirs)).not.toThrow();
    expect(registry.poll("2", theirs).events).toHaveLength(0);
  });
});

describe("watch coalescing", () => {
  it("collapses repeated content changes on one path into a single event", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app/main.js" });
    for (let i = 0; i < 10; i += 1) registry.notify({ kind: "change", path: "/app/main.js" });
    expect(registry.poll("1", id).events).toEqual([{ kind: "change", path: "/app/main.js" }]);
  });

  it("upgrades a queued change to rename, because appearing is stronger news than changing", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    registry.notify({ kind: "rename", path: "/app/main.js", previousPath: "/app/old.js" });
    expect(registry.poll("1", id).events).toEqual([
      { kind: "rename", path: "/app/main.js", previousPath: "/app/old.js" },
    ]);
  });

  it("does not downgrade a queued rename when a later write arrives", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app" });
    registry.notify({ kind: "rename", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    expect(registry.poll("1", id).events).toEqual([{ kind: "rename", path: "/app/main.js" }]);
  });

  it("keeps arrival order across different paths", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app" });
    registry.notify({ kind: "change", path: "/app/b.js" });
    registry.notify({ kind: "change", path: "/app/a.js" });
    expect(registry.poll("1", id).events.map((event) => event.path)).toEqual(["/app/b.js", "/app/a.js"]);
  });
});

describe("watch queue bounds and cleanup", () => {
  it("drops the oldest events at the cap and reports the drop rather than hiding it", () => {
    const registry = registryWith({ "/": "dir", "/dir": "dir" }, { maxPending: 3 });
    const id = registry.watch({ owner: "1", path: "/dir" });
    for (let i = 1; i <= 5; i += 1) registry.notify({ kind: "change", path: `/dir/f${i}` });
    const result = registry.poll("1", id);
    expect(result.events.map((event) => event.path)).toEqual(["/dir/f3", "/dir/f4", "/dir/f5"]);
    expect(result.dropped).toBe(2);
  });

  it("resets the drop counter when the owner polls, so it reports a window not a lifetime", () => {
    const registry = registryWith({ "/": "dir", "/dir": "dir" }, { maxPending: 1 });
    const id = registry.watch({ owner: "1", path: "/dir" });
    registry.notify({ kind: "change", path: "/dir/a" });
    registry.notify({ kind: "change", path: "/dir/b" });
    expect(registry.poll("1", id).dropped).toBe(1);
    expect(registry.poll("1", id)).toEqual({ events: [], dropped: 0 });
  });

  it("drains on poll, so the same event is not delivered twice", () => {
    const registry = registryWith();
    const id = registry.watch({ owner: "1", path: "/app/main.js" });
    registry.notify({ kind: "change", path: "/app/main.js" });
    expect(registry.poll("1", id).events).toHaveLength(1);
    expect(registry.poll("1", id).events).toHaveLength(0);
  });

  it("refuses to unwatch or poll an unknown id, rather than pretending it worked", () => {
    const registry = registryWith();
    expect(() => registry.unwatch("1", 999)).toThrow(WatchNotFoundError);
    expect(() => registry.poll("1", 999)).toThrow(WatchNotFoundError);
    const id = registry.watch({ owner: "1", path: "/app" });
    registry.unwatch("1", id);
    expect(registry.size).toBe(0);
    expect(() => registry.poll("1", id)).toThrow(WatchNotFoundError);
  });

  it("stops notifying an owner entirely once its watches are dropped, and says how many went", () => {
    const registry = registryWith();
    registry.watch({ owner: "1", path: "/app" });
    registry.watch({ owner: "1", path: "/app/main.js" });
    registry.watch({ owner: "2", path: "/app" });
    expect(registry.stopAll("1")).toBe(2);
    expect(registry.stopAll("1")).toBe(0);
    registry.notify({ kind: "change", path: "/app/main.js" });
    // Owner 2 still holds a watch on /app, so it does receive this one: pending 1 is the proof that the notify ran and
    // only owner 1 was dropped.
    expect(registry.stats()).toEqual([{ owner: "2", watches: 1, pending: 1, dropped: 0 }]);
  });

  it("defaults the pending cap to a documented value", () => {
    expect(MAX_PENDING_EVENTS).toBeGreaterThan(0);
    expect(() => new WatchRegistry({ statKind: () => "dir", maxPending: 0 })).toThrow(RangeError);
  });
});
