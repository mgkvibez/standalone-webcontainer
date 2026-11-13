/**
 * Running real corpus definitions, not synthetic ones.
 *
 * This is the first place a fixture from `fixtures/definitions/` executes end to end: its own project files are staged,
 * its own commands run, its own assertions decide. Two outcomes matter equally here: the CLI fixture passing, and the
 * Node-core fixture failing for the reason we expect rather than passing by accident.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { isScoreable, parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { createStepExecutor } from "../../src/harness/execute.js";
import { materializeProject } from "../../src/harness/project.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createFakeRegistry } from "../helpers/registry.js";
import { testProvenance } from "../helpers/provenance.js";

const definitionsDir = fileURLToPath(new URL("../../fixtures/definitions/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "swc-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const loadDefinition = (slug: string): FixtureDefinition => {
  const raw: unknown = JSON.parse(readFileSync(join(definitionsDir, `${slug}.json`), "utf8"));
  return parseDefinition(raw, slug);
};

/** A staged fixture: fresh VFS, the definition's own files at the root, a runtime, and a no-network registry. */
const stage = async (definition: FixtureDefinition) => {
  const vfs = new FileSystem();
  const root = "/app";
  materializeProject(vfs, root, definition.files ?? {});
  const registry = await createFakeRegistry({ packages: {} });
  const environment: AssertionEnvironment = {
    readFile: async (path) => {
      try {
        const contents = vfs.readFileSync(path, "utf8");
        return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
      } catch {
        return null;
      }
    },
    request: async () => {
      throw new Error("this fixture makes no http assertions");
    },
  };
  const runtime = new InProcessRuntime(vfs);
  return { runtime, registry, environment, root };
};

describe("the corpus runs", () => {
  it("passes fixture 7: a CLI honours argv and its documented exit codes", async () => {
    const definition = loadDefinition("fixture-07");
    const { runtime, registry, environment, root } = await stage(definition);

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment,
      evidenceRoot: join(scratch, "fixture-07"),
      provenance: testProvenance(),
    });

    expect(report.reason).toBe("all 3 assertion(s) passed");
    expect(report.classification).toBe("PASS");
    // Evidence is written because a PASS without raw output is a claim, not a result (charter §4.8).
    expect(report.outcome?.evidenceDir).toContain("fixture-07");
  });

  it("passes fixture 4 once its project is staged: five core APIs behaving in one process", async () => {
    const definition = loadDefinition("fixture-04");
    const { runtime, registry, environment, root } = await stage(definition);

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment,
      evidenceRoot: join(scratch, "fixture-04"),
      provenance: testProvenance(),
    });

    expect(report.classification).toBe("PASS");
    expect(report.reason).toBe("all 6 assertion(s) passed");

    // Every assertion is reported individually, and each marker is checked separately so a regression names the API rather
    // than "the fixture broke". The timer and stream markers matter most: they are the two the R3 and R4 subsystems carry,
    // and a pass that only proved the imports would be worthless here.
    const step = report.steps[1];
    expect(step, "the run step is missing from the report").toBeDefined();
    const stdout = step?.record?.stdout ?? "";
    for (const marker of ["fs-ok", "http-ok", "stream-ok", "timer-ok", "events-ok"]) {
      expect(stdout, `missing marker ${marker}`).toContain(marker);
    }
    expect(step?.record?.exitCode).toBe(0);
    expect(step?.record?.stderr).toBe("");

    expect(report.assertions).toHaveLength(6);
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(report.outcome?.evidenceDir).toContain("fixture-04");
  });
});

/**
 * Fixture 10 stays out of the gate (Phase 6 R2, decision D-1).
 *
 * The pnpm profile is a command vocabulary, not pnpm's install engine, so a run of fixture 10 under it would assert on a tree we
 * built with npm semantics. D-1 therefore says the profile must never score it. That holds today for a structural reason —
 * `isScoreable` requires `status: "frozen"` and fixture 10 is `"proposed"` — which is exactly the kind of fact that disappears
 * quietly the day someone freezes the file. This pins it, and names what has to be decided first.
 */
describe("fixture 10 and the pnpm profile", () => {
  it("is not scoreable, because only a frozen definition may decide a gate outcome", () => {
    const fixture10 = loadDefinition("fixture-10");

    expect(fixture10.status).toBe("proposed");
    expect(isScoreable(fixture10)).toBe(false);
    // The reason it is unscored is the profile's limits, not an oversight: its first step is the pnpm install path.
    expect(fixture10.steps[0]?.command).toBe("pnpm install");
  });

  it("would have to be frozen deliberately, and D-1 says that decision belongs to a milestone that builds the store", () => {
    const fixture10 = loadDefinition("fixture-10");
    // Written as an assertion about the DECISION rather than the code: if someone later flips this to "frozen", the comment above
    // and this test are the two places that say why it needs a recorded decision first.
    expect(fixture10.expected).toEqual(["PASS", "NETWORK"]);
  });
});
