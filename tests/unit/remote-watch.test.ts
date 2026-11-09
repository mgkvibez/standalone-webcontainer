/**
 * `fs.watch` across the real bridge: client, handler and kernel registry together, with no Workers.
 *
 * The transport here is the real `createFsSyscallHandler` wrapped in the channel's envelope, so what is under test is the
 * whole path a real process takes — a request shaped like a syscall, the kernel's registry matching it against real VFS
 * writes, and the polling client turning answers into Node-shaped events. Only the Worker and the Atomics are absent.
 */

import { describe, expect, it } from "vitest";
import { FileSystem } from "../../src/vfs/index.js";
import { createFsSyscallHandler, FileSystemSyscallError } from "../../src/process/fs-syscalls.js";
import { WatchRegistry } from "../../src/process/watch-registry.js";
import {
  createRemoteWatchIterator,
  createRemoteWatcher,
  type FsWatcher,
  type WatchEventType,
  type WatchTickScheduler,
  type WatchTransport,
} from "../../src/process/remote-watch.js";

/** A scheduler the test drives by hand: no real timers, so "20 ms later" is a function call. */
const manualScheduler = (): WatchTickScheduler & { runNext: () => void; pending: () => number } => {
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
    pending: () => queue.length,
  };
};

const bridge = (fs: FileSystem, registry: WatchRegistry, owner = "1"): WatchTransport => {
  const handler = createFsSyscallHandler(fs, { watches: registry, owner });
  return {
    call(request: unknown): unknown {
      try {
        return handler(request);
      } catch (error) {
        const rejection = error as FileSystemSyscallError;
        throw Object.assign(new Error(rejection.message), { code: rejection.code, name: "SyscallRejectedError" });
      }
    },
  };
};

const setup = (): {
  fs: FileSystem;
  registry: WatchRegistry;
  transport: WatchTransport;
  scheduler: ReturnType<typeof manualScheduler>;
  watch: (path: string, recursive?: boolean) => FsWatcher;
  events: Array<[WatchEventType, string]>;
} => {
  const fs = new FileSystem();
  const registry = new WatchRegistry({
    statKind: (path) => fs.statSync(path).kind,
  });
  fs.subscribe((change) => registry.notify(change));
  const scheduler = manualScheduler();
  const transport = bridge(fs, registry);
  const events: Array<[WatchEventType, string]> = [];
  return {
    fs,
    registry,
    transport,
    scheduler,
    events,
    watch: (path: string, recursive?: boolean) => {
      const watcher = createRemoteWatcher({
        transport,
        path,
        scheduler,
        ...(recursive === true ? { recursive: true } : {}),
      });
      watcher.on("change", ((eventType: WatchEventType, filename: string) => {
        events.push([eventType, filename]);
      }) as (...args: never[]) => void);
      watcher.on("rename", ((eventType: WatchEventType, filename: string) => {
        events.push([eventType, filename]);
      }) as (...args: never[]) => void);
      return watcher;
    },
  };
};

