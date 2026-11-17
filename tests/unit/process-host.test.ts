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

  /** The private control port the host transferred in the bootstrap message, and the session it belongs to. */
  private control(): { postMessage(message: unknown): void; session: string | undefined } | undefined {
    const start = this.posted[0] as { control?: { postMessage(message: unknown): void }; session?: string } | undefined;
    if (start?.control === undefined) return undefined;
    return { postMessage: (message: unknown) => start.control!.postMessage(message), session: start.session };
  }

  /**
   * Report as the process adapter does now: on the private control channel, stamped with its session.
   *
   * Async because Node delivers port messages on the event loop, and the boundary is genuinely asynchronous now - the old synchronous
   * `onmessage` shortcut is what made a forged message indistinguishable from a real one.
   */
  async emitTrusted(data: unknown): Promise<void> {
    const control = this.control();
    if (control === undefined) throw new Error("the process was never booted with a control port");
    control.postMessage({ ...(data as Record<string, unknown>), session: control.session });
    // Two turns: a MessagePort delivery is a macrotask, and one `setImmediate` is not always enough for it to land.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** The untrusted channel user code can post on. Kept as its own name so a test cannot accidentally use it to mean "real". */
  emitUntrusted(data: unknown): void {
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
  it("spawns one Worker per process, with its own channel and an init message carrying pid, argv and env", async () => {
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

  it("records an exit the Worker reports and releases the Worker", async () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });

    expect(host.table.get(pid)).toMatchObject({ state: "exited", exitCode: 0, endedAt: expect.any(Number) });
    expect(spawned[0]?.terminated).toBe(true);
    expect(host.table.live()).toHaveLength(0);
  });

  it("records a Worker error as a failed process with the message kept", async () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    spawned[0]?.fail("boom");

    expect(host.table.get(pid)).toMatchObject({ state: "failed", reason: "boom" });
  });

  it("kills a process by terminating its Worker and marking it killed, leaving the others alone", async () => {
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

  it("does not spawn beyond the limit, so a runaway spawn loop hits a wall", async () => {
    const { host, spawned } = hostWith(1);
    host.start({ argv: ["node", "a.js"] });

    expect(() => host.start({ argv: ["node", "b.js"] })).toThrow(ProcessLimitError);
    expect(spawned).toHaveLength(1);
  });

  it("ignores unrelated Worker messages instead of mangling the table", async () => {
    const { host, spawned } = hostWith();
    const { pid } = host.start({ argv: ["node", "a.js"] });

    await spawned[0]?.emitTrusted({ type: "stdout", text: "hello" });
    await spawned[0]?.emitTrusted(null);
    await spawned[0]?.emitTrusted("not an object");

    expect(host.table.get(pid).state).toBe("running");
  });

  it("lists live channels for a kernel loop, and drops them when a process ends", async () => {
    const { host, spawned } = hostWith();
    const first = host.start({ argv: ["node", "a.js"] });
    const second = host.start({ argv: ["node", "b.js"] });

    expect(host.channels().map((entry) => entry.pid)).toEqual([1, 2]);

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
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

  it("carries the refusal to the settle notification and to the table, keeping the status it exited with", async () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 1, refusal });

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

  it("revives the refusal into the runtime's frozen shape rather than trusting the object it received", async () => {
    const { host, spawned } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 1, refusal: { ...refusal } });

    const carried = host.table.get(pid).refusal;
    expect(Object.isFrozen(carried)).toBe(true);
  });

  it("does not turn an ordinary exit into a refusal, whichever status it left", async () => {
    const { host, spawned, seen } = settled();
    const first = host.start({ argv: ["node", "ok.js"] });
    const second = host.start({ argv: ["node", "fails.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
    await spawned[1]?.emitTrusted({ type: "exit", code: 1 });

    expect(host.table.get(first.pid).refusal).toBeUndefined();
    expect(host.table.get(second.pid).refusal).toBeUndefined();
    // In particular a non-zero status is NOT evidence of a refusal: that inference is what made a crash look like a design decision.
    expect(seen.map((entry) => entry.refusal)).toEqual([undefined, undefined]);
  });

  it("drops a malformed refusal and keeps the exit it came with, because a bad diagnostic is not a classification", async () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 1, refusal: { ...refusal, code: "looks-by-design" } });

    const entry = host.table.get(pid);
    expect(entry.state).toBe("exited");
    expect(entry.exitCode).toBe(1);
    expect(entry.refusal).toBeUndefined();
    expect(seen[0]?.refusal).toBeUndefined();
  });

  it("reports a crash as failed with no refusal, even if the crash names one in its message", async () => {
    const { host, spawned, seen } = settled();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    // A worker fault carries a reason, never a refusal record: the classification is not available to be inferred from prose.
    await spawned[0]?.emitTrusted({ type: "failed", reason: refusal.message });

    expect(host.table.get(pid).state).toBe("failed");
    expect(host.table.get(pid).refusal).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("does not lose the refusal when the process is held open by a server it started", async () => {
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

    await worker.emitTrusted({ type: "exit", code: 1, refusal });

    expect(seen).toEqual([refusal]);
    expect(host.table.get(pid).state).toBe("running");
    expect(host.table.get(pid).refusal).toBeUndefined();
  });
});


/**
 * Exactly one settlement per process.
 *
 * `onSettled` is the host's promise that a run is over, and every reader downstream treats it that way: the kernel records the settle outcome
 * first-wins, the harness counts settled runs. So the count itself is the contract, not just the payload - a second invocation for one exit is
 * a run that happened once being reported twice, and the table cannot police it, because a held-open process is settled AND still `running`.
 *
 * Six ways a process can end are counted here. Five announce exactly one settlement; a worker fault announces NONE through this callback (it is
 * a state transition, `failed`, and the kernel settles from `onChange`), which is worth pinning: "settled" must mean "the program reported an
 * exit", not "something ended".
 */
describe("exactly one settlement per process", () => {
  const refusal = {
    code: "native-addon" as const,
    capability: "native addon",
    message: "Cannot load native addon /addon.node: native addons are not supported in this runtime.",
    subject: "/addon.node",
  };

  const counter = (options: { readonly holdOpen?: boolean } = {}) => {
    const calls: { readonly pid: number; readonly code: number; readonly refusal: unknown }[] = [];
    const transitions: string[] = [];
    const spawned: FakeWorker[] = [];
    const host = new ProcessHost({
      spawn: () => {
        const worker = new FakeWorker();
        spawned.push(worker);
        return worker;
      },
      ...(options.holdOpen === true ? { holdOpen: () => true } : {}),
      onChange: (entry) => transitions.push(`${entry.pid}:${entry.state}`),
      onSettled: (pid, code, reported) => calls.push({ pid, code, refusal: reported }),
    });
    return { host, spawned, calls, transitions };
  };

  it("announces one settlement for a declared refusal, carrying the status and the refusal together", async () => {
    const { host, spawned, calls, transitions } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 1, refusal });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pid, code: 1, refusal });
    // One settlement callback, one terminal transition: the callback is not a second write to the table.
    expect(transitions.filter((entry) => entry.endsWith(":exited"))).toHaveLength(1);
  });

  it("announces one settlement for an ordinary exit code 0", async () => {
    const { host, spawned, calls } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });

    expect(calls).toEqual([{ pid, code: 0, refusal: undefined }]);
    expect(host.table.get(pid).exitCode).toBe(0);
  });

  it("announces one settlement for an ordinary non-zero exit, and no refusal with it", async () => {
    const { host, spawned, calls } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 2 });

    expect(calls).toEqual([{ pid, code: 2, refusal: undefined }]);
    expect(host.table.get(pid).refusal).toBeUndefined();
  });

  it("announces one settlement for a malformed refusal, which is dropped rather than passed on", async () => {
    const { host, spawned, calls } = counter();
    host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 1, refusal: { ...refusal, code: "not-a-real-code" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.refusal).toBeUndefined();
    expect(calls[0]?.code).toBe(1);
  });

  it("announces no settlement for a worker fault, because a fault is not an exit report", async () => {
    const { host, spawned, calls, transitions } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "failed", reason: "the worker died" });

    expect(calls).toHaveLength(0);
    expect(transitions).toContain(`${pid}:failed`);
    expect(host.table.get(pid).reason).toBe("the worker died");
  });

  it("announces no settlement for a Worker that errors instead of reporting", async () => {
    const { host, spawned, calls } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    spawned[0]?.fail("boom");

    expect(calls).toHaveLength(0);
    expect(host.table.get(pid).state).toBe("failed");
  });

  it("announces one settlement for a held-open process, and leaves it running", async () => {
    const { host, spawned, calls, transitions } = counter({ holdOpen: true });
    const { pid } = host.start({ argv: ["node", "server.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0, refusal });

    expect(calls).toHaveLength(1);
    // Held open is the one case where a settled process is NOT terminal, which is exactly why the table cannot be the guard.
    expect(host.table.get(pid).state).toBe("running");
    expect(transitions).not.toContain(`${pid}:exited`);
  });

  it("does not announce a second settlement when the same exit arrives twice", async () => {
    const { host, spawned, calls } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
    // A Worker whose queue flushes a second exit report, or a host wired to a port that duplicates a message. The run happened once.
    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });

    expect(calls).toHaveLength(1);
    expect(host.table.get(pid).exitCode).toBe(0);
  });

  it("does not announce a settlement when an exit follows a reported failure", async () => {
    const { host, spawned, calls } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    await spawned[0]?.emitTrusted({ type: "failed", reason: "the worker died" });
    await spawned[0]?.emitTrusted({ type: "exit", code: 1 });

    // The fault already ended this process; an exit arriving afterwards must not present it as a program that exited.
    expect(calls).toHaveLength(0);
    expect(host.table.get(pid).state).toBe("failed");
  });

  it("announces no settlement for a process that was killed and then reports its exit", async () => {
    const { host, spawned, calls, transitions } = counter();
    const { pid } = host.start({ argv: ["node", "app.js"] });

    const killed = host.kill(pid, "test kill");
    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });

    // The kill is the settlement, and the kernel already records it from the state transition. An exit report arriving afterwards must not
    // present the process as one that finished by itself, with a status that contradicts the kill.
    expect(killed).toBe(true);
    expect(calls).toHaveLength(0);
    expect(host.table.get(pid).state).toBe("killed");
    expect(transitions.filter((entry) => entry.endsWith(":killed"))).toHaveLength(1);
  });

  it("makes exactly one terminal transition per process, whichever way it ends", async () => {
    const { host, spawned, transitions } = counter();
    const exits = host.start({ argv: ["node", "a.js"] });
    const fails = host.start({ argv: ["node", "b.js"] });
    const killed = host.start({ argv: ["node", "c.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
    await spawned[1]?.emitTrusted({ type: "failed", reason: "the worker died" });
    host.kill(killed.pid, "test kill");
    // Late reports, which must add no transition of their own.
    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
    await spawned[1]?.emitTrusted({ type: "exit", code: 1 });
    await spawned[2]?.emitTrusted({ type: "exit", code: 0 });

    const terminal = (pid: number) => transitions.filter((entry) => entry.startsWith(`${pid}:`) && /:(exited|failed|killed)$/.test(entry)).length;
    expect(terminal(exits.pid)).toBe(1);
    expect(terminal(fails.pid)).toBe(1);
    expect(terminal(killed.pid)).toBe(1);
  });

  it("settles a held-open process once even when its exit is reported twice", async () => {
    const { host, spawned, calls } = counter({ holdOpen: true });
    const { pid } = host.start({ argv: ["node", "server.js"] });

    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });
    await spawned[0]?.emitTrusted({ type: "exit", code: 0 });

    expect(calls).toHaveLength(1);
    expect(host.table.get(pid).state).toBe("running");
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

/**
 * The boundary's NEGATIVES, which are the point of W-19 P2.
 *
 * Each of the first two was a real attack before the change: a forged `exit` on the ordinary channel settled the kernel with a status
 * the program chose, and any message that arrived without a session was believed.
 */
it("ignores a report arriving on the ordinary Worker channel", async () => {
  const { host, spawned } = hostWith();
  const { pid } = host.start({ argv: ["node", "a.js"] });

  spawned[0]?.emitUntrusted({ type: "exit", code: 0 });

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(host.table.get(pid).state).toBe("running");
});

it("ignores a control message stamped with another session", async () => {
  const { host, spawned } = hostWith();
  const { pid } = host.start({ argv: ["node", "a.js"] });
  const start = (spawned[0] as unknown as { posted: { control: { postMessage(message: unknown): void } }[] }).posted[0]!;

  start.control.postMessage({ type: "exit", code: 0, session: "not-this-session" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(host.table.get(pid).state).toBe("running");
});

it("drops the control channel when the process is killed", async () => {
  const { host } = hostWith();
  const { pid } = host.start({ argv: ["node", "a.js"] });
  expect(host.controlChannels()).toContain(pid);

  host.kill(pid);

  expect(host.controlChannels()).not.toContain(pid);
});
