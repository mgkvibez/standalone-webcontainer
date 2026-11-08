/** Test harness infrastructure: timeouts, normalization, evidence, and gate scoring. */

export type { Classification, FixtureOutcome, FixtureSlot, Lane } from "./types.js";
export type { NormalizeOptions } from "./normalize.js";
export type { TimeoutResult, TimeoutSuccess, TimeoutFailure } from "./timeout.js";
export type { EvidenceBundle } from "./evidence-bundle.js";
export type { GateReport, LaneScore } from "./score.js";
export type { ManifestEntry } from "./manifest.js";
export type { FreezeCheck, FreezeState, VerifiedScoring } from "./freeze.js";
export type { AssertionEnvironment, AssertionResult, HttpProbe, StepRecord } from "./assertions.js";
export type { ExecuteStep, FixtureRunInput, FixtureRunReport, StepExecution, StepRun, StepTermination } from "./runner.js";
export type { CommandPlan, ExecPlan, InstallPlan, InvalidPlan, NodePlan, RunScriptPlan } from "./command.js";
export type { StepExecutorOptions, StepRuntime } from "./execute.js";
export type { ProjectWriter } from "./project.js";

export { CLASSIFICATIONS, TIMEOUTS, isClassification } from "./types.js";
export { normalizeText } from "./normalize.js";
export { withTimeout } from "./timeout.js";
export { assertSafeSlug, writeEvidence } from "./evidence.js";
export { BOUNDARY_IDS, FRONT_END_ONLY_IDS, GATE_THRESHOLD, laneForId, scoreGate } from "./score.js";
export type { AssertionKind, DefinitionStatus, FixtureAssertion, FixtureDefinition, FixtureStep, StepKind, TimeoutClass } from "./definition.js";
export { isExpectedOutcome, isScoreable, parseDefinition } from "./definition.js";
export { parseManifest, undefinedFixtures } from "./manifest.js";
export { evaluateAssertion, ProbeFault } from "./assertions.js";
export { DEFAULT_BUDGETS, decideVerdict, runFixture } from "./runner.js";
export { parseStepCommand } from "./command.js";
export { createStepExecutor } from "./execute.js";
export { assertSafeProjectPath, materializeProject, ProjectPathError } from "./project.js";
export {
  assertFreezeIntact,
  checkFreeze,
  definitionPayload,
  hashDefinition,
  scoreVerifiedFixtures,
} from "./freeze.js";
