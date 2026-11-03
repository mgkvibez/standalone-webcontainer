/** Test harness infrastructure: timeouts, normalization, evidence, and gate scoring. */

export type { Classification, FixtureOutcome, FixtureSlot, Lane } from "./types.js";
export type { NormalizeOptions } from "./normalize.js";
export type { TimeoutResult, TimeoutSuccess, TimeoutFailure } from "./timeout.js";
export type { EvidenceBundle } from "./evidence.js";
export type { GateReport, LaneScore } from "./score.js";
export type { ManifestEntry } from "./manifest.js";

export { CLASSIFICATIONS, TIMEOUTS, isClassification } from "./types.js";
export { normalizeText } from "./normalize.js";
export { withTimeout } from "./timeout.js";
export { assertSafeSlug, writeEvidence } from "./evidence.js";
export { BOUNDARY_IDS, FRONT_END_ONLY_IDS, GATE_THRESHOLD, laneForId, scoreGate } from "./score.js";
export type { AssertionKind, DefinitionStatus, FixtureAssertion, FixtureDefinition, FixtureStep, StepKind, TimeoutClass } from "./definition.js";
export { isExpectedOutcome, isScoreable, parseDefinition } from "./definition.js";
export { parseManifest, undefinedFixtures } from "./manifest.js";
