import { describe, expect, it } from "vitest";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

/**
 * W-41: the after-run record, and the one notification that carries it out of the runtime.
 *
 * ADR-0035 (W-40) decides that a failure arriving after the result was handed back cannot change the status, so it is
 * recorded on the runtime with `phase: "after-run"` instead. It deliberately stops there: whether a held-open process
 * should then be ended is the process layer's question. This file pins both halves of the seam that ADR-0035 left open.
 *
 * W-40's own file covers the in-run routes. The two cases here exist because nothing else exercises either of them:
 * `phase: "after-run"` appears nowhere in `tests/unit/runtime.async-failures.test.ts`, and `asyncFailures` has no
 * consumer in `src/`. A record nobody tests and nobody reads is indistinguishable from one that was never written.
 *
 * The end-to-end proof - that this notification actually moves a real process row to `failed` across a real Worker - is
 * `tests/browser/w41-after-run-failure.spec.ts`. This file is the unit-level half of the same claim.
 */

interface Observed {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly notifications: readonly { source: string; name: string; message: string }[];
  readonly records: readonly { phase: string; name: string; message: string }[];
}

async function runProgram(source: string): Promise<Observed> {
  const vfs = new FileSystem();
  vfs.writeFileSync("/main.js", source);
  const notifications: { source: string; name: string; message: string }[] = [];
  const runtime = new InProcessRuntime(vfs);
  let stdout = "";
  let stderr = "";
  const result = await runtime.run("/main.js", {
    timeoutMs: 2_000,
    onAfterRunFailure: (failure: { source: string; name: string; message: string }) => notifications.push(failure),
    onOutput: (stream, text) => {
      if (stream === "stdout") stdout += text;
      else stderr += text;
    },
  });
  // The pump is the only thing still turning once the body has settled. Driving it to a stop is what lets the scheduled
  // throw happen here, and is what a host does when the process it held open finally ends.
  await runtime.settleLiveWork();
  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
    notifications,
    records: runtime.asyncFailures.map((record) => ({ phase: record.phase, name: record.name, message: record.message })),
  };
}

const HELD_OPEN_THROWER = [
  'const http = require("http");',
  'http.createServer((request, response) => response.end("ok")).listen(3200);',
  // Far enough out that the run has handed back its result before this ever runs: the drain stops at the body's own
  // turn, and the resident pump is what reaches this.
  'setTimeout(() => { throw new Error("boom after settle"); }, 1200);',
].join("\n");

describe("W-41: a failure that arrives after the run has returned", () => {
  it("is recorded on the runtime with phase after-run, and published exactly once", async () => {
    const observed = await runProgram(HELD_OPEN_THROWER);

    // The record: the same failure W-40 would have put on the result, kept on the runtime because the result is gone.
    expect(observed.records).toHaveLength(1);
    expect(observed.records[0]).toMatchObject({ phase: "after-run", name: "Error" });
    expect(observed.records[0]?.message).toContain("boom after settle");

    // The delivery: one notification, carrying the program's own error, not a synthesised message.
    expect(observed.notifications).toHaveLength(1);
    expect(observed.notifications[0]?.message).toContain("boom after settle");
    expect(observed.notifications[0]?.source).toBe("timer");
  });

  it("is not silently discarded: the record and itsnotification agree, and stderr said it too", async () => {
    const observed = await runProgram(HELD_OPEN_THROWER);

    // Not discarded means observable on EVERY surface, and the same failure on each - a supervisor deciding from the
    // notification cannot disagree with a reader looking at the log or at the runtime's own record.
    expect(observed.stderr).toContain("Uncaught Error: boom after settle");
    expect(observed.notifications).toHaveLength(1);
    expect(observed.records).toHaveLength(1);
    expect(observed.notifications[0]?.message).toBe(observed.records[0]?.message);
  });

  it("leaves a held-open program that does not throw completely alone", async () => {
    const observed = await runProgram(
      [
        'const http = require("http");',
        'http.createServer((request, response) => response.end("ok")).listen(3201);',
        "setTimeout(() => console.log('tick'), 25);",
      ].join("\n"),
    );

    expect(observed.notifications).toEqual([]);
    expect(observed.records).toEqual([]);
    expect(observed.stderr).toBe("");
    expect(observed.exitCode).toBe(0);
    // Still doing its own work after the body settled, which is what a held-open process is for.
    expect(observed.stdout).toContain("tick");
  });

  it("does not publish an in-run failure, whose behaviour W-40 already owns and must not change", async () => {
    const observed = await runProgram('setTimeout(() => { throw new Error("boom during run"); }, 0);');

    // In-run: the throw is the run's own outcome, exactly as W-40 settled it.
    expect(observed.exitCode).toBe(1);
    expect(observed.stderr).toContain("Uncaught Error: boom during run");
    // And it is NOT an after-run event, so the lifecycle channel stays silent: one failure, reported once, by the reporter
    // that owns it.
    expect(observed.notifications).toEqual([]);
    expect(observed.records).toEqual([]);
  });
});
