/**
 * Fixture 15, the one fixture that must NOT pass.
 *
 * Every other fixture in the corpus asks "can the runtime do this?". This one asks "can the runtime say no, and can the evidence
 * prove it said no on purpose?". Those are different measurements, and the difference is load-bearing: a runtime that silently
 * fails a native addon and a runtime that refuses one are indistinguishable from the outside, so the gate can only treat the
 * second as a design boundary if the refusal itself survives to the report.
 *
 * So the assertions here are deliberately about the SEAM rather than about the addon:
 *
 *   1. the definition on disk is the one the CLI runs, and it is a boundary fixture that expects to be refused;
 *   2. when it runs, the classification is `UNSUPPORTED_BY_DESIGN` and it comes from the carried refusal, not from stderr;
 *   3. the run stops, and the assertions after the refusal are `not-evaluated` rather than fabricated passes;
 *   4. the refusal reaches the evidence a reader opens, with the provenance that says which lane it came from;
 *   5. ordinary failures - a missing dependency, an exception, an unhandled rejection, an explicit non-zero exit, a runtime
 *      crash, and a program that merely PRINTS the words "native addon" - are not refusals;
 *   6. a refusal the program catches is an ordinary run;
 *   7. a by-design refusal is scored in the boundary lane and does not enter the front-end denominator.
 *
 * (5) is the one that mutation-testing defends. Delete the `outcome.refusal` check in `tools/harness/fixture-executor.ts` and the
 * refusal test goes red; replace it with a reading of stderr and the spoof test alone goes red, because a program that prints the
 * refusal's own sentence would then be classified as having been refused.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { MapFiles, readDefinitions, runDefinition } from "../../tools/harness/fixture-executor.js";
import { InProcessClient } from "../../tools/harness/in-process-client.js";
import { Container } from "../../src/container/container.js";
import { scoreGate } from "../../src/harness/score.js";
import type { FixtureOutcome } from "../../src/harness/types.js";
import { testProvenance } from "../helpers/provenance.js";

const scratch = mkdtempSync(join(tmpdir(), "swc-fixture-15-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The definition the CLI runs, read from disk: a test that restated it here could pass while the real fixture broke. */
const onDisk = (): FixtureDefinition => {
  const found = readDefinitions().find((definition) => definition.id === 15);
  if (found === undefined) throw new Error("fixture-15 is not in fixtures/definitions");
  return found;
};

/** A one-step definition with the same lane and expectations, for the negative controls. */
function control(files: Readonly<Record<string, string>>, expected: readonly string[] = ["PASS"]): FixtureDefinition {
  return parseDefinition({
    formatVersion: 1,
    id: 15,
    slug: "fixture-15",
    lane: "boundary",
    title: "negative control for fixture 15",
    intent: "prove an ordinary failure is not a design refusal",
    source: "tests/unit/harness.fixture-15.test.ts",
    status: "proposed",
    steps: [{ kind: "run", command: "node main.cjs", timeoutClass: "run", purpose: "the control's program" }],
    assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
    files: { "package.json": '{"name":"control","private":true}\n', ...files },
    expected: expected as never,
  });
}

const run = async (definition: FixtureDefinition, evidenceRoot: string | null = null) =>
  runDefinition(definition, undefined as never, evidenceRoot as never, testProvenance());

