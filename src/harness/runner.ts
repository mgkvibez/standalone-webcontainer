/**
 * The fixture runner: sequencing, hard timeouts, classification, and evidence.
 *
 * The runner does not know what `npm run dev` means. Step execution is injected, so this file owns only the parts
 * that must be identical for every fixture: the order steps run in, the budget each one gets, what a fault is, how a
 * verdict is chosen when several things went wrong at once, and what lands on disk. Command interpretation is a
 * separate concern with its own tests.
 *
 * Two rules from the charter are load-bearing here.
 *
 * §4.5 — "Hanging processes produce TIMEOUT, not infinite waits." The runner holds the clock, not the executor: a
 * step that runs past its class budget is stopped and the run ends there, because a fixture whose install hung cannot
 * produce a meaningful run step.
 *
 * §4.7 — "Never redefine the gate after results", which implies the reverse too: a result the fixture declared
 * impossible must not be counted. The one result that needs holding back is a surprise PASS: fixture 15 declares that
 * only UNSUPPORTED_BY_DESIGN is legitimate, because a native addon cannot work here, so a clean PASS would mean the
 * fixture is wrong (or the runtime is lying), and either way the number cannot be believed. A FAILURE is never
 * relabelled: it is reported as itself, because calling a timeout or a harness bug a "bad baseline" would destroy the
 * diagnosis and accuse the fixture of a fault it did not cause.
 */

import type { AssertionResult, AssertionEnvironment, StepRecord } from "./assertions.js";
import { evaluateAssertion, ProbeFault } from "./assertions.js";
import type { FixtureDefinition, FixtureStep, TimeoutClass } from "./definition.js";
import { writeEvidence } from "./evidence.js";
import { withTimeout } from "./timeout.js";
import { CLASSIFICATIONS, TIMEOUTS, type Classification, type FixtureOutcome } from "./types.js";
import type { Refusal } from "../runtime/refusal.js";

/** How a step ended, independent of what it printed. */
/**
 * How a step ended.
 *
 * `unsupported` and `harness-fault` are deliberately different. `unsupported` is a refusal the RUNTIME makes on
 * purpose (a native addon it will not load), and it is a legitimate result for a fixture that exists to prove the
 * refusal. `harness-fault` is OUR gap: a command the interpreter cannot run yet, or a shell feature the harness does
 * not implement. Collapsing the two would report our missing feature as the runtime's design decision, and inflate the
 * by-design bucket that the gate treats as a legitimate outcome.
 */
export type StepTermination = "ok" | "timeout" | "unsupported" | "harness-fault" | "error";

export interface StepExecution {
  /**
   * `ok` means the step ran to completion and its result is meaningful. A non-zero exit code is still `ok`: fixtures
   * such as CLI exit codes assert on a non-zero status deliberately.
   */
  readonly termination: StepTermination;
  readonly detail: string;
  /** Absent when the step never produced a process result (timeout). Present for a refusal: its exit is evidence. */
  readonly record: StepRecord | null;
  /** Required iff `termination === "unsupported"`, carried by reference from the runtime (ADR-0014 D-6). */
  readonly refusal?: Refusal;
}

export type ExecuteStep = (step: FixtureStep, index: number) => Promise<StepExecution>;

/** Ran or never ran. A skipped step is recorded, not omitted, so a short report cannot hide a truncated run. */
export type StepState = "ran" | "skipped";

export interface StepRun {
  readonly index: number;
  readonly kind: FixtureStep["kind"];
  readonly command: string;
  readonly state: StepState;
  /** Required iff `state === "skipped"`: names the step and the reason the rest of the fixture did not run. */
  readonly skipReason?: string;
  /** `"not-run"` iff skipped, so a skipped step can never be mistaken for an execution outcome. */
  readonly termination: StepTermination | "not-run";
  readonly detail: string;
  readonly elapsedMs: number;
  readonly record: StepRecord | null;
  /** The refusal this step produced, carried by reference from the runtime. Never rebuilt from stderr (ADR-0014 D-6). */
  readonly refusal?: Refusal;
}

/**
 * The outcome of verifying a refusal (ADR-0014 D-5). Deliberately a discriminated union rather than a set of booleans:
 * atomicity is a property of the type, so no caller can combine "well formed" with "declared" and forget the rest.
 */
