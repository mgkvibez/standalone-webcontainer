import { describe, expect, it } from "vitest";
import { CHANNEL_HEADER_BYTES, CHANNEL_STATE, allocateChannel, serveChannelAsync } from "../../src/process/syscall-channel.js";
import { framedEncoding } from "../../src/process/frame.js";
import { ProcessHost, type ProcessWorkerLike } from "../../src/process/process-host.js";
import { ProcessLimitError } from "../../src/process/process-table.js";

/**
 * One Worker per process.
 *
 * The Worker is faked here so the bookkeeping can be asserted in Node: spawn, init message, exit reporting, error
 * reporting, kill, and the limit. That two real Workers actually run at the same time is a claim only a browser can
 * settle, and it is asserted in `tests/browser/process-host.spec.ts`.
 */

class FakeWorker implements ProcessWorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(message: string): void {
    this.onerror?.({ message });
  }
}

const hostWith = (maxProcesses = 4) => {
  const spawned: FakeWorker[] = [];
  const host = new ProcessHost({
    maxProcesses,
    spawn: () => {
      const worker = new FakeWorker();
      spawned.push(worker);
      return worker;
    },
  });
  return { host, spawned };
};

describe("process host", () => {
  it("spawns one Worker per process, with its own channel and an init message carrying pid, argv and env", () => {
    const { host, spawned } = hostWith();
    const first = host.start({ argv: ["node", "a.js"], env: { NODE_ENV: "test" } });
    const second = host.start({ argv: ["node", "b.js"] });

    expect(spawned).toHaveLength(2);
    expect(first.pid).toBe(1);
    expect(second.pid).toBe(2);
    // Separate buffers per process is the whole point: one process cannot block another's channel.
    expect(first.allocation.buffer).not.toBe(second.allocation.buffer);

    const init = spawned[0]?.posted[0] as { pid: number; argv: string[]; env: Record<string, string>; buffer: SharedArrayBuffer };
    expect(init.pid).toBe(1);
    expect(init.argv).toEqual(["node", "a.js"]);
    expect(init.env).toEqual({ NODE_ENV: "test" });
    expect(init.buffer).toBe(first.allocation.buffer);
    expect(host.table.live()).toHaveLength(2);
  });

  it("records an exit the Worker reports and releases the Worker", () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    spawned[0]?.emit({ type: "exit", code: 0 });

    expect(host.table.get(pid)).toMatchObject({ state: "exited", exitCode: 0, endedAt: expect.any(Number) });
    expect(spawned[0]?.terminated).toBe(true);
    expect(host.table.live()).toHaveLength(0);
  });

  it("records a Worker error as a failed process with the message kept", () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    spawned[0]?.fail("boom");

    expect(host.table.get(pid)).toMatchObject({ state: "failed", reason: "boom" });
  });

  it("kills a process by terminating its Worker and marking it killed, leaving the others alone", () => {
    const { host, spawned } = hostWith();
    const first = host.start({ argv: ["node", "a.js"] });
    const second = host.start({ argv: ["node", "b.js"] });

    expect(host.kill(first.pid, "user request")).toBe(true);

    expect(spawned[0]?.terminated).toBe(true);
    expect(spawned[1]?.terminated).toBe(false);
    expect(host.table.get(first.pid)).toMatchObject({ state: "killed", reason: "user request" });
    expect(host.table.get(second.pid).state).toBe("running");
    expect(host.kill(first.pid)).toBe(false);
  });

  it("does not spawn beyond the limit, so a runaway spawn loop hits a wall", () => {
    const { host, spawned } = hostWith(1);
    host.start({ argv: ["node", "a.js"] });

    expect(() => host.start({ argv: ["node", "b.js"] })).toThrow(ProcessLimitError);
    expect(spawned).toHaveLength(1);
  });

  it("ignores unrelated Worker messages instead of mangling the table", () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    spawned[0]?.emit({ type: "stdout", text: "hello" });
    spawned[0]?.emit(null);
    spawned[0]?.emit("not an object");

    expect(host.table.get(pid).state).toBe("running");
  });

  it("lists live channels for a kernel loop, and drops them when a process ends", () => {
    const { host, spawned } = hostWith();
    const first = host.start({ argv: ["node", "a.js"] });
    const second = host.start({ argv: ["node", "b.js"] });

    expect(host.channels().map((entry) => entry.pid)).toEqual([1, 2]);

    spawned[0]?.emit({ type: "exit", code: 0 });
    expect(host.channels().map((entry) => entry.pid)).toEqual([second.pid]);
    // The dead process keeps neither its Worker nor its shared buffer: a channel is live memory, and a table of finished
    // pids holding buffers is a leak that would only show up as "why is the tab using 400 MB".
    expect(() => host.channelFor(first.pid)).toThrow(/No syscall channel/);
  });
});

