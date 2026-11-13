import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runFixture } from "../../src/harness/runner.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";
import { testProvenance } from "../helpers/provenance.js";

/**
 * Assertions are evaluated after every step has run, so a live fetch can only answer "what does this URL serve now".
 *
 * fixture-13 is the case that exposes it: the same URL must contain `initial-marker` at the end of the step that starts the dev
 * server, and `edited-marker` after a later step rewrites the file. With one live fetch at evaluation time both assertions read the
 * same body, and the fixture reports a failure that says nothing about the runtime. The fix records the observation with the step, and
 * these tests hold both halves: the capture is taken per step, and it is what evaluation reads.
 */

const tempDir = (): string => mkdtempSync(join(tmpdir(), "step-http-capture-"));

const page = (marker: string) => `<!doctype html><html><body><div id="root">${marker}</div></body></html>`;

/** A definition shaped like fixture-13: two assertions, same target, attached to different steps. */
const twoSided = {
  formatVersion: 1,
  id: 13,
  slug: "fixture-13",
  lane: "front-end-only",
  title: "Editing a file updates what the dev server serves",
  intent: "Two sides of one URL.",
  source: "unit",
  status: "proposed",
  steps: [
    { kind: "install", command: "npm install", timeoutClass: "install", purpose: "deps" },
    { kind: "run", command: "npm run dev", timeoutClass: "run", purpose: "serve" },
    { kind: "run", command: "node edit.mjs", timeoutClass: "run", purpose: "edit" },
  ],
  assertions: [
    { kind: "http-body-contains", step: 1, target: "http://localhost:3300/", contains: "initial-marker" },
    { kind: "http-body-contains", step: 2, target: "http://localhost:3300/", contains: "edited-marker" },
  ],
  expected: ["PASS"],
  files: {},
} as unknown as FixtureDefinition;

/**
 * A world whose served page changes when step 2 runs, which is what a dev server watching its own file system does. Nothing here
 * needs a server: what is under test is WHEN the harness looks, not what it is looking at.
 */
const world = () => {
  let served = page("initial-marker");
  return {
    executeStep: async (step: { command: string }) => {
      if (step.command.includes("edit")) served = page("edited-marker");
      return { termination: "ok" as const, detail: "ran", record: { index: 0, exitCode: 0, stdout: "", stderr: "" } };
    },
    environment: {
      readFile: async () => null,
      request: async () => ({ status: 200, body: served }),
    },
  };
};

describe("per-step HTTP observation", () => {
  it("lets the same URL answer differently at two different steps", async () => {
    const report = await runFixture({
      definition: twoSided,
      ...world(),
      evidenceRoot: null,
      provenance: testProvenance(),
    });

    // The whole point: before the capture, one of these two had to fail, because both read the post-edit body.
    expect(report.assertions.map((assertion) => assertion.passed)).toEqual([true, true]);
    expect(report.classification).toBe("PASS");
  });

  it("still fails when the step's own observation is wrong", async () => {
    // The false-positive guard in the other direction: a capture that always says the same thing must not paper over a mismatch.
    const world = {
      executeStep: async () => ({
        termination: "ok" as const,
        detail: "ran",
        record: { index: 0, exitCode: 0, stdout: "", stderr: "" },
      }),
      environment: { readFile: async () => null, request: async () => ({ status: 200, body: page("something-else") }) },
    };
    const report = await runFixture({ definition: twoSided, ...world, evidenceRoot: null });

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.assertions.every((assertion) => !assertion.passed)).toBe(true);
  });

  it("writes the observation into steps.json, where a human can read it", async () => {
    const root = tempDir();
    await runFixture({ definition: twoSided, ...world(), evidenceRoot: root, provenance: testProvenance() });

    const steps = JSON.parse(readFileSync(join(root, "fixture-13", "steps.json"), "utf8")) as {
      record: { http?: Record<string, { body: string }> } | null;
    }[];
    // Step 0 asserts on nothing, so it carries no capture: the harness fetches only targets an assertion names.
    expect(steps[0]?.record?.http).toBeUndefined();
    expect(steps[1]?.record?.http?.["http://localhost:3300/"]?.body).toContain("initial-marker");
    expect(steps[2]?.record?.http?.["http://localhost:3300/"]?.body).toContain("edited-marker");
  });

  it("names the step the observation came from, so a stale page is not a mystery", async () => {
    const report = await runFixture({ definition: twoSided, ...world(), evidenceRoot: null });
    for (const assertion of report.assertions) {
      expect(assertion.detail).toContain("as observed at the end of step");
    }
  });

  it("does not condemn a step whose probe could not be taken", async () => {
    // A probe failure is not a program failure. The step succeeded; the assertion falls back to a live fetch and reports through its
    // own fault path, so one flaky fetch cannot turn a correct run into RUNTIME_INCOMPATIBILITY.
    let calls = 0;
    const report = await runFixture({
      definition: twoSided,
      executeStep: async () => ({
        termination: "ok" as const,
        detail: "ran",
        record: { index: 0, exitCode: 0, stdout: "", stderr: "" },
      }),
      environment: {
        readFile: async () => null,
        request: async () => {
          calls += 1;
          if (calls <= 2) throw new Error("probe refused");
          return { status: 200, body: page("initial-marker") };
        },
      },
      evidenceRoot: null,
      provenance: testProvenance(),
    });

    // Both captures failed, so both assertions fell back to live fetches, which then answered from the same world: the first passes.
    expect(report.assertions[0]?.passed).toBe(true);
    expect(report.assertions[0]?.detail).not.toContain("as observed at the end of step");
  });
});
