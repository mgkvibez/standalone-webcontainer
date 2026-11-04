/**
 * Assertion evaluation and the runner's verdict logic.
 *
 * The interesting cases are the ones where something other than "it worked" happens: a fault that must not be
 * reported as a runtime failure, a timeout that must stop the run rather than be retried, and an outcome the fixture
 * never declared, which is a bad fixture rather than a bad runtime.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateAssertion, ProbeFault, type AssertionEnvironment, type StepRecord } from "../../src/harness/assertions.js";
import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { decideVerdict, runFixture, type StepRun } from "../../src/harness/runner.js";
import type { Refusal } from "../../src/runtime/refusal.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "swc-runner-"));
  created.push(dir);
  return dir;
}

function record(overrides: Partial<StepRecord> = {}): StepRecord {
  return { index: 0, exitCode: 0, stdout: "", stderr: "", ...overrides };
}

/** An environment that answers from literal maps, so each test states only the facts it cares about. */
function environment(
  options: {
    readonly files?: Record<string, string>;
    readonly responses?: Record<string, { status: number; body: string }>;
    readonly readError?: string;
    readonly requestError?: Error;
  } = {},
): AssertionEnvironment {
  return {
    readFile: async (path) => {
      if (options.readError !== undefined) throw new Error(options.readError);
      return options.files?.[path] ?? null;
    },
    request: async (url) => {
      if (options.requestError !== undefined) throw options.requestError;
      const response = options.responses?.[url];
      if (response === undefined) throw new Error(`unexpected request to ${url}`);
      return response;
    },
  };
}

