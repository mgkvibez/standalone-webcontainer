/**
 * The fifteen regression tests ADR-0014 requires (T1-T15), in the ADR's order.
 *
 * Written as a contract: each names the rule it defends. The atomicity cases deliberately construct situations where a
 * lazier implementation would return UNSUPPORTED_BY_DESIGN, so a regression shows up as a wrong bucket, not just a
 * failing string comparison.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { assertionState, decideVerdict, runFixture, type StepRun } from "../../src/harness/runner.js";
import type { AssertionEnvironment, AssertionResult, StepRecord } from "../../src/harness/assertions.js";
import { GATE_THRESHOLD } from "../../src/harness/score.js";
import { createRefusal, type Refusal } from "../../src/runtime/refusal.js";

const MESSAGE = "Cannot load native addon /app/node_modules/x/x.node: native addons are not supported in this runtime.";
const NATIVE_ADDON: Refusal = createRefusal({
  code: "native-addon",
  capability: "native addon",
  message: MESSAGE,
  subject: "/app/node_modules/x/x.node",
});

const environment = (): AssertionEnvironment => ({
  readFile: async () => null,
  request: async () => {
    throw new Error("no requests expected");
  },
});

const record = (index: number, overrides: Partial<StepRecord> = {}): StepRecord => ({
  index,
  exitCode: 1,
  stdout: "",
  stderr: `${MESSAGE}\n`,
  ...overrides,
});

const STEPS: FixtureDefinition["steps"] = [
  { kind: "install", command: "npm install", timeoutClass: "install", purpose: "install the toolchain" },
  { kind: "run", command: "node require-native.mjs", timeoutClass: "run", purpose: "require the native addon" },
  { kind: "run", command: "node report.mjs", timeoutClass: "run", purpose: "report after the refusal" },
];

function definition(overrides: Record<string, unknown> = {}): FixtureDefinition {
  return parseDefinition({
    formatVersion: 1,
    id: 15,
    slug: "fixture-15",
    lane: "boundary",
    title: "A native addon is refused cleanly, on purpose",
    intent: "Proves the refusal path is typed and fast.",
    source: "stackblitz-conformance: native addon, adapted",
    status: "proposed",
    steps: STEPS,
    assertions: [
      { kind: "exit-code", step: 1, equals: 1 },
      { kind: "stderr-contains", step: 1, contains: "native addon" },
    ],
    expected: ["UNSUPPORTED_BY_DESIGN"],
    ...overrides,
  });
}

/** Step 0 installs, step 1 refuses, step 2 therefore never runs. */
async function refuse(options: {
  definition?: FixtureDefinition;
  refusal?: unknown;
  record?: StepRecord;
  evidenceRoot?: string | null;
} = {}) {
  return runFixture({
    definition: options.definition ?? definition(),
    executeStep: async (_step, index) => {
      if (index === 0) return { termination: "ok", detail: "installed", record: record(0, { exitCode: 0, stderr: "" }) };
      return {
        termination: "unsupported",
        detail: "refused the native addon",
        record: options.record ?? record(1),
        refusal: (options.refusal ?? NATIVE_ADDON) as Refusal,
      };
    },
    environment: environment(),
    evidenceRoot: options.evidenceRoot ?? null,
  });
}

describe("T1 a correct native-addon refusal is verified", () => {
  it("classifies as UNSUPPORTED_BY_DESIGN and evaluates the refusal assertions", async () => {
    const root = mkdtempSync(join(tmpdir(), "refusal-t1-"));
    const report = await refuse({ evidenceRoot: root });

    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.reason).toContain("native-addon");
    expect(report.assertions.map((assertion) => assertion.state)).toEqual(["passed", "passed"]);
    expect(report.assertions.every((assertion) => assertion.stepAvailable)).toBe(true);
    expect(readFileSync(join(root, "fixture-15", "refusals.json"), "utf8")).toContain("native-addon");
  });
});

describe("T2 a refusal with no code is malformed", () => {
  it("reports RUNTIME_INCOMPATIBILITY naming the missing field", async () => {
    const report = await refuse({
      refusal: createRefusal({ code: "" as never, capability: "native addon", message: "m", subject: "s" }),
    });
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("malformed");
    expect(report.reason).toContain("code");
  });
});

