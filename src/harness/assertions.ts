/**
 * Assertion evaluation: turning a step's observable results into pass/fail.
 *
 * Three rules shaped it.
 *
 * 1. **A fault is not a failure.** "The runtime served nothing" and "the harness could not ask" are different
 *    findings with different owners, so an environment call that cannot complete raises `ProbeFault` carrying the
 *    classification its adapter chose, instead of being reported as a failed assertion. The adapter is the only layer
 *    that can tell a proxy miss from a genuine network error, which is why the decision lives there and not here.
 * 2. **Comparisons are normalized, in order.** Charter §4.6 requires normalization so two runs agree, but sorting
 *    lines destroys contiguity: a `contains` check for two adjacent lines would fail intermittently. So line order is
 *    preserved here while timestamps, CRLF, temp paths and sourcemap noise are still stripped.
 * 3. **A missing step fails loudly, not silently.** If a step never ran, an assertion that refers to it cannot pass,
 *    and the detail says so rather than blaming the runtime for a value it never produced.
 */

import type { AssertionKind, FixtureAssertion } from "./definition.js";
import { normalizeText } from "./normalize.js";

/** What a completed step produced. `exitCode` is the process exit status, not a pass/fail signal. */
export interface StepRecord {
  readonly index: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * HTTP observations taken at the END of this step, keyed by target URL.
   *
   * Assertions are evaluated after every step has run, so a live fetch at evaluation time can only ever see the world as it is at the
   * end of the fixture. fixture-13 is the case that makes that fatal: it asserts the served page contains `initial-marker` at the end
   * of the step that starts the server, and `edited-marker` after a later step rewrites the file. Both assertions name the same URL, so
   * fetching once at the end answers the first one with the second one's body and the fixture measures nothing. The observation
   * therefore belongs to the step that was current when it was taken, and this is where it is kept.
   */
  readonly http?: Readonly<Record<string, HttpProbe>>;
  /**
   * What happened while the harness waited for this step's server to answer (W-28).
   *
   * A step that binds a port is RUNNING, which is not the same claim as READY: measured through vite, the port is bound at
   * ~1.1 s and the first request is answered at ~5.1 s. Readiness is therefore never inferred from a bound port or from a line
   * of terminal output — it is a real request, counted, with the deadline it ran under. Absent on a step that started no server.
   */
  readonly readiness?: {
    readonly port: number;
    readonly ready: boolean;
    readonly attempts: number;
    readonly elapsedMs: number;
    readonly deadlineMs: number;
    readonly status?: number;
    readonly lastError?: string;
  };
}

export interface HttpProbe {
  readonly status: number;
  readonly body: string;
}

/**
 * The observable world an assertion reads.
 *
 * `readFile` returns null for a missing path rather than throwing, because absence is a normal result (`file-exists`
 * asserts on it). A genuine I/O failure throws, and the adapter is expected to wrap it in a `ProbeFault`.
 */
export interface AssertionEnvironment {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly request: (url: string) => Promise<HttpProbe>;
}

/**
 * A fault outside the runtime under test.
 *
 * NETWORK when the request or read could not be performed at all; HARNESS_BUG when the harness itself is at fault,
 * such as a preview route that never reached the gateway. Neither is evidence about the runtime.
 */
export class ProbeFault extends Error {
  readonly classification: "NETWORK" | "HARNESS_BUG";

  constructor(classification: "NETWORK" | "HARNESS_BUG", message: string) {
    super(message);
    this.name = "ProbeFault";
    this.classification = classification;
  }
}

/**
 * A three-state result, because "did not pass" is two different findings (ADR-0014 D-4).
 *
 * `not-evaluated` means the step this asserts on never ran, so there was nothing to observe. Counting it as a failure
 * would accuse the runtime of producing a wrong value it was never asked for.
 */
export type AssertionState = "passed" | "failed" | "not-evaluated";

export interface AssertionResult {
  readonly index: number;
  readonly kind: AssertionKind;
  /** Authoritative. Every scoring path reads this rather than `passed`. */
  readonly state: AssertionState;
  /**
   * Retained for backward compatibility and derived as exactly `state === "passed"`.
   *
   * It is NOT a synonym for "failed": `passed: false` covers both `failed` and `not-evaluated`. Schema v2 therefore
   * requires state-aware consumers; a reader that treats `false` as failure will misreport a legitimate refusal.
   */
  readonly passed: boolean;
  /** Whether the step this assertion refers to actually ran. Always true for file and http assertions. */
  readonly stepAvailable: boolean;
  /** Human-readable, always naming what was expected and what was observed. */
  readonly detail: string;
}

function normalizeForComparison(value: string): string {
  // sortLines off deliberately: see rule 2 in the module comment.
  return normalizeText(value, { sortLines: false });
}

function truncate(value: string, limit = 200): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** Assertion kinds that read a step's output rather than the environment. */
const STEP_KINDS: readonly AssertionKind[] = ["exit-code", "stdout-contains", "stderr-contains"];

