/**
 * W-27: evidence says how it was produced, and a run from another lane cannot quietly replace it.
 *
 * The defect being pinned is not hypothetical. `fixture-08`'s committed evidence once said `SNAPSHOT_MISSING: express` — from a
 * corpus-lane run — while the scorecard said PASS from the express snapshot, and nothing on disk recorded which lane either one
 * used. Two runs of the same fixture were therefore indistinguishable after the second wrote.
 *
 * These tests are written against the DECISION function and against real files: a rule enforced only in memory is the same
 * shape of mistake as a watch registry that no product path constructs.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import {
  decideEvidenceWrite,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceRefusedError,
  laneIdentity,
  PROVENANCE_SCHEMA_VERSION,
  type RegistryProvenance,
  type RunProvenanceInput,
} from "../../src/harness/provenance.js";
import { testProvenance } from "../helpers/provenance.js";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "evidence-prov-"));

const environment = (): AssertionEnvironment => ({
  readFile: async () => null,
  request: async () => {
    throw new Error("no requests expected");
  },
});

function definition(): FixtureDefinition {
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
    assertions: [{ kind: "exit-code", step: 0, equals: 1 }],
    expected: ["PASS", "RUNTIME_INCOMPATIBILITY"],
  });
}

const CORPUS: RegistryProvenance = { lane: "corpus", label: "offline corpus (fixtures/registry)" };
const VITE: RegistryProvenance = {
  lane: "snapshot",
  label: "fixtures/snapshots/vite",
  snapshot: { directory: "fixtures/snapshots/vite", capturedAt: "2026-11-11T06:10:11.376Z", digest: "aaa", packages: 8 },
};
const VITE_REBUILT: RegistryProvenance = {
  lane: "snapshot",
  label: "fixtures/snapshots/vite",
  snapshot: { directory: "fixtures/snapshots/vite", capturedAt: "2026-11-12T09:00:00.000Z", digest: "bbb", packages: 9 },
};

const record = (index: number) => ({ index, exitCode: 1, stdout: "", stderr: "native\n" });

const run = (root: string, provenance?: RunProvenanceInput, replaceForeignEvidence?: boolean) =>
  runFixture({
    definition: definition(),
    executeStep: async () => ({ termination: "ok", detail: "ran", record: record(0) }),
    environment: environment(),
    evidenceRoot: root,
    ...(provenance === undefined ? {} : { provenance }),
    ...(replaceForeignEvidence === undefined ? {} : { replaceForeignEvidence }),
  });

describe("the tree state a run records", () => {
  const slug = "fixture-15";

  it("writes whether the tree was dirty, so a commit is not mistaken for the code", async () => {
    const root = tempDir();
    await run(root, testProvenance({ tree: { dirty: true, changedFiles: 7 } }));

    const record = JSON.parse(readFileSync(join(root, slug, "provenance.json"), "utf8")) as { tree: { dirty: boolean; changedFiles: number } };
    expect(record.tree).toEqual({ dirty: true, changedFiles: 7 });
  });

  it("records an unknown tree as unknown rather than clean", async () => {
    const root = tempDir();
    const { tree: _omitted, ...withoutTree } = testProvenance();
    await run(root, withoutTree);

    const record = JSON.parse(readFileSync(join(root, slug, "provenance.json"), "utf8")) as { tree: { dirty: boolean; changedFiles: number | null } };
    expect(record.tree.dirty).toBe(true);
    expect(record.tree.changedFiles).toBeNull();
  });
});

describe("the lane identity", () => {
  it("separates two snapshots that share a directory, because they may not hold the same bytes", () => {
    expect(laneIdentity(VITE)).not.toBe(laneIdentity(VITE_REBUILT));
  });

  it("keeps the corpus and the network apart even though neither has a snapshot", () => {
    expect(laneIdentity(CORPUS)).toBe("corpus:offline corpus (fixtures/registry)");
    expect(laneIdentity({ lane: "network", label: "registry.npmjs.org" })).toBe("network:registry.npmjs.org");
  });
});

describe("deciding whether a run may write", () => {
  it("writes when there is nothing to replace", () => {
    expect(decideEvidenceWrite({ existing: null, incoming: CORPUS })).toEqual({ action: "write", replaces: "nothing" });
  });

  it("refuses a run from a different lane, and names both lanes", () => {
    const existing = { ...provenanceOf(CORPUS), schemaVersion: PROVENANCE_SCHEMA_VERSION, registry: VITE } as never;
    const decision = decideEvidenceWrite({ existing, incoming: CORPUS });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.code).toBe("LANE_CONFLICT");
    expect(decision.message).toContain("snapshot:aaa");
    expect(decision.message).toContain("corpus:");
  });

  it("refuses a rebuilt snapshot, because a path is a location and a digest is the bytes", () => {
    const existing = { ...provenanceOf(VITE_REBUILT), schemaVersion: PROVENANCE_SCHEMA_VERSION, registry: VITE_REBUILT } as never;
    const decision = decideEvidenceWrite({ existing, incoming: VITE });
    expect(decision.action).toBe("refuse");
  });

  it("refuses evidence written before provenance existed, and says which flag replaces it", () => {
    const decision = decideEvidenceWrite({ existing: { schemaVersion: 0 } as never, incoming: CORPUS });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.code).toBe("UNATTRIBUTED_EVIDENCE");
    expect(decision.message).toContain("--replace-unattributed");
  });

  it("refuses a record it cannot read, which is not the same thing as old evidence", () => {
    const decision = decideEvidenceWrite({ existing: { schemaVersion: 99, registry: CORPUS } as never, incoming: CORPUS });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.code).toBe("FOREIGN_SCHEMA");
    expect(decision.message).not.toContain("--replace-unattributed");
  });

  it("allows the replace only when it was asked for", () => {
    expect(decideEvidenceWrite({ existing: { schemaVersion: 0 } as never, incoming: CORPUS, replaceForeign: true })).toEqual({
      action: "write",
      replaces: "same-lane",
    });
    const laneExisting = { ...provenanceOf(VITE), schemaVersion: PROVENANCE_SCHEMA_VERSION, registry: VITE_REBUILT } as never;
    expect(decideEvidenceWrite({ existing: laneExisting, incoming: CORPUS, replaceForeign: true }).action).toBe("write");
  });
});

function provenanceOf(registry: RegistryProvenance): RunProvenanceInput {
  return testProvenance({ registry });
}

describe("what lands on disk", () => {
  it("records every fact needed to reproduce the run", async () => {
    const root = tempDir();
    await run(root, testProvenance({ registry: VITE }));

    const provenance = JSON.parse(readFileSync(join(root, "fixture-15", "provenance.json"), "utf8"));
    expect(provenance.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION);
    expect(provenance.runId).toMatch(/^[a-z0-9-]+$/);
    expect(provenance.fixture).toEqual({ id: 15, slug: "fixture-15", lane: "boundary" });
    expect(provenance.definition.sha256).toBe("0123456789abcdef".repeat(4));
    expect(provenance.commit).toBe("test-commit");
    expect(provenance.registry.snapshot.digest).toBe("aaa");
    expect(provenance.harness.name).toBe("test harness");
    expect(provenance.command.steps).toEqual([]);
    expect(Date.parse(provenance.startedAt)).not.toBeNaN();
    expect(Date.parse(provenance.endedAt)).not.toBeNaN();
    expect(provenance.endedAt >= provenance.startedAt).toBe(true);
    expect(provenance.durationMs).toBeGreaterThanOrEqual(0);
    expect(provenance.budgets.run).toBeGreaterThan(0);
    expect(provenance.verdict.classification).toBe("PASS");

    const schema = JSON.parse(readFileSync(join(root, "fixture-15", "schema.json"), "utf8"));
    expect(schema).toEqual({ schemaVersion: EVIDENCE_SCHEMA_VERSION, fixture: "fixture-15", runId: provenance.runId, lane: "snapshot" });
    expect(readFileSync(join(root, "fixture-15", "verdict.txt"), "utf8")).toContain(`run: ${provenance.runId}`);
  });

  it("refuses to write evidence at all when the run cannot say how it was executed", async () => {
    const root = tempDir();
    await expect(run(root)).rejects.toBeInstanceOf(EvidenceRefusedError);
    expect(() => readdirSync(join(root, "fixture-15"))).toThrow();
  });

  it("keeps every execution as its own record, while the canonical slot tracks the latest", async () => {
    const root = tempDir();
    await run(root, testProvenance({ registry: VITE, commit: "commit-one" }));
    await run(root, testProvenance({ registry: VITE, commit: "commit-two" }));

    const runs = readdirSync(join(root, "fixture-15", "runs")).sort();
    expect(runs).toHaveLength(2);
    const recorded = runs.map((name) => JSON.parse(readFileSync(join(root, "fixture-15", "runs", name), "utf8")).commit);
    expect(recorded.sort()).toEqual(["commit-one", "commit-two"]);
    // The canonical slot is the latest run, and says so.
    expect(JSON.parse(readFileSync(join(root, "fixture-15", "provenance.json"), "utf8")).commit).toBe("commit-two");
  });

  it("refuses a second run from a different lane and leaves the first result untouched", async () => {
    const root = tempDir();
    await run(root, testProvenance({ registry: VITE }));
    const before = readFileSync(join(root, "fixture-15", "provenance.json"), "utf8");

    await expect(run(root, testProvenance({ registry: CORPUS }))).rejects.toMatchObject({ code: "LANE_CONFLICT" });

    expect(readFileSync(join(root, "fixture-15", "provenance.json"), "utf8")).toBe(before);
    expect(readdirSync(join(root, "fixture-15", "runs"))).toHaveLength(1);
  });

  it("refuses to replace a bundle from before provenance, until the replace is asked for", async () => {
    const root = tempDir();
    mkdirSync(join(root, "fixture-15"), { recursive: true });
    writeFileSync(join(root, "fixture-15", "verdict.txt"), "fixture: fixture-15\nevidence schema: 3\nclassification: PASS\n", "utf8");

    await expect(run(root, testProvenance({ registry: CORPUS }))).rejects.toMatchObject({ code: "UNATTRIBUTED_EVIDENCE" });
    expect(readFileSync(join(root, "fixture-15", "verdict.txt"), "utf8")).toContain("evidence schema: 3");

    await run(root, testProvenance({ registry: CORPUS }), true);
    expect(readFileSync(join(root, "fixture-15", "verdict.txt"), "utf8")).toContain(`evidence schema: ${EVIDENCE_SCHEMA_VERSION}`);
  });
});