describe("T3 atomicity: malformedness beats passing assertions", () => {
  it("rejects a refusal with an empty message even though every assertion passed", async () => {
    const report = await refuse({
      refusal: createRefusal({ code: "native-addon", capability: "native addon", message: "", subject: "/app/x.node" }),
    });
    expect(report.assertions.every((assertion) => assertion.state === "passed")).toBe(true);
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("message");
  });
});

describe("T4 an undeclared refusal is a runtime failure", () => {
  it("reports RUNTIME_INCOMPATIBILITY when the definition never expected a refusal", async () => {
    const report = await refuse({ definition: definition({ expected: ["PASS"] }) });
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("undeclared");
  });
});

describe("T5 atomicity: the refusal's own evidence must hold", () => {
  it("rejects a well-formed, declared refusal whose exit-code assertion failed", async () => {
    const report = await refuse({ definition: definition({ assertions: [{ kind: "exit-code", step: 1, equals: 0 }] }) });
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("assertions-failed");
  });

  it("rejects a declared refusal whose stderr never mentioned the addon", async () => {
    const report = await refuse({ record: record(1, { stderr: "something else entirely\n" }) });
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("assertions-failed");
  });
});

describe("T6 dependent steps are skipped with an explicit reason", () => {
  it("records every later step as skipped, so a truncated run cannot look short", async () => {
    const report = await refuse();
    expect(report.steps).toHaveLength(3);
    expect(report.steps[2]?.state).toBe("skipped");
    expect(report.steps[2]?.termination).toBe("not-run");
    expect(report.steps[2]?.skipReason).toContain("step 1");
    expect(report.steps[2]?.skipReason).toContain("native-addon");
  });
});

describe("T7 assertions on skipped steps are visible and not satisfied", () => {
  it("reports not-evaluated, and the verified refusal still stands", async () => {
    const report = await refuse({
      definition: definition({
        assertions: [
          { kind: "exit-code", step: 1, equals: 1 },
          { kind: "exit-code", step: 2, equals: 0 },
        ],
      }),
    });
    const skippedAssertion = report.assertions[1];
    expect(skippedAssertion?.state).toBe("not-evaluated");
    expect(skippedAssertion?.passed).toBe(false);
    expect(skippedAssertion?.stepAvailable).toBe(false);
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
  });
});

describe("T8 not-evaluated is never counted as a pass", () => {
  it("maps state to passed in exactly one direction", () => {
    const base = { index: 0, kind: "exit-code" as const, detail: "d", stepAvailable: true };
    expect(assertionState({ ...base, state: "not-evaluated", passed: false })).toBe("not-evaluated");
    expect({ ...base, state: "not-evaluated" as const, passed: false }.passed).toBe(false);
    expect(assertionState({ ...base, state: "passed", passed: true })).toBe("passed");
  });

  it("does not turn a clean run into a failure", () => {
    const steps: StepRun[] = [
      {
        index: 0,
        kind: "install",
        command: "npm install",
        state: "ran",
        termination: "ok",
        detail: "installed",
        elapsedMs: 1,
        record: record(0, { exitCode: 0 }),
      },
    ];
    const assertions: AssertionResult[] = [
      { index: 0, kind: "exit-code", state: "not-evaluated", passed: false, stepAvailable: false, detail: "not run" },
    ];
    expect(decideVerdict(steps, assertions, ["PASS"]).classification).toBe("PASS");
  });
});

describe("T9 the diagnostic is preserved exactly", () => {
  it("keeps whitespace, tabs and unicode identical in both evidence files", async () => {
    const root = mkdtempSync(join(tmpdir(), "refusal-t9-"));
    const awkward = "  Cannot load native addon:\ttabs, unicode ✓, trailing space ";
    await refuse({
      evidenceRoot: root,
      refusal: createRefusal({
        code: "native-addon",
        capability: "native addon",
        message: awkward,
        subject: "/app/x.node",
      }),
      definition: definition({ assertions: [{ kind: "stderr-contains", step: 1, contains: "native addon" }] }),
    });
    const refusals = JSON.parse(readFileSync(join(root, "fixture-15", "refusals.json"), "utf8"));
    const steps = JSON.parse(readFileSync(join(root, "fixture-15", "steps.json"), "utf8"));
    expect(refusals.refusal.message).toBe(awkward);
    expect(steps[1].refusal.message).toBe(awkward);
    expect(refusals.refusal.message.length).toBe(awkward.length);
  });
});

