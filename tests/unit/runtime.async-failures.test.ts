/**
 * W-40: one contract for an uncaught ASYNCHRONOUS exception.
 *
 * The defect was measured, not suspected. `setTimeout(() => { throw new Error("late boom"); }, 0)` printed
 * `Uncaught Error: late boom` and settled with **exit code 0**, so a fixture whose last assertion was "the program exited
 * zero" PASSED on a crashed program. Production output said `Uncaught`; the verdict said success. A `process.nextTick`
 * throw was worse: it escaped `run()` as a rejection, so a caller got no `ExecutionResult` at all - in the harness that
 * killed the process, and in a process Worker it became a transport-level `failed` instead of an exit status.
 *
 * Every expected status and output below was MEASURED in Node v20.20.2 rather than reasoned about, because the whole point
 * of this file is that our answer and Node's have to match:
 *
 *   setTimeout(() => { throw e }, 0)                 -> prints the stack, exits 1, later timers never run
 *   process.nextTick(() => { throw e })              -> prints the stack, exits 1
 *   try { throw e } catch {}  inside either          -> exits 0
 *   Promise.reject(e) with no handler                -> prints the reason, exits 1
 *   process.exit(3)                                  -> exits 3, nothing printed as uncaught
 *   process.exitCode = 3; then a throw                -> exits 1 (the throw wins)
 *
 * The four outcomes this runtime distinguishes stay distinguishable: an uncaught exception, an unhandled rejection, an
 * explicit non-zero exit and a declared runtime refusal are four different things, and only two of them are failures.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { TickQueue } from "../../src/runtime/ticks.js";
import { FileSystem } from "../../src/vfs/index.js";

const run = async (source: string) => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/main.js", source);
  const runtime = new InProcessRuntime(vfs);
  return runtime.run("/app/main.js", { cwd: "/app", timeoutMs: 2_000 });
};

/** The number of `Uncaught …` lines, which must be one per failure and never one per flush. */
const uncaughtLines = (stderr: string): string[] => stderr.split("\n").filter((line) => line.startsWith("Uncaught "));

describe("a timer callback that throws", () => {
  it("settles with exit 1 instead of a successful status", async () => {
    const result = await run('setTimeout(() => { throw new Error("late boom"); }, 0);');

    // The exact assertion that used to pass and must never pass again: this is the W-40 regression, stated as the fixture
    // harness would state it.
    expect(result.exitCode === 0).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("is reported in the shape Node prints, and attributed on the result", async () => {
    const result = await run('setTimeout(() => { throw new Error("late boom"); }, 0);');

    expect(uncaughtLines(result.stderr)).toHaveLength(1);
    expect(result.stderr).toContain("Uncaught Error: late boom");
    expect(result.asyncFailures).toHaveLength(1);
    expect(result.asyncFailures?.[0]).toMatchObject({ source: "timer", phase: "run", name: "Error" });
    // The record and the printed line cannot disagree: a supervisor deciding from the record must see what a reader sees.
    expect(result.asyncFailures?.[0]?.message).toContain("late boom");
    // The record carries the whole stack, so its first line is what the printed line must match exactly.
    expect(uncaughtLines(result.stderr)[0]).toBe(`Uncaught ${(result.asyncFailures?.[0]?.message ?? "").split("\n")[0] ?? ""}`);
  });

  it("stops the timers queued behind it, as Node does when the process ends", async () => {
    const result = await run(`
      setTimeout(() => { console.log("before"); throw new Error("late boom"); }, 0);
      setTimeout(() => console.log("after"), 5);
    `);

    // Node v20.20.2 prints `before` and exits 1; `after` never runs. Draining on would be our own invention.
    expect(result.stdout).toBe("before\n");
    expect(result.exitCode).toBe(1);
  });

  it("is the run's status even when the program set a different exit code first", async () => {
    const result = await run(`
      process.exitCode = 3;
      setTimeout(() => { throw new Error("late boom"); }, 0);
    `);

    // Node: the throw wins, exits 1. A set `exitCode` must never mask a crash.
    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures).toHaveLength(1);
  });
});

describe("a process.nextTick callback that throws", () => {
  it("settles the run instead of rejecting it", async () => {
    // The old route: the throw left `ticks.flushNow()` inside `runBody`'s `finally`, so `run()` REJECTED and the caller had
    // no result, no status and nothing to classify - and in Node that rejection also killed the harness process.
    const result = await run('process.nextTick(() => { throw new Error("tick boom"); });');

    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures?.[0]).toMatchObject({ source: "tick", phase: "run", name: "Error" });
    expect(result.stderr).toContain("Uncaught Error: tick boom");
  });

  it("never leaves the run pending on the virtual clock", async () => {
    // A throw used to abandon the flush with the queue marked live, and a waiter polling `pending` spun for the whole
    // budget. The run has to finish on its own, not on the harness's timeout.
    const result = await run('process.nextTick(() => { throw new Error("tick boom"); });');

    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(2_000);
  });
});

