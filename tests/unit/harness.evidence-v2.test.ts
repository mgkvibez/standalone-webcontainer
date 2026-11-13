import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinition } from "../../src/harness/definition.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { createRefusal, type Refusal } from "../../src/runtime/refusal.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";
import { EVIDENCE_SCHEMA_VERSION, testProvenance } from "../helpers/provenance.js";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "evidence-v2-"));

const environment = (): AssertionEnvironment => ({
  readFile: async () => null,
  request: async () => {
    throw new Error("no requests expected");
  },
});

const refusal = (message: string): Refusal =>
  createRefusal({
    code: "native-addon",
    capability: "native addon",
    message,
    subject: "/app/node_modules/x/build/Release/x.node",
  });

function definition(assertions: FixtureDefinition["assertions"]): FixtureDefinition {
  return parseDefinition({
    formatVersion: 1,
    id: 15,
    slug: "fixture-15",
    lane: "boundary",
    title: "A native addon is refused cleanly, on purpose",
    intent: "Proves the refusal path is typed and fast.",
    source: "stackblitz-conformance: native addon, adapted",
    status: "proposed",
    steps: [{ kind: "run", command: "node require-native.mjs", timeoutClass: "run", purpose: "require the addon" }],
    assertions,
    expected: ["UNSUPPORTED_BY_DESIGN"],
  });
}

const record = (index: number) => ({ index, exitCode: 1, stdout: "", stderr: "Cannot load native addon\n" });

describe("evidence schema version", () => {
  it("records the schema version beside the files rather than inside them", async () => {
    const root = tempDir();
    await runFixture({
      definition: definition([{ kind: "exit-code", step: 0, equals: 1 }]),
      executeStep: async () => ({ termination: "ok", detail: "ran", record: record(0) }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });
    const schema = JSON.parse(readFileSync(join(root, "fixture-15", "schema.json"), "utf8"));
    // 4: the bundle gained provenance.json (W-27), which is a shape a consumer can observe changing — exactly what this number
    // exists to announce. 3 added the per-step HTTP observations; 4 adds how the run was executed.
    expect(schema.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(schema.lane).toBe("corpus");
    expect(readFileSync(join(root, "fixture-15", "verdict.txt"), "utf8")).toContain(`evidence schema: ${EVIDENCE_SCHEMA_VERSION}`);
  });

  it("keeps steps.json and assertions.json as bare arrays, so existing consumers keep working", async () => {
    const root = tempDir();
    await runFixture({
      definition: definition([{ kind: "exit-code", step: 0, equals: 1 }]),
      executeStep: async () => ({ termination: "ok", detail: "ran", record: record(0) }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });
    const steps = JSON.parse(readFileSync(join(root, "fixture-15", "steps.json"), "utf8"));
    const assertions = JSON.parse(readFileSync(join(root, "fixture-15", "assertions.json"), "utf8"));
    expect(Array.isArray(steps)).toBe(true);
    expect(Array.isArray(assertions)).toBe(true);
    // The retained legacy field is still present on every assertion, and still a boolean.
    expect(typeof assertions[0].passed).toBe("boolean");
    expect(assertions[0].state).toBe("passed");
  });

  it("writes no refusals.json when nothing was refused", async () => {
    const root = tempDir();
    const report = await runFixture({
      definition: definition([{ kind: "exit-code", step: 0, equals: 1 }]),
      executeStep: async () => ({ termination: "ok", detail: "ran", record: record(0) }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });
    // Exit 1 satisfies the assertion, so the run is a PASS and the definition expected a refusal: a bad baseline.
    expect(report.classification).toBe("INVALID_BASELINE");
    expect(() => readFileSync(join(root, "fixture-15", "refusals.json"), "utf8")).toThrow();
  });

  it("writes refusals.json from the same captured object that steps.json reports", async () => {
    const root = tempDir();
    const captured = refusal("Cannot load native addon: native addons are not supported in this runtime.");
    const report = await runFixture({
      definition: definition([{ kind: "exit-code", step: 0, equals: 1 }]),
      executeStep: async () => ({
        termination: "unsupported",
        detail: "refused",
        record: record(0),
        refusal: captured,
      }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });

    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    const refusals = JSON.parse(readFileSync(join(root, "fixture-15", "refusals.json"), "utf8"));
    const steps = JSON.parse(readFileSync(join(root, "fixture-15", "steps.json"), "utf8"));
    expect(refusals.stepIndex).toBe(0);
    expect(refusals.refusal).toEqual(steps[0].refusal);
    expect(refusals.refusal).toEqual(captured);
    expect(readFileSync(join(root, "fixture-15", "verdict.txt"), "utf8")).toContain("refusal: native-addon (native addon)");
  });

  it("preserves the diagnostic byte for byte, including whitespace a normalizer would eat", async () => {
    const root = tempDir();
    const awkward = "  Cannot load native addon:\ttabs, unicode ✓, trailing space ";
    await runFixture({
      definition: definition([{ kind: "stderr-contains", step: 0, contains: "native addon" }]),
      executeStep: async () => ({
        termination: "unsupported",
        detail: "refused",
        record: record(0),
        refusal: refusal(awkward),
      }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });
    const refusals = JSON.parse(readFileSync(join(root, "fixture-15", "refusals.json"), "utf8"));
    expect(refusals.refusal.message).toBe(awkward);
    expect(refusals.refusal.message.length).toBe(awkward.length);
  });

  it("keeps the refusal frozen in the report, so a consumer cannot alter evidence before it is written", async () => {
    const root = tempDir();
    const report = await runFixture({
      definition: definition([{ kind: "exit-code", step: 0, equals: 1 }]),
      executeStep: async () => ({
        termination: "unsupported",
        detail: "refused",
        record: record(0),
        refusal: refusal("Cannot load native addon: native addons are not supported in this runtime."),
      }),
      environment: environment(),
      evidenceRoot: root,
      provenance: testProvenance(),
    });
    const carried = report.steps[0]?.refusal;
    expect(carried).toBeDefined();
    expect(Object.isFrozen(carried)).toBe(true);
    expect(() => {
      (carried as { message: string }).message = "rewritten";
    }).toThrow();
  });
});