describe("T10 both evidence files carry one capture", () => {
  it("writes refusals.json agreeing with steps.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "refusal-t10-"));
    await refuse({ evidenceRoot: root });
    const refusals = JSON.parse(readFileSync(join(root, "fixture-15", "refusals.json"), "utf8"));
    const steps = JSON.parse(readFileSync(join(root, "fixture-15", "steps.json"), "utf8"));
    expect(refusals.refusal).toEqual(steps[1].refusal);
    expect(refusals.stepIndex).toBe(1);
    expect(refusals.exitCode).toBe(1);
  });
});

describe("T11 an expected refusal that never happened", () => {
  it("is a bad baseline, never UNSUPPORTED_BY_DESIGN", async () => {
    const report = await runFixture({
      definition: definition({ assertions: [{ kind: "exit-code", step: 0, equals: 0 }] }),
      executeStep: async (_step, index) => ({
        termination: "ok",
        detail: "ran",
        record: record(index, { exitCode: 0, stderr: "" }),
      }),
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("INVALID_BASELINE");
  });
});

describe("T12 a refusal the program handled is not a refusal event", () => {
  it("stays an ordinary PASS with no refusal recorded", async () => {
    const report = await runFixture({
      definition: definition({
        expected: ["PASS"],
        assertions: [{ kind: "stdout-contains", step: 1, contains: "handled" }],
      }),
      executeStep: async (_step, index) => ({
        termination: "ok",
        detail: "ran",
        record: record(index, { exitCode: 0, stdout: index === 1 ? "handled\n" : "", stderr: "" }),
      }),
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("PASS");
    expect(report.steps[1]?.refusal).toBeUndefined();
  });
});

describe("T13 backward compatibility with schema v1", () => {
  it("reads a v1 assertion result, which carries no state", () => {
    const failedV1 = { index: 0, kind: "exit-code" as const, passed: false, detail: "v1" } as unknown as AssertionResult;
    const passedV1 = { index: 0, kind: "exit-code" as const, passed: true, detail: "v1" } as unknown as AssertionResult;
    // v1 had two outcomes, so `passed: false` meant failed. It must not silently drop out of the count.
    expect(assertionState(failedV1)).toBe("failed");
    expect(assertionState(passedV1)).toBe("passed");
  });

  it("keeps passed a derived boolean on every new result", async () => {
    const report = await refuse();
    for (const assertion of report.assertions) expect(typeof assertion.passed).toBe("boolean");
  });
});

describe("T14 the production consumer ignores not-evaluated", () => {
  it("does not fail a run whose unevaluated assertion sits on a skipped step", async () => {
    const report = await refuse({
      definition: definition({
        assertions: [
          { kind: "exit-code", step: 1, equals: 1 },
          { kind: "stdout-contains", step: 2, contains: "never" },
        ],
      }),
    });
    expect(report.assertions[1]?.state).toBe("not-evaluated");
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
  });
});

describe("T15 the guards: nothing was relaxed to make this work", () => {
  const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("leaves fixture 15 byte-identical to the commit before this work", () => {
    // Hashes verified against 429a019 by hand. Editing the fixture to fit the code is the dishonesty the charter forbids.
    expect(sha256("fixtures/definitions/fixture-15.json")).toBe(
      "98c336562b54fe93e4243cf87410f96f560634d39527e1256d07b949513ea025",
    );
  });

  it("leaves ADR-0009 byte-identical, so its ad-hoc spec refusal still stands", () => {
    expect(sha256("docs/decisions/ADR-0009.md")).toBe(
      "1f3233b612adfd4d9879062f031a4190a25b49125cfe963f5429e0c16b4b4b70",
    );
  });

  it("leaves the pre-registered gate threshold unchanged", () => {
    expect(GATE_THRESHOLD).toBe(0.9);
  });
});
