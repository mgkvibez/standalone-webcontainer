/**
 * The scheduler contract (ADR-0013 amendments 1 and 2), tested by running real programs through the runtime.
 *
 * Deliberately end-to-end rather than unit-testing the queue in isolation: the failure this subsystem fixes was a WIRING
 * failure. `setTimeout(fn, 5)` used to schedule onto the host's timers, so the callback had not fired when the output was
 * snapshot, and a program that plainly worked reported nothing. A queue that passes its own tests while user code still
 * gets the host's `setTimeout` would be the same bug with better coverage.
 */
import { describe, expect, it } from "vitest";
import { InProcessRuntime, type RunOptions } from "../../src/runtime/in-process.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { FileSystem } from "../../src/vfs/index.js";

async function runScript(source: string, options: RunOptions = {}) {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", type: "module" }));
  vfs.writeFileSync("/app/s.mjs", source);
  const runtime = new InProcessRuntime(vfs);
  return runtime.run("/app/s.mjs", { argv: ["node", "s.mjs"], cwd: "/app", ...options });
}

const lines = (stdout: string): string[] => stdout.split("\n").filter((line) => line !== "");

describe("1. positive-delay timers actually fire", () => {
  it("runs a 25 ms timer and records the virtual time it consumed", async () => {
    const result = await runScript(`setTimeout(() => console.log("fired"), 25);`);
    expect(lines(result.stdout)).toEqual(["fired"]);
    expect(result.scheduler.callbacks).toBe(1);
    expect(result.scheduler.virtualElapsedMs).toBe(25);
    expect(result.scheduler.stop).toBe("queue-empty");
  });

  it("fires several timers in deadline order regardless of the order they were scheduled", async () => {
    const result = await runScript(`
      setTimeout(() => console.log("late"), 50);
      setTimeout(() => console.log("early"), 10);
      setTimeout(() => console.log("middle"), 30);
    `);
    expect(lines(result.stdout)).toEqual(["early", "middle", "late"]);
    expect(result.scheduler.virtualElapsedMs).toBe(50);
  });
});

describe("2. chained timers", () => {
  it("runs a timer scheduled by a timer, and sums the virtual time", async () => {
    const result = await runScript(`
      setTimeout(() => {
        console.log("first");
        setTimeout(() => console.log("second"), 20);
      }, 10);
    `);
    expect(lines(result.stdout)).toEqual(["first", "second"]);
    expect(result.scheduler.callbacks).toBe(2);
    expect(result.scheduler.virtualElapsedMs).toBe(30);
  });

  it("captures a promise continuation queued inside a timer callback", async () => {
    // The original liveness bug in miniature: the log happens one continuation deeper than the callback.
    const result = await runScript(`
      setTimeout(() => { Promise.resolve().then(() => console.log("through a continuation")); }, 5);
    `);
    expect(lines(result.stdout)).toEqual(["through a continuation"]);
  });
});

describe("3. equal-deadline ordering is deterministic", () => {
  it("fires same-deadline timers in creation order", async () => {
    const result = await runScript(`
      setTimeout(() => console.log("A"), 0);
      setTimeout(() => console.log("B"), 0);
      setTimeout(() => console.log("C"), 0);
    `);
    expect(lines(result.stdout)).toEqual(["A", "B", "C"]);
  });

  it("orders same-instant work by creation order, including setImmediate", async () => {
    // Both are due at 0, so the sequence number decides: whichever was created first fires first. Asserted in both
    // creation orders, because a test that only checked one could pass by luck.
    const timeoutFirst = await runScript(`
      setTimeout(() => console.log("timeout"), 0);
      setImmediate(() => console.log("immediate"));
    `);
    expect(lines(timeoutFirst.stdout)).toEqual(["timeout", "immediate"]);

    const immediateFirst = await runScript(`
      setImmediate(() => console.log("immediate"));
      setTimeout(() => console.log("timeout"), 0);
    `);
    expect(lines(immediateFirst.stdout)).toEqual(["immediate", "timeout"]);
  });

  it("produces identical evidence across two runs of the same program", async () => {
    const source = `
      setTimeout(() => console.log("a"), 10);
      setTimeout(() => console.log("b"), 10);
      setInterval(() => {}, 5);
    `;
    const first = await runScript(source);
    const second = await runScript(source);
    expect(first.stdout).toBe(second.stdout);
    expect(first.scheduler.callbacks).toBe(second.scheduler.callbacks);
    expect(first.scheduler.virtualElapsedMs).toBe(second.scheduler.virtualElapsedMs);
    expect(first.scheduler.stop).toBe(second.scheduler.stop);
  });
});