function definition(overrides: Record<string, unknown> = {}): FixtureDefinition {
  return parseDefinition({
    formatVersion: 1,
    id: 1,
    slug: "fixture-01",
    lane: "front-end-only",
    title: "Vite dev server boots",
    intent: "Proves the shortest useful path end to end.",
    source: "stackblitz-conformance: Vite, adapted",
    status: "proposed",
    steps: [{ kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the toolchain" }],
    assertions: [{ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }],
    expected: ["PASS"],
    ...overrides,
  });
}

describe("evaluateAssertion", () => {
  it("compares exit codes, including the non-zero codes fixtures expect on purpose", async () => {
    const env = environment();
    const nonZero = { kind: "exit-code" as const, step: 0, equals: 3 };

    const pass = await evaluateAssertion(nonZero, 0, [record({ exitCode: 3 })], env);
    expect(pass.passed).toBe(true);
    expect(pass.detail).toBe("expected exit code 3, observed 3");

    const fail = await evaluateAssertion(nonZero, 1, [record({ exitCode: 0 })], env);
    expect(fail.passed).toBe(false);
    expect(fail.detail).toBe("expected exit code 3, observed 0");
  });

  it("normalizes line endings before comparing, because a Windows run is still a real run", async () => {
    const assertion = { kind: "stdout-contains" as const, step: 0, contains: "server ready\nlistening on 3000" };
    const result = await evaluateAssertion(assertion, 0, [record({ stdout: "server ready\r\nlistening on 3000\r\n" })], environment());
    expect(result.passed).toBe(true);
  });

  it("keeps line order, so a multi-line match is not defeated by line sorting", async () => {
    // Sorting lines would reorder these and break a contiguous match; normalization must not do that.
    const assertion = { kind: "stdout-contains" as const, step: 0, contains: "alpha\nbeta" };
    const result = await evaluateAssertion(assertion, 0, [record({ stdout: "alpha\nbeta\ngamma\n" })], environment());
    expect(result.passed).toBe(true);
  });

  it("reports a stream mismatch with both sides, truncated so a huge log stays readable", async () => {
    const assertion = { kind: "stderr-contains" as const, step: 0, contains: "EADDRINUSE" };
    const result = await evaluateAssertion(assertion, 0, [record({ stderr: "x".repeat(500) })], environment());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("did not contain");
    expect(result.detail.length).toBeLessThan(400);
  });

  it("fails an assertion whose step never ran, instead of blaming the runtime", async () => {
    const result = await evaluateAssertion({ kind: "exit-code", step: 2, equals: 0 }, 0, [], environment());
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("step 2 did not run, so exit-code cannot be checked");
  });

  it("distinguishes a missing file from an unreadable one", async () => {
    const assertion = { kind: "file-contains" as const, step: 0, target: "dist/index.html", contains: "<div id=\"root\">" };

    const missing = await evaluateAssertion(assertion, 0, [], environment());
    expect(missing.passed).toBe(false);
    expect(missing.detail).toContain("does not exist");

    const unreadable = environment({ readError: "EACCES" });
    await expect(evaluateAssertion(assertion, 0, [], unreadable)).rejects.toBeInstanceOf(ProbeFault);
  });

  it("evaluates file existence and contents", async () => {
    const env = environment({ files: { "dist/index.html": "<div id=\"root\"></div>" } });

    const exists = await evaluateAssertion({ kind: "file-exists", step: 0, target: "dist/index.html" }, 0, [], env);
    expect(exists.passed).toBe(true);

    const contains = await evaluateAssertion(
      { kind: "file-contains", step: 0, target: "dist/index.html", contains: "<div id=\"root\">" },
      0,
      [],
      env,
    );
    expect(contains.passed).toBe(true);

    const absent = await evaluateAssertion({ kind: "file-exists", step: 0, target: "dist/missing.js" }, 0, [], env);
    expect(absent.passed).toBe(false);
  });

  it("checks http status and body", async () => {
    const env = environment({ responses: { "http://localhost:3000/": { status: 200, body: "<div id=\"root\">" } } });

    const status = await evaluateAssertion({ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }, 0, [], env);
    expect(status.passed).toBe(true);

    const mismatch = await evaluateAssertion({ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 404 }, 0, [], env);
    expect(mismatch.passed).toBe(false);
    expect(mismatch.detail).toBe("expected status 404 from http://localhost:3000/, observed 200");

    const body = await evaluateAssertion(
      { kind: "http-body-contains", step: 0, target: "http://localhost:3000/", contains: "<div id=\"root\">" },
      0,
      [],
      env,
    );
    expect(body.passed).toBe(true);
  });

  it("turns an uncatchable-looking transport error into NETWORK, and passes an adapter's own verdict through", async () => {
    const plain = environment({ requestError: new Error("ECONNREFUSED") });
    await expect(
      evaluateAssertion({ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }, 0, [], plain),
    ).rejects.toMatchObject({ classification: "NETWORK" });

    // The adapter is the only layer that can tell a preview proxy miss from a real network failure.
    const harness = environment({ requestError: new ProbeFault("HARNESS_BUG", "no route for preview port 3000") });
    await expect(
      evaluateAssertion({ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }, 0, [], harness),
    ).rejects.toMatchObject({ classification: "HARNESS_BUG" });
  });

  it("refuses to guess when a definition's expected value is not numeric", async () => {
    await expect(
      evaluateAssertion({ kind: "exit-code", step: 0, equals: "zero" }, 0, [record()], environment()),
    ).rejects.toMatchObject({ classification: "HARNESS_BUG" });
  });
});

function refusalEvidence(): Refusal {
  return {
    code: "native-addon",
    capability: "native addon",
    message: "Cannot load native addon /app/x.node: native addons are not supported in this runtime.",
    subject: "/app/x.node",
  };
}

function stepRun(overrides: Partial<StepRun> = {}): StepRun {
  return {
    index: 0,
    kind: "install",
    command: "npm install",
    state: "ran",
    termination: "ok",
    detail: "installed",
    elapsedMs: 5,
    record: record(),
    ...overrides,
  };
}

describe("decideVerdict precedence", () => {
  const passed = {
    index: 0,
    kind: "exit-code" as const,
    state: "passed" as const,
    passed: true,
    stepAvailable: true,
    detail: "ok",
  };
  const failed = {
    index: 0,
    kind: "exit-code" as const,
    state: "failed" as const,
    passed: false,
    stepAvailable: true,
    detail: "expected exit code 0, observed 1",
  };

  it("prefers a timeout over anything that may also have gone wrong", () => {
    const verdict = decideVerdict([stepRun({ termination: "timeout", elapsedMs: 180000 })], [failed]);
    expect(verdict.classification).toBe("TIMEOUT");
    expect(verdict.reason).toContain("180000ms");
  });

  it("does not verify a refusal whose own evidence failed, because the bucket must be earned", () => {
    // This previously asserted the opposite: that a refusal outranked a failed assertion. ADR-0014 D-5 makes
    // classification atomic, so a refusal contradicted by its own evidence is a runtime failure, not a by-design result.
    const verdict = decideVerdict(
      [stepRun({ termination: "unsupported", detail: "native addon refused", refusal: refusalEvidence() })],
      [failed],
      ["UNSUPPORTED_BY_DESIGN"],
    );
    expect(verdict.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(verdict.reason).toContain("assertions-failed");
  });

  it("prefers a verified refusal over a step error, since the refusal is the finding", () => {
    const verdict = decideVerdict(
      [
        stepRun({ termination: "unsupported", detail: "native addon refused", refusal: refusalEvidence() }),
        { ...stepRun({ index: 1 }), termination: "error", detail: "TypeError: x is not a function" },
      ],
      [passed],
      ["UNSUPPORTED_BY_DESIGN"],
    );
    expect(verdict.classification).toBe("UNSUPPORTED_BY_DESIGN");
  });

  it("treats a refusal with no evidence as a runtime failure, never as a refusal by design", () => {
    const verdict = decideVerdict(
      [stepRun({ termination: "unsupported", detail: "refused" })],
      [passed],
      ["UNSUPPORTED_BY_DESIGN"],
    );
    expect(verdict.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(verdict.reason).toContain("malformed");
  });

  it("prefers a step error over a failed assertion", () => {
    const verdict = decideVerdict([stepRun({ termination: "error", detail: "TypeError: x is not a function" })], [failed]);
    expect(verdict.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(verdict.reason).toContain("TypeError");
  });

  it("counts the failures it did not name, so three problems do not look like one", () => {
    const verdict = decideVerdict([stepRun()], [failed, { ...failed, index: 1 }, { ...failed, index: 2 }]);
    expect(verdict.reason).toContain("and 2 more");
  });

  it("passes only when every assertion passed", () => {
    expect(decideVerdict([stepRun()], [passed]).classification).toBe("PASS");
  });
});

describe("runFixture", () => {
  it("runs the fixture, writes evidence, and produces a gate-ready outcome", async () => {
    const evidenceRoot = tempDir();
    const report = await runFixture({
      definition: definition(),
      executeStep: async () => ({ termination: "ok", detail: "installed", record: record({ stdout: "added 43 packages" }) }),
      environment: environment({ responses: { "http://localhost:3000/": { status: 200, body: "<div id=\"root\">" } } }),
      evidenceRoot,
    });

    expect(report.classification).toBe("PASS");
    expect(report.outcome?.fixture).toEqual({ id: 1, slug: "fixture-01", lane: "front-end-only" });
    expect(report.outcome?.classification).toBe("PASS");

    const verdictText = readFileSync(join(evidenceRoot, "fixture-01", "verdict.txt"), "utf8");
    expect(verdictText).toContain("classification: PASS");
    expect(JSON.parse(readFileSync(join(evidenceRoot, "fixture-01", "steps.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(evidenceRoot, "fixture-01", "assertions.json"), "utf8"))).toHaveLength(1);
  });

  it("stops at a slow step, does not run the rest, and evaluates nothing", async () => {
    const attempted: number[] = [];
    const report = await runFixture({
      definition: definition({
        steps: [
          { kind: "install", command: "npm install", timeoutClass: "install", purpose: "install" },
          { kind: "run", command: "npm run dev", timeoutClass: "run", purpose: "serve" },
        ],
      }),
      executeStep: async (_step, index) => {
        attempted.push(index);
        if (index === 0) return { termination: "ok", detail: "installed", record: record() };
        // Never resolves: the runner's budget, not the executor, must end the run.
        return new Promise(() => undefined);
      },
      environment: environment(),
      evidenceRoot: null,
      budgets: { install: 1000, build: 1000, run: 25 },
    });

    expect(attempted).toEqual([0, 1]);
    expect(report.classification).toBe("TIMEOUT");
    expect(report.steps).toHaveLength(2);
    expect(report.steps[1]?.termination).toBe("timeout");
    // ADR-0014 D-4: an assertion that could not be evaluated is recorded as not-evaluated, not dropped. Dropping it made
    // a truncated run indistinguishable from a fixture with nothing to check. Its earlier assertion (on the step that
    // did run) is also not evaluated, because a timeout keeps the older rule that nothing is checked once the run stops.
    expect(report.assertions).toHaveLength(1);
    expect(report.assertions[0]?.state).toBe("not-evaluated");
    expect(report.assertions[0]?.passed).toBe(false);
    expect(report.outcome).toBeNull();
  });

  it("classifies a designed refusal, which is how the native-addon fixture is meant to end", async () => {
    const report = await runFixture({
      definition: definition({
        expected: ["UNSUPPORTED_BY_DESIGN"],
        assertions: [
          { kind: "exit-code", step: 0, equals: 1 },
          { kind: "stderr-contains", step: 0, contains: "native addon" },
        ],
      }),
      executeStep: async () => ({
        termination: "unsupported",
        detail: "native addon loading is disabled",
        record: record({
          exitCode: 1,
          stderr: "Cannot load native addon /app/x.node: native addons are not supported in this runtime.\n",
        }),
        refusal: refusalEvidence(),
      }),
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    // The point of the fixture: its evidence was actually checked, not skipped.
    expect(report.assertions.map((assertion) => assertion.state)).toEqual(["passed", "passed"]);
    expect(report.reason).toContain("native-addon");
  });

  it("holds back a surprise PASS, because a fixture that cannot pass passing is a bad baseline", async () => {
    // Counting it would let a broken fixture inflate the rate, so the number cannot be believed either way.
    const surprisePass = await runFixture({
      definition: definition({ expected: ["UNSUPPORTED_BY_DESIGN"] }),
      executeStep: async () => ({ termination: "ok", detail: "installed", record: record() }),
      environment: environment({ responses: { "http://localhost:3000/": { status: 200, body: "<div id=\"root\">" } } }),
      evidenceRoot: null,
    });
    expect(surprisePass.classification).toBe("INVALID_BASELINE");
    expect(surprisePass.reason).toContain("observed PASS");
    expect(surprisePass.reason).toContain("expects only UNSUPPORTED_BY_DESIGN");
  });

  it("never relabels a failure or a fault as a bad baseline", async () => {
    // A fixture declaring only PASS is expected to pass, but a timeout is still a timeout: calling it INVALID_BASELINE
    // would hide what actually happened and blame the fixture for the runtime's or the harness's behaviour.
    const report = await runFixture({
      definition: definition({
        expected: ["UNSUPPORTED_BY_DESIGN"],
        assertions: [{ kind: "exit-code", step: 0, equals: 1 }],
      }),
      executeStep: async () => ({
        termination: "unsupported",
        detail: "refused",
        record: record({ exitCode: 1, stderr: "native addon refused\n" }),
        refusal: refusalEvidence(),
      }),
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.reason).not.toContain("INVALID_BASELINE");
  });

  it("reports a harness fault as itself, not as a runtime failure", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async () => ({ termination: "ok", detail: "installed", record: record() }),
      environment: environment({ requestError: new ProbeFault("HARNESS_BUG", "preview route never reached the gateway") }),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("HARNESS_BUG");
    expect(report.reason).toContain("preview route");
  });

  it("classifies an unreachable preview as NETWORK", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async () => ({ termination: "ok", detail: "installed", record: record() }),
      environment: environment({ requestError: new Error("ECONNREFUSED") }),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("NETWORK");
  });

  it("runs without evidence when no root is given, so outcomes cannot exist without them", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async () => ({ termination: "ok", detail: "installed", record: record() }),
      environment: environment({ responses: { "http://localhost:3000/": { status: 200, body: "<div id=\"root\">" } } }),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("PASS");
    expect(report.outcome).toBeNull();
  });
});
