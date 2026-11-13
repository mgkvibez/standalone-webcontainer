/**
 * A provenance record for tests that write evidence.
 *
 * Evidence now requires provenance (W-27), so every test that used to pass an `evidenceRoot` alone has to say how its run was
 * executed — which is the point of the rule. This helper keeps that fixture one line at each call site while letting a test
 * vary the lane when the lane is what it is testing.
 */

import { makeRunId, EVIDENCE_SCHEMA_VERSION, PROVENANCE_SCHEMA_VERSION, type RunProvenanceInput } from "../../src/harness/provenance.js";
import { DEFAULT_BUDGETS } from "../../src/harness/runner.js";

export function testProvenance(overrides: Partial<RunProvenanceInput> = {}): RunProvenanceInput {
  return {
    runId: makeRunId(new Date("2026-11-12T00:00:00.000Z"), "0123456789abcdef"),
    definition: { sha256: "0123456789abcdef".repeat(4), steps: 1, assertions: 1 },
    harness: { name: "test harness", version: "0.0.0" },
    runtime: { name: "node", version: process.version },
    commit: "test-commit",
    tree: { dirty: false, changedFiles: 0 },
    command: { argv: [], steps: [] },
    registry: { lane: "corpus", label: "offline corpus (fixtures/registry)" },
    budgets: DEFAULT_BUDGETS,
    ...overrides,
  };
}

/** Both versions, re-exported so a test asserts the constant rather than a literal that drifts. */
export { EVIDENCE_SCHEMA_VERSION, PROVENANCE_SCHEMA_VERSION };