describe("4. cancellation before execution", () => {
  it("never runs a cleared timeout, and does not count it", async () => {
    const result = await runScript(`
      const handle = setTimeout(() => console.log("should not print"), 10);
      clearTimeout(handle);
      console.log("after clearing");
    `);
    expect(lines(result.stdout)).toEqual(["after clearing"]);
    expect(result.scheduler.callbacks).toBe(0);
    expect(result.scheduler.deferred).toBe(0);
  });

  it("treats a double clear, and clearing an unknown id, as no-ops", async () => {
    const result = await runScript(`
      const handle = setTimeout(() => {}, 5);
      clearTimeout(handle);
      clearTimeout(handle);
      clearTimeout(99999);
      console.log("ok");
    `);
    expect(lines(result.stdout)).toEqual(["ok"]);
    expect(result.stderr).toBe("");
  });
});

describe("5. repeated intervals and their cancellation", () => {
  it("fires repeatedly and stops when cleared from inside its own callback", async () => {
    const result = await runScript(`
      let ticks = 0;
      const handle = setInterval(() => {
        ticks += 1;
        console.log("tick " + ticks);
        if (ticks === 3) clearInterval(handle);
      }, 10);
    `);
    expect(lines(result.stdout)).toEqual(["tick 1", "tick 2", "tick 3"]);
    expect(result.scheduler.virtualElapsedMs).toBe(30);
  });

  it("stops an uncleared 1 ms interval at the per-interval cap of 100 fires", async () => {
    const result = await runScript(`
      let ticks = 0;
      setInterval(() => { ticks += 1; }, 1);
    `);
    // min(ceil(1000 / 1), 100) = 100: the interval cannot run for the whole budget.
    expect(result.scheduler.callbacks).toBe(100);
    expect(result.scheduler.intervalsTruncated).toBe(1);
  });
});