describe("fixture 15 on disk", () => {
  it("is a proposed boundary fixture whose only acceptable outcome is a refusal", () => {
    const definition = onDisk();

    // Boundary, not front-end: this fixture must never be counted in the fifteen-fixture rate the gate rests on.
    expect(definition.lane).toBe("boundary");
    // Exactly one acceptable classification, so a surprise PASS is caught as INVALID_BASELINE rather than rewarded.
    expect(definition.expected).toEqual(["UNSUPPORTED_BY_DESIGN"]);
    // Proposed, because freezing is the owner's act (ADR-0007) and this PR is not that act.
    expect(definition.status).toBe("proposed");
  });

  it("carries a project that really reaches for a native addon, and a step that must never run", () => {
    const definition = onDisk();
    const files = definition.files ?? {};

    // The package is shaped like a node-gyp package: a JavaScript main that requires its compiled binding.
    expect(files["native-binding/package.json"]).toContain('"main": "index.js"');
    expect(files["native-binding/index.js"]).toContain('require("./build/Release/addon.node")');
    // The binding exists, so the attempt is a load rather than a bad path, and it is a binary rather than a JavaScript file.
    expect(files["native-binding/build/Release/addon.node"]).toContain("ELF");

    // The program prints before it loads, so "the loader refused this" is distinguishable from "the program never started".
    expect(files["load-addon.mjs"]).toContain("loading native binding");

    // Two steps: the refusal, then something that would prove execution continued if it ever did.
    expect(definition.steps.map((step) => step.command)).toEqual(["node load-addon.mjs", "node after-refusal.mjs"]);
  });

  it("keeps the two assertions the definition was written with, and adds controls after them", () => {
    const definition = onDisk();
    const assertions = definition.assertions.map((assertion) => JSON.stringify(assertion));

    // The original pair, unchanged in intent: the refusing step exits non-zero and says which capability it refused.
    // (Both now name step 0 rather than step 1, because the `npm install sharp` step ADR-0009 refuses is gone - see ADR-0014 §14.)
    expect(assertions).toContain(JSON.stringify({ kind: "exit-code", step: 0, equals: 1 }));
    expect(assertions).toContain(JSON.stringify({ kind: "stderr-contains", step: 0, contains: "native addon" }));

    // The controls: the marker that proves the program started, and three assertions after the refusal that must read
    // `not-evaluated` rather than pass.
    expect(assertions).toContain(JSON.stringify({ kind: "stdout-contains", step: 0, contains: "loading native binding" }));
    expect(definition.assertions.filter((assertion) => "step" in assertion && assertion.step === 1)).toHaveLength(3);
    expect(definition.assertions).toContainEqual({ kind: "file-exists", step: 1, target: "/after-refusal-ran.txt" });
  });
});

