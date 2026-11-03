/**
 * Fixture definitions: the declared content of a numbered slot.
 *
 * The manifest fixes the numbering and the lane (charter §5). It deliberately left the content of
 * each slot undefined, and a null `definitionPath` made that gap visible rather than implied. This
 * module is the format those definitions are written in.
 *
 * Two rules shaped it:
 *
 * 1. A definition is DECLARATIVE. It states the steps, the timeouts class they belong to, and the
 *    assertions that decide the outcome. It does not contain runner code, so the same definition can
 *    be executed by the browser harness later without being rewritten.
 * 2. A definition states which outcomes are LEGITIMATE for it, not which outcome we want. Fixture 15
 *    exists to prove that a native addon is refused cleanly, so its expected set contains
 *    UNSUPPORTED_BY_DESIGN and a clean PASS there would mean the runtime lied. The gate must be able
 *    to distinguish "refused on purpose" from "failed" (charter §4.7).
 *
 * Charter §4.5 fixes three timeout classes. A step declares its class, and the class must match the
 * step kind: an install step that claimed the run budget would quietly quadruple what counts as a
 * timeout, so that mismatch is a parse error rather than a warning.
 */

import { CLASSIFICATIONS, type Classification, type Lane } from "./types.js";
import { laneForId } from "./score.js";

/** Charter §4.5. The three hard budgets, named so a step can cite one instead of a number. */
export type TimeoutClass = "install" | "build" | "run";

/** What a step does. The kind determines which timeout budget applies. */
export type StepKind = TimeoutClass;

/**
 * Assertion kinds are a closed vocabulary on purpose: an outcome may only be decided by a check the
 * runner can perform identically every time. Anything richer belongs in a fixture-specific script,
 * not in the shared format.
 */
export type AssertionKind =
  | "exit-code"
  | "stdout-contains"
  | "stderr-contains"
  | "file-exists"
  | "file-contains"
  | "http-status"
  | "http-body-contains";

export interface FixtureStep {
  readonly kind: StepKind;
  /** The exact command, no shell expansion assumed. */
  readonly command: string;
  readonly timeoutClass: TimeoutClass;
  /** Why this step is here, kept short enough to appear in a failure report. */
  readonly purpose: string;
}

export interface FixtureAssertion {
  readonly kind: AssertionKind;
  /** Step index the assertion applies to, or the path/URL target for file and http kinds. */
  readonly step: number;
  readonly target?: string;
  readonly equals?: string | number;
  readonly contains?: string;
}

/**
 * "proposed" means written from published evidence and awaiting owner sign-off.
 * "frozen" means signed off and therefore allowed to decide a gate outcome; charter §4.9 forbids
 * redefining the gate after results, so freezing is a deliberate act, not a default.
 */
export type DefinitionStatus = "proposed" | "frozen";

export interface FixtureDefinition {
  readonly formatVersion: 1;
  readonly id: number;
  readonly slug: string;
  readonly lane: Lane;
  readonly title: string;
  /** Why this slot exists, in terms of what it proves about the runtime. */
  readonly intent: string;
  /** Where the scenario came from. Public, cited, and never a copied implementation. */
  readonly source: string;
  readonly status: DefinitionStatus;
  readonly steps: readonly FixtureStep[];
  readonly assertions: readonly FixtureAssertion[];
  /** The outcomes that would be legitimate here. At least one; PASS is not always among them. */
  readonly expected: readonly Classification[];
  readonly knownLimits?: readonly string[];
}

const STEP_KINDS: readonly StepKind[] = ["install", "build", "run"];

const ASSERTION_KINDS: readonly AssertionKind[] = [
  "exit-code",
  "stdout-contains",
  "stderr-contains",
  "file-exists",
  "file-contains",
  "http-status",
  "http-body-contains",
];

const SLUG_PATTERN = /^fixture-\d{2}$/;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string, what: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what}.${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(source: Record<string, unknown>, field: string, what: string): readonly string[] {
  const value = source[field];
  if (!Array.isArray(value)) throw new Error(`${what}.${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${what}.${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function parseStep(raw: unknown, index: number, what: string): FixtureStep {
  const step = asRecord(raw, `${what}.steps[${index}]`);
  const kind = step["kind"];
  if (typeof kind !== "string" || !(STEP_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${what}.steps[${index}].kind must be one of ${STEP_KINDS.join(", ")}`);
  }
  const timeoutClass = step["timeoutClass"];
  if (timeoutClass !== kind) {
    // Not a style preference: the charter's budgets are per class, so a mismatched class would
    // score a slow install as a run timeout.
    throw new Error(
      `${what}.steps[${index}].timeoutClass must be "${kind}" to inherit that budget, got ${JSON.stringify(timeoutClass)}`,
    );
  }
  return {
    kind: kind as StepKind,
    command: requireString(step, "command", `${what}.steps[${index}]`),
    timeoutClass: timeoutClass as TimeoutClass,
    purpose: requireString(step, "purpose", `${what}.steps[${index}]`),
  };
}