describe("6. Date.now() advances with virtual time", () => {
  it("reports baseline plus virtual elapsed, so a 250 ms timer measures 250 ms", async () => {
    const result = await runScript(`
      const t0 = Date.now();
      setTimeout(() => console.log("delta " + (Date.now() - t0)), 250);
    `);
    expect(lines(result.stdout)).toEqual(["delta 250"]);
  });

  it("starts near the real wall clock, so timestamps remain meaningful", async () => {
    const before = Date.now();
    const result = await runScript(`console.log(Date.now());`);
    const reported = Number(lines(result.stdout)[0]);
    expect(reported).toBeGreaterThanOrEqual(before - 1_000);
    expect(reported).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("makes new Date() agree with Date.now()", async () => {
    const result = await runScript(`
      setTimeout(() => {
        const a = Date.now();
        const b = new Date().getTime();
        console.log(Math.abs(a - b) <= 1 ? "agree" : "disagree " + a + " " + b);
      }, 40);
    `);
    expect(lines(result.stdout)).toEqual(["agree"]);
  });
});

describe("7. performance.now() monotonicity", () => {
  it("starts at zero, advances with virtual time, and never decreases", async () => {
    const result = await runScript(`
      const seen = [];
      const p0 = performance.now();
      seen.push(p0);
      setTimeout(() => {
        seen.push(performance.now());
        setTimeout(() => {
          seen.push(performance.now());
          const monotonic = seen.every((value, index) => index === 0 || value >= seen[index - 1]);
          console.log("start " + seen[0] + " monotonic " + monotonic + " total " + seen[seen.length - 1]);
        }, 60);
      }, 40);
    `);
    expect(lines(result.stdout)).toEqual(["start 0 monotonic true total 100"]);
  });
});

describe("8. zero-delay loop protection", () => {
  it("runs a self-rescheduling 0 ms timer to completion when it is finite", async () => {
    const result = await runScript(`
      let n = 0;
      const step = () => { n += 1; if (n < 50) setTimeout(step, 0); };
      setTimeout(step, 0);
      setTimeout(() => console.log("count " + n), 0);
    `);
    expect(lines(result.stdout).some((line) => line.startsWith("count "))).toBe(true);
  });

  it("stops an infinite 0 ms loop at the callback limit, and says a guard stopped it", async () => {
    const result = await runScript(`
      const loop = () => { setTimeout(loop, 0); };
      setTimeout(loop, 0);
    `);
    // The virtual budget cannot stop this: virtual time never advances, so the callback guard must.
    expect(result.scheduler.stop).toBe("callback-limit");
    expect(result.scheduler.callbacks).toBe(10_000);
    expect(result.scheduler.guarded).toBe(true);
  });
});

describe("9. interval-storm protection", () => {
  it("bounds a 0 ms interval by the callback guard rather than spinning", async () => {
    const result = await runScript(`
      setInterval(() => {}, 0);
    `);
    // A 0 ms interval reaches both caps; the per-interval cap is the callback cap, so either guard ends the run.
    expect(result.scheduler.guarded).toBe(true);
    expect(result.scheduler.callbacks).toBe(10_000);
  });
});

describe("10. budget exhaustion and deterministic termination", () => {
  it("defers a timer past the budget instead of firing or dropping it silently", async () => {
    const result = await runScript(`
      setTimeout(() => console.log("never"), 5000);
      console.log("scheduled");
    `);
    expect(lines(result.stdout)).toEqual(["scheduled"]);
    expect(result.scheduler.stop).toBe("budget-exhausted");
    expect(result.scheduler.deferred).toBe(1);
    expect(result.scheduler.callbacks).toBe(0);
  });

  it("reports queue-empty when a program scheduled nothing", async () => {
    const result = await runScript(`console.log("plain");`);
    expect(result.scheduler.stop).toBe("queue-empty");
    expect(result.scheduler.callbacks).toBe(0);
    expect(result.scheduler.guarded).toBe(false);
  });

  it("records virtual and real elapsed separately, so one is never reported as the other", async () => {
    const result = await runScript(`setTimeout(() => {}, 900);`);
    expect(result.scheduler.virtualElapsedMs).toBe(900);
    // 900 ms of scheduled time must not cost 900 ms of real time, and the evidence must not conflate them.
    expect(result.scheduler.realElapsedMs).toBeLessThan(500);
  });
});

describe("the queue itself", () => {
  it("counts down to termination without a runtime when asked directly", async () => {
    const scheduler = new Scheduler({ budgetMs: 100, maxCallbacks: 5, maxRealMs: 1_000 });
    const fired: number[] = [];
    scheduler.setTimeout(() => fired.push(1), 10);
    scheduler.setTimeout(() => fired.push(2), 10);
    scheduler.setTimeout(() => fired.push(3), 200);
    const evidence = await scheduler.drain();
    expect(fired).toEqual([1, 2]);
    expect(evidence.deferred).toBe(1);
    expect(evidence.stop).toBe("budget-exhausted");
    expect(evidence.guarded).toBe(false);
  });

  it("exposes its virtual clock through now() and performance separately from real time", async () => {
    const scheduler = new Scheduler();
    const baseline = scheduler.now();
    scheduler.setTimeout(() => undefined, 120);
    await scheduler.drain();
    expect(scheduler.now() - baseline).toBe(120);
    expect(scheduler.virtualElapsedMs).toBe(120);
    expect(scheduler.timeOrigin).toBeLessThanOrEqual(baseline);
  });
});
