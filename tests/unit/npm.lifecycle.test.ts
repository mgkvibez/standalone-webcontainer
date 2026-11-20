/**
 * W-43 Phase 2: the lifecycle policy and its execution accounting.
 *
 * Default-deny is the contract these tests protect: a project that has not opted in runs nothing, and the report says
 * so per package rather than staying silent. Execution is proven through an injected executor, because this module
 * never spawns: the caller owns the process table.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIFECYCLE_LIMITS,
  orderForExecution,
  parseScriptForm,
  runLifecycleScripts,
  type LifecycleCandidate,
  type LifecycleExecutor,
} from "../../src/npm/lifecycle.js";
import { InstallError } from "../../src/npm/install.js";

const candidate = (overrides: Partial<LifecycleCandidate> & { name: string }): LifecycleCandidate => ({
  version: "1.0.0",
  directory: `/app/node_modules/${overrides.name}`,
  dependencies: [],
  scripts: { postinstall: "node build.js" },
  ...overrides,
});

const recording = (): { execute: LifecycleExecutor; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    execute: (argv) => {
      calls.push([...argv]);
      return Promise.resolve({ exitCode: 0 });
    },
  };
};

describe("W-43 lifecycle policy", () => {
  it("denies by default: nothing executes and every declared script is reported skipped", async () => {
    const runner = recording();
    const outcomes = await runLifecycleScripts({
      candidates: [candidate({ name: "native" })],
      policy: "deny",
      execute: runner.execute,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcomes).toEqual([
      expect.objectContaining({ name: "native", script: "postinstall", state: "skipped-policy", exitCode: null }),
    ]);
  });

  it("runs a supported script when the project opted in, and captures its output", async () => {
    const outcomes = await runLifecycleScripts({
      candidates: [candidate({ name: "builder" })],
      policy: "allow",
      execute: (_argv, options) => {
        options.onOutput("built\n");
        return Promise.resolve({ exitCode: 0 });
      },
    });
    expect(outcomes[0]).toMatchObject({ state: "ran", exitCode: 0, output: "built\n", truncated: false });
  });

  it("refuses a script that needs a shell instead of pretending to run it", async () => {
    const runner = recording();
    const outcomes = await runLifecycleScripts({
      candidates: [candidate({ name: "shellish", scripts: { postinstall: "node build.js && true" } })],
      policy: "allow",
      execute: runner.execute,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcomes[0]).toMatchObject({ state: "skipped-unsupported" });
  });

  it("refuses an unsupported binary, naming it", async () => {
    const runner = recording();
    const outcomes = await runLifecycleScripts({
      candidates: [candidate({ name: "gyp", scripts: { install: "node-gyp rebuild" } })],
      policy: "allow",
      execute: runner.execute,
    });
    expect(runner.calls).toHaveLength(0);
    expect(outcomes[0]).toMatchObject({ state: "skipped-unsupported", command: "node-gyp rebuild" });
  });

  it("fails the install when an enabled script exits non-zero", async () => {
    await expect(
      runLifecycleScripts({
        candidates: [candidate({ name: "broken" })],
        policy: "allow",
        execute: () => Promise.resolve({ exitCode: 3 }),
      }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_FAILED" });
  });

  it("fails the install when an enabled script exceeds its timeout, even if the executor ignores the signal", async () => {
    await expect(
      runLifecycleScripts({
        candidates: [candidate({ name: "hang" })],
        policy: "allow",
        limits: { scriptTimeoutMs: 20 },
        execute: () => new Promise(() => undefined),
      }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_TIMEOUT" });
  });

  it("truncates output at the cap and says so rather than losing the fact", async () => {
    const outcomes = await runLifecycleScripts({
      candidates: [candidate({ name: "loud" })],
      policy: "allow",
      limits: { outputBytes: 8 },
      execute: (_argv, options) => {
        options.onOutput("0123456789");
        return Promise.resolve({ exitCode: 0 });
      },
    });
    expect(outcomes[0]).toMatchObject({ state: "output-truncated", truncated: true, output: "01234567" });
  });

  it("refuses allow with nowhere to run instead of reporting success", async () => {
    await expect(
      runLifecycleScripts({ candidates: [candidate({ name: "orphan" })], policy: "allow" }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_NO_EXECUTOR" });
  });

  it("orders dependencies before dependents, deterministically", () => {
    const ordered = orderForExecution([
      candidate({ name: "app", dependencies: ["mid"] }),
      candidate({ name: "mid", dependencies: ["leaf"] }),
      candidate({ name: "leaf" }),
    ]);
    expect(ordered.map((entry) => entry.name)).toEqual(["leaf", "mid", "app"]);
  });

  it("is deterministic across repeated runs", async () => {
    const request = {
      candidates: [candidate({ name: "b" }), candidate({ name: "a" })],
      policy: "allow" as const,
      execute: () => Promise.resolve({ exitCode: 0 }),
    };
    const first = await runLifecycleScripts(request);
    const second = await runLifecycleScripts(request);
    // Durations are wall clock and vary with machine load; everything that decides an outcome must not.
    const projection = (outcomes: readonly { name: string; script: string; state: string; exitCode: number | null; command: string }[]) =>
      outcomes.map(({ name, script, state, exitCode, command }) => ({ name, script, state, exitCode, command }));
    expect(projection(first)).toEqual(projection(second));
  });

  it("parses quoting as argument separation, not as shell syntax", () => {
    expect(parseScriptForm('node "a b.js" --flag')).toEqual({ argv: ["node", "a b.js", "--flag"] });
    expect(parseScriptForm("npx tsc -p .")).toEqual({ argv: ["npx", "tsc", "-p", "."] });
    expect(parseScriptForm("node x.js | tee log")).toHaveProperty("reason");
  });

  it("carries the typed code so a caller can tell refusal from failure", () => {
    expect(new InstallError("LIFECYCLE_FAILED", "x")).toMatchObject({ code: "LIFECYCLE_FAILED" });
    expect(DEFAULT_LIFECYCLE_LIMITS.scriptTimeoutMs).toBe(30_000);
  });
});
