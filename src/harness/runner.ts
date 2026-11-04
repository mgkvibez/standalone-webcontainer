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
import { TIMEOUTS, type Classification, type FixtureOutcome } from "./types.js";

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
  /** Absent when the step never produced a process result (timeout or refusal). */
  readonly record: StepRecord | null;
}

export type ExecuteStep = (step: FixtureStep, index: number) => Promise<StepExecution>;

export interface StepRun {
  readonly index: number;
  readonly kind: FixtureStep["kind"];
  readonly command: string;
  readonly termination: StepTermination;
  readonly detail: string;
  readonly elapsedMs: number;
  readonly record: StepRecord | null;
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
export function decideVerdict(steps: readonly StepRun[], assertions: readonly AssertionResult[]): Verdict {
  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
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
    return {
      classification: "UNSUPPORTED_BY_DESIGN",
      reason: `step ${unsupported.index} (${unsupported.command}) was refused: ${unsupported.detail}`,
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

  const bundle = await writeEvidence(input.evidenceRoot, input.definition.slug, {
    "steps.json": `${JSON.stringify(steps, null, 2)}\n`,
    "assertions.json": `${JSON.stringify(assertions, null, 2)}\n`,
    // The verdict is text so a human reading the evidence directory sees it without a tool.
    "verdict.txt": `fixture: ${input.definition.slug}\nclassification: ${verdict.classification}\nreason: ${verdict.reason}\n`,
  });

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
        termination: "timeout",
        detail: `no result within ${budget}ms`,
        elapsedMs: result.elapsedMs,
        record: null,
      });
      break;
    }

    const execution = result.value;
    steps.push({
      index,
      kind: step.kind,
      command: step.command,
      termination: execution.termination,
      detail: execution.detail,
      elapsedMs: result.elapsedMs,
      record: execution.record,
    });
    if (execution.record !== null) records.push(execution.record);
    // A step that timed out, was refused, or errored cannot be followed by a meaningful one: continuing would
    // produce assertions against a world that never got built.
    if (execution.termination !== "ok") break;
  }

  const allStepsRan = steps.length === input.definition.steps.length && steps.every((step) => step.termination === "ok");

  let fault: ProbeFault | null = null;
  if (allStepsRan) {
    for (const [index, assertion] of input.definition.assertions.entries()) {
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
  }

  const verdict: Verdict =
    fault !== null
      ? { classification: fault.classification, reason: fault.message }
      : allStepsRan
        ? decideVerdict(steps, assertions)
        : decideVerdict(steps, []);

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
