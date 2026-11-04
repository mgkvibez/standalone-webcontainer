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

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { createStepExecutor } from "../../src/harness/execute.js";
import { materializeProject } from "../../src/harness/project.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createFakeRegistry } from "../helpers/registry.js";

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
    });

    expect(report.reason).toBe("all 3 assertion(s) passed");
    expect(report.classification).toBe("PASS");
    // Evidence is written because a PASS without raw output is a claim, not a result (charter §4.8).
    expect(report.outcome?.evidenceDir).toContain("fixture-07");
  });

  it("does not pass fixture 4, which ships no project yet, so its entry point does not exist", async () => {
    const definition = loadDefinition("fixture-04");
    const { runtime, registry, environment, root } = await stage(definition);

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment,
      evidenceRoot: null,
    });

    // The honest current state, and a guard on staging rather than a wish about shims: an unstaged definition points
    // `node core.mjs` at a file that is not there, so the run fails and is reported as a failure. This test becomes a
    // PASS assertion the day fixture 4 is staged and the streams/timers shims exist; until then it must not go green.
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toBe("assertion failed: exit-code: expected exit code 0, observed 1 (and 5 more)");
  });
});
