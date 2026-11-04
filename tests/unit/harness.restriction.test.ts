/**
 * The three-way distinction ADR-0010 amendment 2 records: a runtime refusal, our defect, and a policy we chose.
 *
 * These tests exist because the wrong bucket is a silent corruption of the evidence: HARNESS_BUG sends our deliberate
 * scope to a bug list, and a refusal credits the engine with a decision it never made. Each case asserts the bucket it
 * expects AND the bucket it must not become.
 */
import { describe, expect, it } from "vitest";
import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { createStepExecutor } from "../../src/harness/execute.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { createRestriction, describeRestriction } from "../../src/harness/restriction.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createFakeRegistry } from "../helpers/registry.js";

const environment = (): AssertionEnvironment => ({
  readFile: async () => null,
  request: async () => {
    throw new Error("no requests expected");
  },
});

const OFFLINE = createRestriction({
  policy: "offline-registry",
  operation: "npx shadcn@latest add button",
  reason: "registry fetches are disabled by policy for this milestone",
  alternative: "declare the package in package.json and install it from the project tree",
});

function definition(overrides: Record<string, unknown> = {}): FixtureDefinition {
  return parseDefinition({
    formatVersion: 1,
    id: 3,
    slug: "fixture-03",
    lane: "front-end-only",
    title: "shadcn-ui CLI writes a component into the source tree",
    intent: "Install-shaped npx under an offline regime.",
    source: "stackblitz-conformance: shadcn-ui, adapted",
    status: "proposed",
    steps: [
      { kind: "install", command: "npm install", timeoutClass: "install", purpose: "install" },
      { kind: "run", command: "npx --yes shadcn@latest add button", timeoutClass: "run", purpose: "add a component" },
    ],
    assertions: [{ kind: "exit-code", step: 1, equals: 0 }],
    expected: ["PASS"],
    ...overrides,
  });
}

describe("createRestriction validates what a verdict will trust", () => {
  it("rejects a policy that is not lowercase kebab-case", () => {
    expect(() => createRestriction({ ...OFFLINE, policy: "Offline_Registry" })).toThrow(/kebab-case/);
  });

  it("rejects an empty operation or reason, because a verdict nobody can act on is worse than none", () => {
    expect(() => createRestriction({ ...OFFLINE, operation: "  " })).toThrow(/operation/);
    expect(() => createRestriction({ ...OFFLINE, reason: "" })).toThrow(/reason/);
  });

  it("rejects an empty alternative rather than printing an empty 'instead' clause", () => {
    expect(() => createRestriction({ ...OFFLINE, alternative: " " })).toThrow(/alternative/);
  });

  it("freezes what it returns, so evidence cannot be rewritten after the fact", () => {
    expect(Object.isFrozen(OFFLINE)).toBe(true);
  });

  it("describes the policy in the order a reader needs it", () => {
    const text = describeRestriction(OFFLINE);
    expect(text.indexOf("offline-registry")).toBeLessThan(text.indexOf("shadcn@latest"));
    expect(text.indexOf("disabled by policy")).toBeLessThan(text.indexOf("instead:"));
  });
});

describe("a restriction is classed as deliberate, never as a bug", () => {
  it("classifies as UNSUPPORTED_BY_DESIGN and carries the policy into the verdict", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async (_step, index) =>
        index === 0
          ? { termination: "ok", detail: "installed", record: { index, exitCode: 0, stdout: "", stderr: "" } }
          : {
              termination: "restricted",
              detail: describeRestriction(OFFLINE),
              record: { index, exitCode: 1, stdout: "", stderr: `${describeRestriction(OFFLINE)}\n` },
              restriction: OFFLINE,
            },
      environment: environment(),
      evidenceRoot: null,
    });

    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.classification).not.toBe("HARNESS_BUG");
    expect(report.reason).toContain("offline-registry");
    expect(report.reason).toContain("instead:");
    // The record survives into the step, so evidence explains the outcome without reading our source.
    expect(report.steps[1]?.restriction?.policy).toBe("offline-registry");
    expect(report.steps[1]?.refusal).toBeUndefined();
  });

  it("keeps dependent steps skipped, with the policy named in the reason", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async (_step, index) =>
        index === 0
          ? { termination: "ok", detail: "installed", record: { index, exitCode: 0, stdout: "", stderr: "" } }
          : {
              termination: "restricted",
              detail: describeRestriction(OFFLINE),
              record: { index, exitCode: 1, stdout: "", stderr: "" },
              restriction: OFFLINE,
            },
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.steps).toHaveLength(2);
    expect(report.steps[1]?.state).toBe("ran");
  });

  it("treats a restriction with no policy record as our bug, because unlabeled is unattributable", async () => {
    const report = await runFixture({
      definition: definition(),
      executeStep: async (_step, index) => ({
        termination: index === 0 ? "ok" : "restricted",
        detail: "restricted, but nobody wrote down why",
        record: { index, exitCode: 1, stdout: "", stderr: "" },
      }),
      environment: environment(),
      evidenceRoot: null,
    });
    expect(report.classification).toBe("HARNESS_BUG");
  });
});

describe("the distinction holds through the real executor", () => {
  it("reports the offline-registry policy for npx, and the verdict is not a bug", async () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0" }));
    const registry = await createFakeRegistry({ packages: {} });
    const executeStep = createStepExecutor({ runtime: new InProcessRuntime(vfs), registry, root: "/app" });

    const report = await runFixture({ definition: definition(), executeStep, environment: environment(), evidenceRoot: null });

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[1]?.termination).toBe("restricted");
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.reason).toContain("offline-registry");
    // An incomplete tree is the project's problem, and it must not be laundered into a policy story.
    expect(report.classification).not.toBe("HARNESS_BUG");
  });
});
