/**
 * `fs.watch` as user code sees it: the shim's surface, its refusals, and the async-iterator form.
 *
 * The watcher underneath is the real one (registry, handler, polling client); only the scheduler is driven by hand, so a test
 * says "now a poll happens" instead of sleeping.
 */

import { describe, expect, it } from "vitest";
import { FileSystem } from "../../src/vfs/index.js";
import { createFsShim } from "../../src/shims/fs.js";
import { createFsSyscallHandler } from "../../src/process/fs-syscalls.js";
import { WatchRegistry } from "../../src/process/watch-registry.js";
import { createRemoteWatcher } from "../../src/process/remote-watch.js";
import type { WatchSourcePort } from "../../src/vfs/port.js";
import { createCountedWatchSource } from "../../src/vfs/watch-iterator.js";

const manualScheduler = (): { schedule: (tick: () => void, ms: number) => () => void; runNext: () => void } => {
  const queue: Array<() => void> = [];
  return {
    schedule: (tick: () => void) => {
      queue.push(tick);
      return () => {
        const index = queue.indexOf(tick);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    runNext: () => {
      const next = queue.shift();
      if (next !== undefined) next();
    },
  };
};

const harness = (): {
  fs: FileSystem;
  shim: ReturnType<typeof createFsShim>;
  scheduler: ReturnType<typeof manualScheduler>;
  registry: WatchRegistry;
} => {
  const fs = new FileSystem();
  const registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind });
  fs.subscribe((change) => registry.notify(change));
  const handler = createFsSyscallHandler(fs, { watches: registry, owner: "test" });
  const scheduler = manualScheduler();
  const watches: WatchSourcePort = {
    watch: (path, options) =>
      createRemoteWatcher({
        // The double takes the full two-argument shape: a one-argument fake hid a real contract bug before.
        transport: { call: (request) => handler(request) },
        path,
        scheduler,
        ...(options?.recursive === true ? { recursive: true } : {}),
      }),
  };
  return { fs, shim: createFsShim(fs, { watches }), scheduler, registry };
};

describe("fs.watch surface", () => {
  it("delivers (eventType, filename) to a listener passed second", () => {
    const { fs, shim, scheduler } = harness();
    fs.mkdirSync("/app");
    const seen: Array<[string, string]> = [];
    shim.watch("/app", (eventType, filename) => seen.push([eventType, filename]));
    fs.writeFileSync("/app/main.js", "x");
    scheduler.runNext();
    expect(seen).toEqual([["change", "main.js"]]);
  });

  it("also accepts a listener as the third argument, with options second", () => {
    const { fs, shim, scheduler } = harness();
    fs.mkdirSync("/app");
    const seen: string[] = [];
    shim.watch("/app", { recursive: true }, (_eventType, filename) => seen.push(filename));
    fs.writeFileSync("/app/deep.js", "x");
    scheduler.runNext();
    expect(seen).toEqual(["deep.js"]);
  });

  it("returns a handle whose close() stops delivery", () => {
    const { fs, shim, scheduler, registry } = harness();
    fs.mkdirSync("/app");
    const seen: string[] = [];
    const handle = shim.watch("/app", (_eventType, filename) => seen.push(filename));
    handle.close();
    expect(handle.closed).toBe(true);
    expect(registry.size).toBe(0);
    fs.writeFileSync("/app/late.js", "x");
    scheduler.runNext();
    expect(seen).toEqual([]);
  });

  it("resolves a relative path against the cwd, like every other fs call", () => {
    const fs = new FileSystem();
    fs.mkdirSync("/project/src", { recursive: true });
    const registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind });
    fs.subscribe((change) => registry.notify(change));
    const handler = createFsSyscallHandler(fs, { watches: registry, owner: "test" });
    const scheduler = manualScheduler();
    const shim = createFsShim(fs, {
      cwd: "/project",
      watches: {
        watch: (path, options) =>
          createRemoteWatcher({
            transport: { call: (request) => handler(request) },
            path,
            scheduler,
            ...(options?.recursive === true ? { recursive: true } : {}),
          }),
      },
    });
    const seen: string[] = [];
    shim.watch("src", (_eventType, filename) => seen.push(filename));
    fs.writeFileSync("/project/src/a.js", "x");
    scheduler.runNext();
    expect(seen).toEqual(["a.js"]);
  });

  it("refuses the encoding option instead of silently returning strings", () => {
    const { fs, shim } = harness();
    fs.mkdirSync("/app");
    expect(() => shim.watch("/app", { encoding: "buffer" } as never)).toThrow(/encoding option/);
  });

  it("refuses with ENOSYS when the runtime has no watch source at all", () => {
    const fs = new FileSystem();
    const shim = createFsShim(fs);
    try {
      shim.watch("/");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ENOSYS");
      expect((error as Error).message).toMatch(/not available in this runtime/);
    }
  });
});

describe("fs.promises.watch surface", () => {
  it("yields {eventType, filename} and closes the watch when the loop breaks", async () => {
    const { fs, shim, scheduler, registry } = harness();
    fs.mkdirSync("/app");
    const iterator = shim.promises.watch("/app");
    fs.writeFileSync("/app/main.js", "x");
    scheduler.runNext();

    const seen: string[] = [];
    for await (const event of iterator) {
      seen.push(`${event.eventType}:${event.filename}`);
      break;
    }
    expect(seen).toEqual(["change:main.js"]);
    expect(registry.size).toBe(0);
  });
});

describe("counting live watches for loop liveness", () => {
  const fakeSource = (): { source: WatchSourcePort; emitClose: () => void } => {
    const listeners: Array<(...args: never[]) => void> = [];
    return {
      emitClose: () => {
        for (const listener of listeners) listener();
      },
      source: {
        watch: () => ({
          on: (event: string, listener: (...args: never[]) => void) => {
            if (event === "close") listeners.push(listener);
            return undefined;
          },
          close: () => undefined,
          closed: false,
        }),
      },
    };
  };

  it("counts a watch from creation and drops it on close(), exactly once", () => {
    const counted = createCountedWatchSource(fakeSource().source);
    const handle = counted.source.watch("/app");
    expect(counted.open()).toBe(1);
    handle.close();
    handle.close(); // idempotent, or the count goes negative and the loop believes nothing is open
    expect(counted.open()).toBe(0);
  });

  it("drops the count when the watcher closes itself, not only on an explicit close()", () => {
    // A watcher whose channel dies calls its own close path. Counting only explicit closes would strand the count above
    // zero and hold a finished program alive until the real-time guard ended it.
    const fake = fakeSource();
    const counted = createCountedWatchSource(fake.source);
    counted.source.watch("/app");
    expect(counted.open()).toBe(1);
    fake.emitClose();
    expect(counted.open()).toBe(0);
  });
});