describe("fs.watch across the bridge", () => {
  it("reports a write as a change with the base name, after a poll", () => {
    const { fs, scheduler, watch, events, registry } = setup();
    fs.mkdirSync("/app");
    watch("/app");
    expect(registry.size).toBe(1);

    fs.writeFileSync("/app/main.js", "one");
    expect(events).toEqual([]); // nothing is delivered until the process asks
    scheduler.runNext();
    expect(events).toEqual([["change", "main.js"]]);
  });

  it("registers immediately, so a write after watch() returns is never missed", () => {
    const { fs, scheduler, watch, events } = setup();
    fs.writeFileSync("/a.txt", "before");
    watch("/a.txt");
    fs.writeFileSync("/a.txt", "after");
    scheduler.runNext();
    expect(events).toEqual([["change", "a.txt"]]);
  });

  it("collapses a burst of writes into one event, because the kernel coalesces per path", () => {
    const { fs, scheduler, watch, events } = setup();
    fs.mkdirSync("/app");
    watch("/app");
    for (let i = 0; i < 25; i += 1) fs.writeFileSync("/app/main.js", `v${i}`);
    scheduler.runNext();
    expect(events).toEqual([["change", "main.js"]]);
  });

  it("keeps delivering on later polls, so a watcher is not a one-shot", () => {
    const { fs, scheduler, watch, events } = setup();
    fs.mkdirSync("/app");
    watch("/app");
    fs.writeFileSync("/app/a.js", "1");
    scheduler.runNext();
    fs.writeFileSync("/app/b.js", "2");
    scheduler.runNext();
    expect(events).toEqual([
      ["change", "a.js"],
      ["change", "b.js"],
    ]);
  });

  it("reports deletion and creation as rename, matching Node's vocabulary", () => {
    const { fs, scheduler, watch, events } = setup();
    fs.mkdirSync("/app");
    fs.writeFileSync("/app/gone.js", "x");
    watch("/app");
    fs.unlinkSync("/app/gone.js");
    scheduler.runNext();
    expect(events).toEqual([["rename", "gone.js"]]);
  });

  it("reports everything beneath a recursive watch", () => {
    const { fs, scheduler, watch, events } = setup();
    fs.mkdirSync("/app/deep", { recursive: true });
    watch("/app", true);
    fs.writeFileSync("/app/deep/nested.js", "x");
    scheduler.runNext();
    expect(events).toEqual([["change", "nested.js"]]);
  });

  it("stops delivering and releases the kernel watch on close()", () => {
    const { fs, scheduler, watch, events, registry } = setup();
    fs.mkdirSync("/app");
    const watcher = watch("/app");
    watcher.close();
    expect(watcher.closed).toBe(true);
    expect(registry.size).toBe(0);
    fs.writeFileSync("/app/late.js", "x");
    scheduler.runNext();
    expect(events).toEqual([]);
  });

  it("makes close() idempotent and stops scheduling further polls", () => {
    const { fs, scheduler, watch } = setup();
    fs.mkdirSync("/app");
    const watcher = watch("/app");
    expect(scheduler.pending()).toBe(1);
    watcher.close();
    watcher.close();
    expect(scheduler.pending()).toBe(0);
  });

  it("stops the batch when a listener closes the watcher mid-delivery", () => {
    const { fs, scheduler, transport, registry } = setup();
    fs.mkdirSync("/app");
    const seen: string[] = [];
    const watcher = createRemoteWatcher({ transport, path: "/app", scheduler });
    watcher.on("change", ((_eventType: WatchEventType, filename: string) => {
      seen.push(filename);
      watcher.close();
    }) as (...args: never[]) => void);
    fs.writeFileSync("/app/a.js", "1");
    fs.writeFileSync("/app/b.js", "2");
    scheduler.runNext();
    expect(seen).toEqual(["a.js"]);
    expect(registry.size).toBe(0);
  });

  it("reports an error and closes when the kernel cannot answer, instead of polling forever", () => {
    const { fs, scheduler, registry } = setup();
    fs.mkdirSync("/app");
    let calls = 0;
    const dying: WatchTransport = {
      call: (request) => {
        calls += 1;
        if ((request as { op?: string }).op === "watch") return { kind: "watch", watchId: 7 };
        throw new Error("kernel went away");
      },
    };
    const errors: Error[] = [];
    const watcher = createRemoteWatcher({ transport: dying, path: "/app", scheduler });
    watcher.on("error", ((error: Error) => errors.push(error)) as (...args: never[]) => void);
    scheduler.runNext();
    expect(errors.map((error) => error.message)).toEqual(["kernel went away"]);
    expect(watcher.closed).toBe(true);
    expect(scheduler.pending()).toBe(0);
    // watch, the poll that failed, and one best-effort unwatch whose failure is swallowed. The unwatch is attempted on
    // purpose: a slow kernel is not a dead one, and skipping it would leak the watch whenever the kernel recovers.
    expect(calls).toBe(3);
    void registry;
  });

  it("refuses a watch on a path that does not exist, with ENOENT surfacing to the caller", () => {
    const { transport, scheduler } = setup();
    expect(() => createRemoteWatcher({ transport, path: "/ghost", scheduler })).toThrow(/does not exist/);
  });

  it("surfaces dropped events as a count on the watcher, not as silence", () => {
    const fs = new FileSystem();
    const registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind, maxPending: 1 });
    fs.subscribe((change) => registry.notify(change));
    const scheduler = manualScheduler();
    const transport = bridge(fs, registry);
    fs.mkdirSync("/app");
    const watcher = createRemoteWatcher({ transport, path: "/app", scheduler });
    fs.writeFileSync("/app/a.js", "1");
    fs.writeFileSync("/app/b.js", "2");
    scheduler.runNext();
    expect(watcher.dropped).toBe(1);
  });
});

describe("fs.promises.watch as an async iterator", () => {
  it("yields events and releases the kernel watch when iteration is abandoned", async () => {
    const { fs, scheduler, transport, registry } = setup();
    fs.mkdirSync("/app");
    const iterator = createRemoteWatchIterator(createRemoteWatcher({ transport, path: "/app", scheduler }));
    expect(registry.size).toBe(1);

    fs.writeFileSync("/app/a.js", "1");
    scheduler.runNext();
    await expect(iterator.next()).resolves.toEqual({ value: { eventType: "change", filename: "a.js" }, done: false });

    await iterator.return();
    expect(registry.size).toBe(0);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("can be driven by for-await with a break, which is how real code uses it", async () => {
    const { fs, scheduler, transport } = setup();
    fs.mkdirSync("/app");
    const iterator = createRemoteWatchIterator(createRemoteWatcher({ transport, path: "/app", scheduler }));
    fs.writeFileSync("/app/only.js", "1");
    scheduler.runNext();

    const seen: string[] = [];
    for await (const event of iterator) {
      seen.push(`${event.eventType}:${event.filename}`);
      break;
    }
    expect(seen).toEqual(["change:only.js"]);
  });

  it("ends the iteration instead of hanging once the watcher closes", async () => {
    const { fs, scheduler, transport, registry } = setup();
    fs.mkdirSync("/app");
    const watcher = createRemoteWatcher({ transport, path: "/app", scheduler });
    const iterator = createRemoteWatchIterator(watcher);
    const pending = iterator.next();
    expect(registry.size).toBe(1);
    watcher.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });
});