function parseAssertion(raw: unknown, index: number, what: string, stepCount: number): FixtureAssertion {
  const assertion = asRecord(raw, `${what}.assertions[${index}]`);
  const kind = assertion["kind"];
  if (typeof kind !== "string" || !(ASSERTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${what}.assertions[${index}].kind must be one of ${ASSERTION_KINDS.join(", ")}`);
  }
  const step = assertion["step"];
  if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step >= stepCount) {
    throw new Error(`${what}.assertions[${index}].step must index an existing step (0-${stepCount - 1})`);
  }
  const needsTarget = kind === "file-exists" || kind === "file-contains" || kind === "http-status" || kind === "http-body-contains";
  const target = assertion["target"];
  if (target !== undefined && typeof target !== "string") {
    throw new Error(`${what}.assertions[${index}].target must be a string`);
  }
  if (needsTarget && (typeof target !== "string" || target.length === 0)) {
    throw new Error(`${what}.assertions[${index}] (${kind}) requires a target`);
  }
  const contains = assertion["contains"];
  if (contains !== undefined && typeof contains !== "string") {
    throw new Error(`${what}.assertions[${index}].contains must be a string`);
  }
  const equals = assertion["equals"];
  if (equals !== undefined && typeof equals !== "string" && typeof equals !== "number") {
    throw new Error(`${what}.assertions[${index}].equals must be a string or number`);
  }
  return {
    kind: kind as AssertionKind,
    step,
    ...(typeof target === "string" ? { target } : {}),
    ...(typeof contains === "string" ? { contains } : {}),
    ...(typeof equals === "string" || typeof equals === "number" ? { equals } : {}),
  };
}

/**
 * Validate one definition. Every rejection here is a defect that would otherwise surface as a
 * mis-scored run much later, which is why parsing is strict rather than forgiving.
 */
export function parseDefinition(raw: unknown, origin = "definition"): FixtureDefinition {
  const record = asRecord(raw, origin);

  if (record["formatVersion"] !== 1) {
    throw new Error(`${origin}.formatVersion must be 1`);
  }

  const id = record["id"];
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new Error(`${origin}.id must be an integer`);
  }
  const expectedLane = laneForId(id);
  if (expectedLane === undefined) {
    throw new Error(`${origin}.id ${id} is outside the pre-registered 1-20 range`);
  }

  const slug = requireString(record, "slug", origin);
  if (!SLUG_PATTERN.test(slug)) throw new Error(`${origin}.slug must look like fixture-NN, got ${slug}`);
  if (slug !== `fixture-${String(id).padStart(2, "0")}`) {
    throw new Error(`${origin}.slug ${slug} does not match id ${id}`);
  }

  const lane = record["lane"];
  if (lane !== expectedLane) {
    throw new Error(
      `${origin}.lane is ${JSON.stringify(lane)} but the charter assigns fixture ${id} to ${expectedLane}`,
    );
  }

  const status = record["status"];
  if (status !== "proposed" && status !== "frozen") {
    throw new Error(`${origin}.status must be "proposed" or "frozen"`);
  }

  const rawSteps = record["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`${origin}.steps must be a non-empty array`);
  }
  const steps = rawSteps.map((step, index) => parseStep(step, index, origin));

  const rawAssertions = record["assertions"];
  if (!Array.isArray(rawAssertions) || rawAssertions.length === 0) {
    throw new Error(`${origin}.assertions must be a non-empty array`);
  }
  const assertions = rawAssertions.map((assertion, index) =>
    parseAssertion(assertion, index, origin, steps.length),
  );

  const rawExpected = requireStringArray(record, "expected", origin);
  const expected = rawExpected.map((value) => {
    if (!(CLASSIFICATIONS as readonly string[]).includes(value)) {
      throw new Error(`${origin}.expected contains ${value}, which is not a charter classification`);
    }
    return value as Classification;
  });

  const knownLimits = record["knownLimits"] === undefined
    ? undefined
    : requireStringArray(record, "knownLimits", origin);

  return {
    formatVersion: 1,
    id,
    slug,
    lane: expectedLane,
    title: requireString(record, "title", origin),
    intent: requireString(record, "intent", origin),
    source: requireString(record, "source", origin),
    status,
    steps,
    assertions,
    expected,
    ...(knownLimits === undefined ? {} : { knownLimits }),
  };
}

/**
 * A definition that has not been signed off may not decide a gate outcome. Charter §4.9 forbids
 * redefining the gate after results exist; allowing a proposed definition to score would be the same
 * failure with extra steps.
 */
export function isScoreable(definition: FixtureDefinition): boolean {
  return definition.status === "frozen";
}

/** Whether an observed outcome is legitimate for this fixture. */
export function isExpectedOutcome(definition: FixtureDefinition, observed: Classification): boolean {
  return definition.expected.includes(observed);
}