describe("fixture 15 through the harness", () => {
  it("is classified UNSUPPORTED_BY_DESIGN from the carried refusal, and keeps the refusing step's own evidence", async () => {
    const report = await run(onDisk());

    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    // Not HARNESS_BUG, not RUNTIME_INCOMPATIBILITY: a boundary we chose must not read as a defect to be fixed.
    expect(report.classification).not.toBe("HARNESS_BUG");
    expect(report.classification).not.toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("native addon");

    const refusing = report.steps[0];
    expect(refusing?.termination).toBe("unsupported");

    // The refusal itself, by value, and frozen: this is the object the classification was earned from (D-6, D-10).
    const refusal = refusing?.refusal;
    expect(refusal).toBeDefined();
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(refusal?.code).toBe("native-addon");
    expect(refusal?.capability).toBe("native addon");
    expect(refusal?.subject).toBe("/native-binding/build/Release/addon.node");
    expect(refusal?.message).toContain("native addons are not supported in this runtime");

    // The refusing step still has its record (D-2): its exit status and its output are evidence, not collateral.
    expect(refusing?.record?.exitCode).toBe(1);
    expect(refusing?.record?.stdout).toContain("loading native binding");
  });

  it("stops at the refusal, and every assertion after it is not-evaluated rather than a fabricated pass", async () => {
    const report = await run(onDisk());

    // The later step is recorded as skipped with a reason that names the refusal, not omitted (D-3).
    const skipped = report.steps[1];
    expect(report.steps).toHaveLength(2);
    expect(skipped?.state).toBe("skipped");
    expect(skipped?.termination).toBe("not-run");
    expect(skipped?.skipReason).toContain("native-addon");
    expect(await Promise.resolve(skipped?.record)).toBeNull();

    // Results are in definition order and carry no step index of their own, so the split is positional: the assertion list
    // names step 0 for the first three and step 1 for the rest.
    const states = report.assertions.map((assertion) => assertion.state);
    expect(states).toEqual([
      "passed", // stdout marker: the program started and reached the load
      "passed", // exit code 1
      "passed", // stderr names the capability
      "not-evaluated", // the later step's stdout
      "not-evaluated", // the later step's exit code
      "not-evaluated", // the file the later step would have written
    ]);

    // `passed: false` is also what `not-evaluated` reports (the schema's permanent asymmetry), so the state is the answer and
    // nothing here may be read as "checked and failed".
    for (const assertion of report.assertions.slice(3)) expect(assertion.passed).toBe(false);

    // Nothing after the refusal was fabricated into a pass, and nothing was fabricated into a failure either.
    expect(report.assertions.filter((assertion) => assertion.state === "failed")).toHaveLength(0);
  });

  it("writes the refusal and its provenance into the evidence a reader opens", async () => {
    const report = await run(onDisk(), scratch);
    const dir = join(scratch, "fixture-15");

    const verdict = readFileSync(join(dir, "verdict.txt"), "utf8");
    expect(verdict).toContain("classification: UNSUPPORTED_BY_DESIGN");
    expect(verdict).toContain("refusal: native-addon (native addon)");
    // The verdict names what did not happen, so a truncated run is not mistaken for a short one.
    expect(verdict).toMatch(/1 later step skipped/);
    expect(verdict).toMatch(/not evaluated/);

    const steps = JSON.parse(readFileSync(join(dir, "steps.json"), "utf8")) as {
      termination: string;
      refusal?: { code: string; subject: string };
    }[];
    expect(steps[0]?.termination).toBe("unsupported");
    expect(steps[0]?.refusal?.code).toBe("native-addon");
    expect(steps[1]?.termination).toBe("not-run");

    // refusals.json is the machine-readable copy, and it is the SAME object the report carried (D-11).
    const refusals = JSON.parse(readFileSync(join(dir, "refusals.json"), "utf8")) as {
      stepIndex: number;
      exitCode: number;
      refusal: { code: string; capability: string; message: string; subject: string };
    };
    expect(refusals.stepIndex).toBe(0);
    expect(refusals.exitCode).toBe(1);
    expect(refusals.refusal).toEqual(report.steps[0]?.refusal);

    const provenance = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) as {
      fixture: { id: number; lane: string };
      definition: { sha256: string };
      registry: { lane: string };
    };
    // The evidence says which lane wrote it (W-27), which is what makes a wrong-lane run impossible to misfile.
    expect(provenance.fixture).toEqual({ id: 15, slug: "fixture-15", lane: "boundary" });
    expect(provenance.registry.lane).toBe("corpus");
    expect(provenance.definition.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fixture 15's negative controls: an ordinary failure is not a design refusal", () => {
  it("does not classify a missing dependency as a refusal", async () => {
    const report = await run(control({ "main.cjs": 'require("a-package-nobody-installed");\n' }));

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.steps[0]?.termination).not.toBe("unsupported");
    expect(report.steps[0]?.refusal).toBeUndefined();
  });

  it("does not classify an exception as a refusal", async () => {
    const report = await run(control({ "main.cjs": 'throw new Error("boom");\n' }));

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.steps[0]?.refusal).toBeUndefined();
  });

  it("does not classify an unhandled rejection as a refusal", async () => {
    const report = await run(control({ "main.cjs": 'Promise.reject(new Error("rejected"));\n' }));

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.steps[0]?.refusal).toBeUndefined();
  });

  it("does not classify an explicit non-zero exit as a refusal, even when the fixture is satisfied by it", async () => {
    const definition = parseDefinition({
      ...(JSON.parse(JSON.stringify(control({ "main.cjs": "process.exit(3);\n" }))) as object),
      assertions: [{ kind: "exit-code", step: 0, equals: 3 }],
    } as never);
    const report = await run(definition);

    // The status is 3 and the fixture is happy: a PASS on a non-zero exit, and still not a refusal.
    expect(report.classification).toBe("PASS");
    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.refusal).toBeUndefined();
    expect(report.steps[0]?.record?.exitCode).toBe(3);
  });

  it("does not classify a program that merely PRINTS the refusal's sentence as a refusal", async () => {
    // The spoof. Text that reads like a refusal, written by a program the runtime never refused, must stay an ordinary run -
    // this is the test that fails if classification is ever derived from stderr rather than from the carried refusal.
    const report = await run(
      control({
        "main.cjs":
          'console.error("ProcessRefusal: Cannot load native addon /x.node: native addons are not supported in this runtime.");\nprocess.exit(1);\n',
      }),
    );

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.refusal).toBeUndefined();
  });

  it("does not classify a caught refusal as a refusal", async () => {
    // `ProcessRefusal` is catchable by design: a package that falls back to a pure-JS path has not been refused by anyone.
    const report = await run(
      control({
        "main.cjs":
          // A package that catches its refusal and falls back has not been refused by anyone: the runtime declined one load.
          'try { require("./addon.node"); } catch (error) { console.log("handled", error.refusal?.code ?? error.name); }\n',
        "addon.node": "ELF\u0002\u0001\u0001\u0000placeholder\u0000",
      }),
    );

    expect(report.classification).toBe("PASS");
    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.refusal).toBeUndefined();
    expect(report.steps[0]?.record?.stdout).toContain("handled native-addon");
  });

  it("does not classify a runtime crash as a refusal", async () => {
    // A crash is our layer falling over, not a boundary the runtime chose. Asserted at the seam the adapter actually reads:
    // `outcome.refusal` is what makes a step `unsupported`, so a runtime whose run throws must leave it undefined even though
    // the process ends failed with a non-zero status - exactly the shape that would be mistaken for a refusal by status alone.
    class CrashingClient extends InProcessClient {
      override async run(): Promise<never> {
        throw new TypeError("the runtime fell over");
      }
    }

    const files = new MapFiles({ "package.json": '{"name":"crash","private":true}\n', "main.cjs": "console.log(1);\n" });
    const container = new Container({ runtime: new CrashingClient(), files, registry: undefined as never });
    const session = container.createSession("fixture");
    const outcome = await container.execute(session.id, "node main.cjs");

    expect(outcome.refusal).toBeUndefined();
    expect(container.processes().at(-1)?.state).toBe("failed");
  });
});