export type RefusalVerification =
  | {
      readonly verified: true;
      readonly refusal: Refusal;
      readonly stepIndex: number;
      readonly skippedSteps: number;
      readonly notEvaluated: number;
    }
  | {
      readonly verified: false;
      readonly cause: "malformed" | "undeclared" | "assertions-failed";
      readonly detail: string;
    };

/**
 * Decide whether an observed refusal is a verified, by-design refusal — in one pass, with no partial credit.
 *
 * Every condition is checked here and nowhere else, in the order that matters: malformedness first (a broken refusal
 * must not be rescued by a permissive definition), then declaration (an undeclared refusal is a runtime failure), then
 * the assertions on steps that ran (a refusal whose own evidence contradicts it is not a refusal we can believe).
 */
export function verifyRefusal(
  steps: readonly StepRun[],
  assertions: readonly AssertionResult[],
  expected: readonly Classification[],
): RefusalVerification | null {
  const refused = steps.find((step) => step.termination === "unsupported");
  if (refused === undefined) return null;

  const refusal = refused.refusal;
  if (refusal === undefined) {
    return {
      verified: false,
      cause: "malformed",
      detail: `step ${refused.index} (${refused.command}) refused without attaching refusal evidence`,
    };
  }

  if (!Object.isFrozen(refusal)) {
    // Evidence that can still be mutated is not evidence (ADR-0014 D-10). The runtime freezes at capture via
    // createRefusal; an unfrozen object means something built this refusal outside that path, so it cannot be trusted.
    return {
      verified: false,
      cause: "malformed",
      detail: `step ${refused.index} refusal evidence was not frozen at capture, so it could still be mutated`,
    };
  }

  const required = ["code", "capability", "message", "subject"] as const;
  const missing = required.filter((field) => {
    const value: unknown = refusal[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    return {
      verified: false,
      cause: "malformed",
      detail: `step ${refused.index} refusal is missing ${missing.join(", ")}`,
    };
  }

  if (!expected.includes("UNSUPPORTED_BY_DESIGN")) {
    return {
      verified: false,
      cause: "undeclared",
      detail:
        `step ${refused.index} refused ${refusal.capability} (${refusal.code}) but the definition expects only ` +
        `${expected.join(", ")}`,
    };
  }

  const failed = assertions.filter((assertion) => assertionState(assertion) === "failed");
  const first = failed[0];
  if (first !== undefined) {
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
    return {
      verified: false,
      cause: "assertions-failed",
      detail: `refusal evidence did not hold: ${first.kind}: ${first.detail}${more}`,
    };
  }

  return {
    verified: true,
    refusal,
    stepIndex: refused.index,
    skippedSteps: steps.filter((step) => step.state === "skipped").length,
    notEvaluated: assertions.filter((assertion) => assertionState(assertion) === "not-evaluated").length,
  };
}

/** Charter §4.5 budgets, mapped onto the step classes the definitions cite. */
export const DEFAULT_BUDGETS: Readonly<Record<TimeoutClass, number>> = {
  install: TIMEOUTS.installMs,
  build: TIMEOUTS.buildMs,
  run: TIMEOUTS.runMs,
};

export interface FixtureRunInput {
  readonly definition: FixtureDefinition;
  readonly executeStep: ExecuteStep;
  readonly environment: AssertionEnvironment;
  /** Absolute directory for raw evidence, or null to run without writing any (unit tests do this). */
  readonly evidenceRoot: string | null;
  readonly budgets?: Readonly<Record<TimeoutClass, number>>;
}

export interface FixtureRunReport {
  readonly classification: Classification;
  readonly reason: string;
  readonly steps: readonly StepRun[];
  readonly assertions: readonly AssertionResult[];
  /** Present only when evidence was written; the gate consumes outcomes, and a run without evidence is not one. */
  readonly outcome: FixtureOutcome | null;
}

interface Verdict {
  readonly classification: Classification;
  readonly reason: string;
}

/**
 * Choose one classification when several things went wrong.
 *
 * Precedence is deliberate and stated so a report is reproducible: a harness or network fault outranks everything,
 * because a run we could not observe tells us nothing about the runtime. Then a budget, then a refusal the runtime
 * made on purpose, then a step that errored, and only then a failed assertion.
 *
 * A harness fault outranks a timeout for the same reason: if our own interpreter could not run the step, the budget it
 * did or did not exceed is not evidence about anything.
 */
/**
 * The state of a result, tolerating a schema-v1 shape.
 *
 * A v1 `assertions.json` has no `state`, and a consumer replaying one would otherwise see every entry as neither passed
 * nor failed. For v1, `passed: false` did mean failure, so that is the correct reading; the fallback exists so old
 * evidence keeps its original meaning instead of silently dropping out of the count.
 */
export function assertionState(assertion: AssertionResult): "passed" | "failed" | "not-evaluated" {
  return assertion.state ?? (assertion.passed ? "passed" : "failed");
}

export function decideVerdict(
  steps: readonly StepRun[],
  assertions: readonly AssertionResult[],
  expected: readonly Classification[] = CLASSIFICATIONS,
): Verdict {
  // `state`, not `passed`: `passed: false` also covers not-evaluated, and counting that as a failure would turn every
  // legitimate refusal into RUNTIME_INCOMPATIBILITY (ADR-0014 D-8).
  const failedAssertions = assertions.filter((assertion) => assertionState(assertion) === "failed");
  const describeFailures = (prefix: string): string => {
    const first = failedAssertions[0];
    const more = failedAssertions.length > 1 ? ` (and ${failedAssertions.length - 1} more)` : "";
    // The kind is included because "expected 0, got 2" does not say what was expected to be 0, and a report is read by
    // someone who did not write the fixture.
    return first === undefined ? prefix : `${prefix}: ${first.kind}: ${first.detail}${more}`;
  };

  const harnessFault = steps.find((step) => step.termination === "harness-fault");
  if (harnessFault !== undefined) {
    return {
      classification: "HARNESS_BUG",
      reason: `step ${harnessFault.index} (${harnessFault.command}) could not be run by the harness: ${harnessFault.detail}`,
    };
  }

  const timedOut = steps.find((step) => step.termination === "timeout");
  if (timedOut !== undefined) {
    return {
      classification: "TIMEOUT",
      reason: `step ${timedOut.index} (${timedOut.command}) exceeded its ${timedOut.kind} budget after ${timedOut.elapsedMs}ms`,
    };
  }

  const unsupported = steps.find((step) => step.termination === "unsupported");
  if (unsupported !== undefined) {
    const verification = verifyRefusal(steps, assertions, expected);
    // verifyRefusal cannot return null here: `unsupported` was found in the same list it was given.
    if (verification !== null && verification.verified) {
      const skipped = verification.skippedSteps === 1 ? "1 later step skipped" : `${verification.skippedSteps} later steps skipped`;
      const notEvaluated =
        verification.notEvaluated === 0
          ? "no assertions left unevaluated"
          : `${verification.notEvaluated} assertion(s) not evaluated`;
      return {
        classification: "UNSUPPORTED_BY_DESIGN",
        reason:
          `step ${verification.stepIndex} (${unsupported.command}) was refused by design: ` +
          `${verification.refusal.capability} (${verification.refusal.code}) — ${verification.refusal.message} ` +
          `[${skipped}; ${notEvaluated}]`,
      };
    }
    // A refusal that cannot be verified is a runtime failure, never a by-design outcome: the bucket must be earned.
    return {
      classification: "RUNTIME_INCOMPATIBILITY",
      reason: `a refusal was recorded but could not be verified (${verification?.cause ?? "malformed"}): ${
        verification?.detail ?? "no evidence"
      }`,
    };
  }

  const errored = steps.find((step) => step.termination === "error");
  if (errored !== undefined) {
    return {
      classification: "RUNTIME_INCOMPATIBILITY",
      reason: `step ${errored.index} (${errored.command}) failed: ${errored.detail}`,
    };
  }

  if (failedAssertions.length > 0) {
    return { classification: "RUNTIME_INCOMPATIBILITY", reason: describeFailures("assertion failed") };
  }

  return { classification: "PASS", reason: `all ${assertions.length} assertion(s) passed` };
}

async function writeRunEvidence(
  input: FixtureRunInput,
  steps: readonly StepRun[],
  assertions: readonly AssertionResult[],
  verdict: Verdict,
): Promise<FixtureOutcome | null> {
  if (input.evidenceRoot === null) return null;

  // One capture, two files (ADR-0014 D-11). The refusal is the SAME frozen object in both renders and is never copied
  // into a mutable shape: JSON.stringify reads it, so what lands on disk is what the runtime captured.
  const refusedStep = steps.find((step) => step.refusal !== undefined);
  const files: Record<string, string> = {
    // Kept as bare arrays on purpose. Wrapping them to carry a version would break every existing consumer of
    // steps.json and assertions.json, and backward compatibility outranks a tidier shape (ADR-0014 D-8, condition 1).
    // The version therefore lives in schema.json and in verdict.txt, beside the files rather than inside them.
    "steps.json": `${JSON.stringify(steps, null, 2)}\n`,
    "assertions.json": `${JSON.stringify(assertions, null, 2)}\n`,
    "schema.json": `${JSON.stringify({ schemaVersion: 2, fixture: input.definition.slug }, null, 2)}\n`,
    // The verdict is text so a human reading the evidence directory sees it without a tool.
    "verdict.txt":
      `fixture: ${input.definition.slug}\n` +
      `evidence schema: 2\n` +
      `classification: ${verdict.classification}\n` +
      `reason: ${verdict.reason}\n`,
  };
  if (refusedStep !== undefined) {
    files["refusals.json"] =
      `${JSON.stringify(
        {
          schemaVersion: 2,
          stepIndex: refusedStep.index,
          exitCode: refusedStep.record?.exitCode ?? null,
          refusal: refusedStep.refusal,
        },
        null,
        2,
      )}\n`;
    files["verdict.txt"] += `refusal: ${refusedStep.refusal?.code ?? "unknown"} (${refusedStep.refusal?.capability ?? "unknown"})\n`;
  }

  const bundle = await writeEvidence(input.evidenceRoot, input.definition.slug, files);

  return {
    fixture: { id: input.definition.id, slug: input.definition.slug, lane: input.definition.lane },
    classification: verdict.classification,
    evidenceDir: bundle.dir,
  };
}

export async function runFixture(input: FixtureRunInput): Promise<FixtureRunReport> {
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const steps: StepRun[] = [];
  const records: StepRecord[] = [];
  const assertions: AssertionResult[] = [];

  /** Which steps ran, so the assertion phase can tell "not run" from "ran and produced nothing". */
  const availability = new Map<number, StepState>();
  /** The step that ended the run, and why, so every later step can carry a specific reason rather than a shrug. */
  let stoppedAt: { readonly index: number; readonly reason: string } | null = null;

  for (const [index, step] of input.definition.steps.entries()) {
    const budget = budgets[step.timeoutClass];
    const result = await withTimeout(() => input.executeStep(step, index), budget);

    if (!result.ok) {
      // The step is recorded as a timeout even though the executor was merely slow: the budget is the runner's
      // judgement, and the point of §4.5 is that a slow step is an outcome rather than a wait.
      steps.push({
        index,
        kind: step.kind,
        command: step.command,
        state: "ran",
        termination: "timeout",
        detail: `no result within ${budget}ms`,
        elapsedMs: result.elapsedMs,
        record: null,
      });
      availability.set(index, "ran");
      stoppedAt = { index, reason: `exceeded its ${step.timeoutClass} budget after ${budget}ms` };
      break;
    }

    const execution = result.value;
    steps.push({
      index,
      kind: step.kind,
      command: step.command,
      state: "ran",
      termination: execution.termination,
      detail: execution.detail,
      elapsedMs: result.elapsedMs,
      record: execution.record,
      ...(execution.refusal === undefined ? {} : { refusal: execution.refusal }),
    });
    availability.set(index, "ran");
    if (execution.record !== null) records.push(execution.record);
    // A step that timed out, was refused, or errored cannot be followed by a meaningful one: continuing would
    // produce assertions against a world that never got built.
    if (execution.termination !== "ok") {
      const reason =
        execution.termination === "unsupported"
          ? `refused ${execution.refusal?.capability ?? "a capability"} (${execution.refusal?.code ?? "unknown"})`
          : execution.termination === "harness-fault"
            ? "could not be run by the harness"
            : "failed";
      stoppedAt = { index, reason };
      break;
    }
  }

  if (stoppedAt !== null) {
    // Recorded rather than omitted (ADR-0014 D-3): a report that simply ends says nothing about what was meant to run,
    // and a reader cannot tell a truncated fixture from a short one.
    const stop = stoppedAt;
    for (const [index, step] of input.definition.steps.entries()) {
      if (index <= stop.index) continue;
      availability.set(index, "skipped");
      steps.push({
        index,
        kind: step.kind,
        command: step.command,
        state: "skipped",
        skipReason: `step ${stop.index} ${stop.reason}`,
        termination: "not-run",
        detail: `not run: step ${stop.index} ${stop.reason}`,
        elapsedMs: 0,
        record: null,
      });
    }
  }

  // Assertions are evaluated by availability, not gated on the whole run succeeding (ADR-0014 D-2/D-4): the step that
  // was refused still ran, so assertions about its evidence are meaningful and must actually be checked.
  let fault: ProbeFault | null = null;
  // A refusal is the one stop whose evidence must still be checked, because the classification depends on it. Every
  // other stop keeps the older rule: nothing is evaluated once the world stopped being built, which is what the
  // timeout fixture asserts and what stops a half-built environment reporting NETWORK for a step that never ran.
  const stoppedStep = stoppedAt === null ? undefined : steps.find((step) => step.index === stoppedAt?.index);
  const refusalStop = stoppedStep?.termination === "unsupported";

  for (const [index, assertion] of input.definition.assertions.entries()) {
    const stepIndex = "step" in assertion && typeof assertion.step === "number" ? assertion.step : null;
    if (stepIndex !== null && availability.get(stepIndex) === "ran" && stoppedAt !== null && !refusalStop) {
      assertions.push({
        index,
        kind: assertion.kind,
        state: "not-evaluated",
        passed: false,
        stepAvailable: true,
        detail: `step ${stoppedAt.index} ${stoppedAt.reason} before this could be checked`,
      });
      continue;
    }
    if (stepIndex === null && stoppedAt !== null) {
      // A file or http assertion observes the world AFTER all steps. If the run stopped early, that world was never
      // built, so evaluating it would probe a half-built environment and report NETWORK for what is really "not run".
      // This preserves the pre-ADR behaviour exactly: nothing outside a step is evaluated when the run stopped.
      assertions.push({
        index,
        kind: assertion.kind,
        state: "not-evaluated",
        passed: false,
        stepAvailable: false,
        detail: `the run stopped at step ${stoppedAt.index} (${stoppedAt.reason}), so ${assertion.kind} was never reached`,
      });
      continue;
    }
    if (stepIndex !== null && availability.get(stepIndex) === "skipped") {
      const skipped = steps.find((step) => step.index === stepIndex);
      assertions.push({
        index,
        kind: assertion.kind,
        state: "not-evaluated",
        passed: false,
        stepAvailable: false,
        detail: `step ${stepIndex} did not run (${skipped?.skipReason ?? "skipped"}), so ${assertion.kind} cannot be checked`,
      });
      continue;
    }
    try {
      assertions.push(await evaluateAssertion(assertion, index, records, input.environment));
    } catch (error) {
      if (error instanceof ProbeFault) {
        fault = error;
        break;
      }
      throw error;
    }
  }

  const verdict: Verdict =
    fault !== null
      ? { classification: fault.classification, reason: fault.message }
      : decideVerdict(steps, assertions, input.definition.expected);

  // Only a surprise PASS is held back. Every failure classification is reported as itself: relabelling a TIMEOUT,
  // NETWORK or HARNESS_BUG as a bad baseline would accuse the fixture of a fault it did not cause and erase the
  // distinction between "the runtime broke" and "we could not observe it".
  const surprisePass = verdict.classification === "PASS" && !input.definition.expected.includes("PASS");
  const finalVerdict: Verdict = surprisePass
    ? {
        classification: "INVALID_BASELINE",
        reason: `observed PASS but the definition expects only ${input.definition.expected.join(", ")}: ${verdict.reason}`,
      }
    : verdict;

  const outcome = await writeRunEvidence(input, steps, assertions, finalVerdict);
  return {
    classification: finalVerdict.classification,
    reason: finalVerdict.reason,
    steps,
    assertions,
    outcome,
  };
}
