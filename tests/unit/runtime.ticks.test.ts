import { describe, expect, it } from "vitest";
import { TickQueue } from "../../src/runtime/ticks.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

/**
 * `process.nextTick` ordering.
 *
 * Every expected order below was measured by running the same program in real Node (v20) through the differential tool
 * in `tools/differential`. Hardcoding them here is deliberate: the value of these tests is that they encode Node's
 * answer, not ours, so a future refactor that quietly restores microtask-based ticks fails immediately.
 */
describe("TickQueue", () => {
  it("drains a callback queued before a promise continuation, regardless of registration order", async () => {
    const out: string[] = [];
    const ticks = new TickQueue();

    // The `.then` is registered FIRST on purpose: this is the case that a microtask-based flush gets wrong.
    void Promise.resolve().then(() => out.push("promise"));
    ticks.schedule(() => out.push("tick1"));
    ticks.flushNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(out).toEqual(["tick1", "promise"]);
  });

  it("drains nested ticks to quiescence before promise continuations", async () => {
    const out: string[] = [];
    const ticks = new TickQueue();

    void Promise.resolve().then(() => out.push("promise1"));
    ticks.schedule(() => {
      out.push("tick1");
      ticks.schedule(() => out.push("tick-nested"));
    });
    void Promise.resolve().then(() => out.push("promise2"));
    ticks.flushNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(out).toEqual(["tick1", "tick-nested", "promise1", "promise2"]);
  });

  it("keeps first-in-first-out order across several queued callbacks", () => {
    const out: number[] = [];
    const ticks = new TickQueue();

    for (const n of [1, 2, 3]) ticks.schedule(() => out.push(n));
    ticks.flushNow();

    expect(out).toEqual([1, 2, 3]);
  });

  it("passes arguments through", () => {
    const out: unknown[] = [];
    const ticks = new TickQueue();

    ticks.schedule(((...args: readonly unknown[]) => out.push(args)) as never, ["a", 2]);
    ticks.flushNow();

    expect(out).toEqual([["a", 2]]);
  });

  it("reports pending while work is queued and not after a flush", () => {
    const ticks = new TickQueue();
    expect(ticks.pending).toBe(false);

    ticks.schedule(() => undefined);
    expect(ticks.pending).toBe(true);

    ticks.flushNow();
    expect(ticks.pending).toBe(false);
  });

  it("flushes on its own microtask when the runner does not flush synchronously", async () => {
    const out: string[] = [];
    const ticks = new TickQueue();

    ticks.schedule(() => out.push("tick"));
    expect(out).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(out).toEqual(["tick"]);
  });

  it("does not drop later callbacks when one throws", () => {
    const out: string[] = [];
    const ticks = new TickQueue();
    const error = new Error("tick exploded");

    ticks.schedule(() => {
      throw error;
    });
    ticks.schedule(() => out.push("after"));

    // The throw leaves the queue, so the flush aborts; the remaining callback must not vanish with it.
    expect(() => ticks.flushNow()).toThrow(error);
    expect(ticks.pending).toBe(true);
    ticks.flushNow();
    expect(out).toEqual(["after"]);
  });
});

describe("runtime event-loop ordering", () => {
  const run = async (source: string): Promise<string> => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/main.js", source);
    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run("/main.js", { timeoutMs: 2_000 });
    return result.stdout.trim();
  };

  it("runs nextTick before a promise continuation registered earlier", async () => {
    const stdout = await run(
      [
        "const out = [];",
        "Promise.resolve().then(() => out.push('promise'));",
        "process.nextTick(() => out.push('nextTick'));",
        "setTimeout(() => console.log(out.join(',')), 5);",
      ].join("\n"),
    );

    expect(stdout).toBe("nextTick,promise");
  });

  it("drains a nested nextTick before microtasks", async () => {
    const stdout = await run(
      [
        "const out = [];",
        "Promise.resolve().then(() => out.push('promise1'));",
        "process.nextTick(() => {",
        "  out.push('tick1');",
        "  process.nextTick(() => out.push('tick-nested'));",
        "});",
        "Promise.resolve().then(() => out.push('promise2'));",
        "setTimeout(() => console.log(out.join(',')), 5);",
      ].join("\n"),
    );

    expect(stdout).toBe("tick1,tick-nested,promise1,promise2");
  });

  it("resumes an await after the tick queue, not before it", async () => {
    const stdout = await run(
      [
        "const out = [];",
        "async function main() {",
        "  out.push('sync-start');",
        "  process.nextTick(() => out.push('tick'));",
        "  await Promise.resolve();",
        "  out.push('after-await');",
        "}",
        "void main();",
        "Promise.resolve().then(() => out.push('then'));",
        "setTimeout(() => console.log(out.join(',')), 5);",
      ].join("\n"),
    );

    expect(stdout).toBe("sync-start,tick,after-await,then");
  });

  it("lets a promise chain settle before a timer that was registered first", async () => {
    const stdout = await run(
      [
        "const out = [];",
        "setTimeout(() => console.log(out.join(',')), 5);",
        "Promise.resolve().then(() => { out.push('m1'); return Promise.resolve(); }).then(() => out.push('m2'));",
      ].join("\n"),
    );

    expect(stdout).toBe("m1,m2");
  });
});