describe("timer draining and tick draining together", () => {
  it("reports one failure and one settlement when both queues hold a throw", async () => {
    const result = await run(`
      setTimeout(() => { throw new Error("timer boom"); }, 0);
      process.nextTick(() => { throw new Error("tick boom"); });
    `);

    // Node runs the tick phase before the timer phase, so the tick's failure is the one that ends the process; the timer
    // never gets to throw. One failure, one line, one status.
    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures).toHaveLength(1);
    expect(result.asyncFailures?.[0]?.source).toBe("tick");
    expect(uncaughtLines(result.stderr)).toHaveLength(1);
  });

  it("attributes a tick thrown from inside a timer callback", async () => {
    const result = await run('setTimeout(() => { process.nextTick(() => { throw new Error("tick in timer"); }); }, 0);');

    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures?.[0]).toMatchObject({ source: "tick" });
    expect(result.stderr).toContain("tick in timer");
  });

  it("attributes a timer thrown from inside a tick callback", async () => {
    const result = await run('process.nextTick(() => { setTimeout(() => { throw new Error("timer in tick"); }, 0); });');

    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures?.[0]).toMatchObject({ source: "timer" });
    expect(result.stderr).toContain("timer in tick");
  });

  it("reports one failure when a second tick was queued behind the throwing one", async () => {
    const result = await run(`
      process.nextTick(() => { throw new Error("first"); });
      process.nextTick(() => { console.log("second"); });
    `);

    // Node dies on the first, so the second never runs. If it did, it would report a second failure for a run that has
    // already been settled - one callback failure producing two settlements, which is the shape requirement 7 forbids.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.asyncFailures).toHaveLength(1);
    expect(uncaughtLines(result.stderr)).toHaveLength(1);
  });

  it("reports a throw from a tick queued by a tick", async () => {
    const result = await run(`
      process.nextTick(() => {
        process.nextTick(() => { throw new Error("nested tick"); });
      });
    `);

    expect(result.exitCode).toBe(1);
    expect(uncaughtLines(result.stderr)).toHaveLength(1);
  });
});

describe("the outcomes that are not an uncaught exception stay clean", () => {
  it("does not fail the run for an exception the program caught in a timer", async () => {
    const result = await run('setTimeout(() => { try { throw new Error("x"); } catch { console.log("caught"); } }, 0);');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("caught\n");
    expect(result.stderr).toBe("");
    expect(result.asyncFailures).toBeUndefined();
  });

  it("does not fail the run for an exception the program caught in a tick", async () => {
    const result = await run('process.nextTick(() => { try { throw new Error("x"); } catch { console.log("caught"); } });');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("caught\n");
    expect(result.asyncFailures).toBeUndefined();
  });

  it("keeps an unhandled rejection its own outcome, with its own source", async () => {
    const result = await run('Promise.reject(new Error("rejected"));');

    expect(result.exitCode).toBe(1);
    // Distinct from a timer or tick throw on purpose: the supervisor has to be able to tell them apart afterwards.
    expect(result.asyncFailures?.[0]).toMatchObject({ source: "rejection", name: "Error" });
    expect(result.stderr).toContain("Uncaught Error: rejected");
  });

  it("leaves an explicit non-zero exit alone", async () => {
    const result = await run('setTimeout(() => { console.log("bye"); process.exit(3); }, 0);');

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("bye\n");
    // `process.exit` is the program choosing its status, not a crash: nothing is printed as uncaught and nothing is recorded.
    expect(result.stderr).not.toContain("Uncaught");
    expect(result.asyncFailures).toBeUndefined();
  });

  it("does not record a declared refusal as an asynchronous failure", async () => {
    const result = await run('require("child_process").execSync("esbuild --version");');

    // ADR-0014's refusal is a fifth thing again: typed, declared, and carried on `refusal`. Recording it as a crash would
    // collapse the distinction the fixture corpus depends on.
    expect(result.refusal).toBeDefined();
    expect(result.exitCode).toBe(1);
    expect(result.asyncFailures).toBeUndefined();
    expect(result.stderr).not.toContain("Uncaught");
  });
});

describe("no failure escapes the runtime", () => {
  const programs: [name: string, source: string][] = [
    ["timer", 'setTimeout(() => { throw new Error("boom"); }, 0);'],
    ["tick", 'process.nextTick(() => { throw new Error("boom"); });'],
    ["both", 'setTimeout(() => { throw new Error("boom"); }, 0);\nprocess.nextTick(() => { throw new Error("boom"); });'],
    ["nested", 'setTimeout(() => { process.nextTick(() => { throw new Error("boom"); }); }, 0);'],
    ["rejection", "Promise.reject(new Error(\"boom\"));"],
    ["throw after await", "await null; throw new Error(\"boom\");"],
    ["exit then throw", 'process.nextTick(() => { throw new Error("boom"); });\nprocess.exit(0);'],
  ];

  it("settles every one of them, and never rejects out of run()", async () => {
    for (const [name, source] of programs) {
      const result = await run(source).then(
        (value) => value,
        (error: unknown) => error,
      );
      expect(result, `${name} rejected out of run()`).not.toBeInstanceOf(Error);
      const settled = result as Awaited<ReturnType<typeof run>>;
      // Requirement in one line: whatever else is true, an uncaught asynchronous exception never yields a successful status.
      expect(settled.exitCode === 0, `${name} settled with a successful status`).toBe(false);
    }
  });
});

describe("the tick queue's own contract", () => {
  it("reports a throwing callback once and drops the callbacks behind it", () => {
    const failures: unknown[] = [];
    const order: string[] = [];
    const ticks = new TickQueue((error) => failures.push(error));

    ticks.schedule(() => { throw new Error("tick boom"); });
    ticks.schedule(() => order.push("after"));

    expect(() => ticks.flushNow()).not.toThrow();
    expect(failures).toHaveLength(1);
    // Node ends the process here, so `after` never runs. Running it would report a second failure and settle twice.
    expect(order).toEqual([]);
    // A dead queue is not "pending": a waiter polling this would otherwise wait for a callback that will never run.
    expect(ticks.pending).toBe(false);
  });

  it("still re-raises when nobody asked to be told, which is the queue's standalone contract", () => {
    const ticks = new TickQueue();
    ticks.schedule(() => { throw new Error("tick boom"); });

    expect(() => ticks.flushNow()).toThrow("tick boom");
  });
});