describe("fixture 15 in the gate", () => {
  const outcomeFor = (id: number, classification: FixtureOutcome["classification"], expected: string[]): FixtureOutcome => ({
    fixture: {
      id,
      slug: `fixture-${String(id).padStart(2, "0")}`,
      lane: id === 15 ? "boundary" : "front-end-only",
    },
    classification,
    evidenceDir: "/evidence",
    expected: expected as never,
  });

  it("is satisfied by a by-design refusal, and is not counted as passed", async () => {
    const report = await run(onDisk());
    const outcome = outcomeFor(15, report.classification, ["UNSUPPORTED_BY_DESIGN"]);
    const gate = scoreGate([outcome]);

    // In the boundary lane, doing exactly what it declared.
    expect(gate.boundary.scored).toBe(1);
    expect(gate.boundary.satisfied).toBe(1);
    expect(gate.boundary.satisfiedRate).toBe(1);
    // And NOT a pass: the one fixture that must not pass cannot inflate a rate.
    expect(gate.boundary.passed).toBe(0);
    expect(gate.boundary.rate).toBe(0);
  });

  it("does not enter the front-end denominator", () => {
    const gate = scoreGate([outcomeFor(15, "UNSUPPORTED_BY_DESIGN", ["UNSUPPORTED_BY_DESIGN"])]);

    expect(gate.frontEndOnly.scored).toBe(0);
    expect(gate.frontEndOnly.satisfied).toBe(0);
    // Every one of the fifteen is still missing, so the gate is still unmet: a boundary result buys no front-end credit.
    expect(gate.missing).toHaveLength(15);
    expect(gate.gateMet).toBe(false);
  });

  it("counts a boundary fixture that refused when it should have passed as unsatisfied", () => {
    // The honest reading of a surprise: `fixture-15` classifying as PASS is not "satisfied", even though it is "passed".
    const gate = scoreGate([outcomeFor(15, "PASS", ["UNSUPPORTED_BY_DESIGN"])]);

    expect(gate.boundary.passed).toBe(1);
    expect(gate.boundary.satisfied).toBe(0);
  });
});