/**
 * A refusal at the worker-message boundary.
 *
 * This is the first place on this side of the thread that sees what the program's Worker said it was, so it is the place that has to get it
 * right: validate the record, carry it to the settle notification AND to the table, and leave the ordinary exit behaviour untouched. Four
 * outcomes are distinguished here and only the first may ever be classified as a refusal - a DECLARED refusal, an ordinary exit, a crash, and
 * a worker/harness fault.
 */
describe("a refusal reported by a process Worker", () => {
  const refusal = {
    code: "native-addon" as const,
    capability: "native addon",
    message: "Cannot load native addon /addon.node: native addons are not supported in this runtime.",
    subject: "/addon.node",
  };

  const settled = () => {
    const seen: { readonly pid: number; readonly code: number; readonly refusal: unknown }[] = [];
    const spawned: FakeWorker[] = [];
    const host = new ProcessHost({
      spawn: () => {
        const worker = new FakeWorker();
        spawned.push(worker);
        return worker;
      },
      onSettled: (pid, code, reported) => seen.push({ pid, code, refusal: reported }),
    });
    return { host, spawned, seen };
  };

  it("carries the refusal to the settle notification and to the table, keeping the status it exited with", () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    spawned[0]?.emit({ type: "exit", code: 1, refusal });

    const entry = host.table.get(pid);
    expect(entry.state).toBe("exited");
    expect(entry.exitCode).toBe(1);
    expect(entry.refusal).toEqual(refusal);
    // Both lanes, because different readers use different ones: the container builds its record from the outcome the settle produces, while
    // `ps` reads the table. A refusal visible in only one of them is invisible to whichever reader happens to be the other.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.refusal).toEqual(refusal);
    expect(seen[0]?.code).toBe(1);
  });

  it("revives the refusal into the runtime's frozen shape rather than trusting the object it received", () => {
    const { host, spawned } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    spawned[0]?.emit({ type: "exit", code: 1, refusal: { ...refusal } });

    const carried = host.table.get(pid).refusal;
    expect(Object.isFrozen(carried)).toBe(true);
  });

  it("does not turn an ordinary exit into a refusal, whichever status it left", () => {
    const { host, spawned, seen } = settled();
    const first = host.start({ argv: ["node", "ok.js"] });
    const second = host.start({ argv: ["node", "fails.js"] });

    spawned[0]?.emit({ type: "exit", code: 0 });
    spawned[1]?.emit({ type: "exit", code: 1 });

    expect(host.table.get(first.pid).refusal).toBeUndefined();
    expect(host.table.get(second.pid).refusal).toBeUndefined();
    // In particular a non-zero status is NOT evidence of a refusal: that inference is what made a crash look like a design decision.
    expect(seen.map((entry) => entry.refusal)).toEqual([undefined, undefined]);
  });

  it("drops a malformed refusal and keeps the exit it came with, because a bad diagnostic is not a classification", () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    spawned[0]?.emit({ type: "exit", code: 1, refusal: { ...refusal, code: "looks-by-design" } });

    const entry = host.table.get(pid);
    expect(entry.state).toBe("exited");
    expect(entry.exitCode).toBe(1);
    expect(entry.refusal).toBeUndefined();
    expect(seen[0]?.refusal).toBeUndefined();
  });

  it("reports a crash as failed with no refusal, even if the crash names one in its message", () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    // A worker fault carries a reason, never a refusal record: the classification is not available to be inferred from prose.
    spawned[0]?.emit({ type: "failed", reason: refusal.message });

    expect(host.table.get(pid).state).toBe("failed");
    expect(host.table.get(pid).refusal).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("does not lose the refusal when the process is held open by a server it started", () => {
    // A refusal cannot hold a process open in practice (it ends the run with no ports), but the hold-open branch returns before `finish`, so
    // the notification is the only carrier there. A settle that announced a refusal must announce it on every path.
    const seen: unknown[] = [];
    const worker = new FakeWorker();
    const host = new ProcessHost({
      spawn: () => worker,
      holdOpen: () => true,
      onSettled: (_pid, _code, reported) => seen.push(reported),
    });
    const { pid } = host.start({ argv: ["node", "app.js"] });

    worker.emit({ type: "exit", code: 1, refusal });

    expect(seen).toEqual([refusal]);
    expect(host.table.get(pid).state).toBe("running");
    expect(host.table.get(pid).refusal).toBeUndefined();
  });
});