/**
 * Where the observation came from, said out loud in the detail.
 *
 * Without this a failing line reads "observed <edited body>" for an assertion about an earlier step, and the reader has no way to tell
 * a stale page from a harness that fetched too late. Naming the step is the difference between a readable failure and a mystery.
 */
function observedAt(step: number | undefined, captured: HttpProbe | undefined): string {
  return captured === undefined ? "" : ` (as observed at the end of step ${String(step)})`;
}

export async function evaluateAssertion(
  assertion: FixtureAssertion,
  index: number,
  steps: readonly StepRecord[],
  environment: AssertionEnvironment,
): Promise<AssertionResult> {
  const result = (passed: boolean, detail: string): AssertionResult => ({
    index,
    kind: assertion.kind,
    state: passed ? "passed" : "failed",
    passed,
    stepAvailable: true,
    detail,
  });

  if (STEP_KINDS.includes(assertion.kind)) {
    const step = steps.find((candidate) => candidate.index === assertion.step);
    if (step === undefined) {
      // Not a failure: the step never produced a record, so the assertion could not be evaluated at all.
      return {
        index,
        kind: assertion.kind,
        state: "not-evaluated",
        passed: false,
        stepAvailable: false,
        detail: `step ${assertion.step} did not run, so ${assertion.kind} cannot be checked`,
      };
    }

    if (assertion.kind === "exit-code") {
      const expected = Number(assertion.equals);
      if (!Number.isFinite(expected)) {
        // A definition whose expected exit code is not a number cannot be evaluated, and guessing would hide it.
        throw new ProbeFault("HARNESS_BUG", `exit-code assertion expects a numeric exit code, got ${String(assertion.equals)}`);
      }
      return result(
        step.exitCode === expected,
        `expected exit code ${expected}, observed ${step.exitCode}`,
      );
    }

    const stream = assertion.kind === "stdout-contains" ? step.stdout : step.stderr;
    const name = assertion.kind === "stdout-contains" ? "stdout" : "stderr";
    const needle = normalizeForComparison(assertion.contains ?? "");
    const passed = needle.length > 0 && normalizeForComparison(stream).includes(needle);
    return result(
      passed,
      passed
        ? `${name} contained the expected text`
        : `${name} did not contain ${JSON.stringify(truncate(assertion.contains ?? ""))}; observed ${JSON.stringify(truncate(stream))}`,
    );
  }

  if (assertion.target === undefined) {
    throw new ProbeFault("HARNESS_BUG", `${assertion.kind} assertion has no target`);
  }

  if (assertion.kind === "file-exists" || assertion.kind === "file-contains") {
    let contents: string | null;
    try {
      contents = await environment.readFile(assertion.target);
    } catch (error) {
      throw new ProbeFault(
        "HARNESS_BUG",
        `could not read ${assertion.target} to evaluate ${assertion.kind}: ${(error as Error).message}`,
      );
    }
    if (assertion.kind === "file-exists") {
      return result(contents !== null, contents === null ? `${assertion.target} does not exist` : `${assertion.target} exists`);
    }
    if (contents === null) {
      return result(false, `${assertion.target} does not exist, so its contents cannot contain anything`);
    }
    const needle = normalizeForComparison(assertion.contains ?? "");
    const passed = needle.length > 0 && normalizeForComparison(contents).includes(needle);
    return result(
      passed,
      passed
        ? `${assertion.target} contained the expected text`
        : `${assertion.target} did not contain ${JSON.stringify(truncate(assertion.contains ?? ""))}`,
    );
  }

  // http-status and http-body-contains.
  // A probe taken at the end of the step this assertion names wins over a live one. See StepRecord.http: a live fetch can only answer
  // "what does this URL serve NOW", which is the wrong question for any assertion that is not about the final state.
  const captured = steps.find((candidate) => candidate.index === assertion.step)?.http?.[assertion.target];
  let probe: HttpProbe;
  if (captured !== undefined) {
    probe = captured;
  } else {
    try {
      probe = await environment.request(assertion.target);
    } catch (error) {
    // The adapter decided whether this is the network or the harness; here we only carry its verdict.
      if (error instanceof ProbeFault) throw error;
      throw new ProbeFault(
        "NETWORK",
        `request to ${assertion.target} failed: ${(error as Error).message}`,
      );
    }
  }

  if (assertion.kind === "http-status") {
    const expected = Number(assertion.equals);
    if (!Number.isFinite(expected)) {
      throw new ProbeFault("HARNESS_BUG", `http-status assertion expects a numeric status, got ${String(assertion.equals)}`);
    }
    return result(
      probe.status === expected,
      `expected status ${expected} from ${assertion.target}${observedAt(assertion.step, captured)}, observed ${probe.status}`,
    );
  }

  const needle = normalizeForComparison(assertion.contains ?? "");
  const passed = needle.length > 0 && normalizeForComparison(probe.body).includes(needle);
  const when = observedAt(assertion.step, captured);
  return result(
    passed,
    passed
      ? `body of ${assertion.target}${when} contained the expected text`
      : `body of ${assertion.target}${when} did not contain ${JSON.stringify(
          truncate(assertion.contains ?? ""),
        )}; observed ${JSON.stringify(truncate(probe.body))}`,
  );
}