describe("serving a process without blocking the kernel", () => {
  const sizes = { requestBytes: 256, responseBytes: 256 };

  const stageRequest = (buffer: SharedArrayBuffer, value: unknown): void => {
    const header = new Int32Array(buffer, 0, 16);
    const region = new Uint8Array(buffer, CHANNEL_HEADER_BYTES, sizes.requestBytes);
    const payload = framedEncoding.encode(value);
    region.set(payload);
    Atomics.store(header, 1, payload.byteLength);
    Atomics.store(header, 3, 1);
    Atomics.store(header, 0, CHANNEL_STATE.requestPending);
    Atomics.notify(header, 0);
  };

  it("answers a request that is already staged", async () => {
    const allocation = allocateChannel(sizes);
    stageRequest(allocation.buffer, { op: "read", path: "/a.txt" });
    const end = await serveChannelAsync(allocation);

    const served = await end.serveOne((request) => ({ seen: request }), { timeoutMs: 50 });

    expect(served).toBe(true);
    const header = new Int32Array(allocation.buffer, 0, 16);
    const length = Atomics.load(header, 2);
    const region = new Uint8Array(allocation.buffer, CHANNEL_HEADER_BYTES + sizes.requestBytes, sizes.responseBytes);
    expect(framedEncoding.decode(region.slice(0, length))).toEqual({
      ok: true,
      value: { seen: { op: "read", path: "/a.txt" } },
    });
  });

  it("returns false on a deadline instead of parking the thread, and stays usable", async () => {
    const allocation = allocateChannel(sizes);
    const end = await serveChannelAsync(allocation);

    const startedAt = Date.now();
    const nothing = await end.serveOne(() => "unused", { timeoutMs: 25 });
    const elapsed = Date.now() - startedAt;

    expect(nothing).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(20);

    // Still usable: a kernel that gave up waiting must be able to serve the next request.
    stageRequest(allocation.buffer, { op: "stat" });
    expect(await end.serveOne(() => "ok", { timeoutMs: 50 })).toBe(true);
  });

  it("serves several channels concurrently, which a blocking wait could not do", async () => {
    const first = allocateChannel(sizes);
    const second = allocateChannel(sizes);
    stageRequest(first.buffer, { from: "first" });
    stageRequest(second.buffer, { from: "second" });

    const [endA, endB] = await Promise.all([serveChannelAsync(first), serveChannelAsync(second)]);
    const answers = await Promise.all([
      endA.serveOne((request) => (request as { from: string }).from, { timeoutMs: 50 }),
      endB.serveOne((request) => (request as { from: string }).from, { timeoutMs: 50 }),
    ]);

    expect(answers).toEqual([true, true]);
  });
});
