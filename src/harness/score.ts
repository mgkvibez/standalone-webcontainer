/**
 * The gate, computed rather than asserted (README §5).
 *
 * Two of the charter's rules are structural here:
 * - the threshold is a frozen constant, because §4.10 forbids redefining the gate after seeing results;
 * - a missing front-end fixture blocks the gate even at 100% of what did run, because a rate over
 *   fourteen of fifteen fixtures is not the number the charter pre-registered.
 */

import type { FixtureOutcome, Lane } from "./types.js";

/** README §5: "pre-registered, not adjustable". Nothing may pass this in at call time. */
export const GATE_THRESHOLD = 0.9;

/** README §5 numbering: front-end-only 1-4, 7-14, 18-20; boundary 5, 6, 15, 16, 17. */
export const FRONT_END_ONLY_IDS: readonly number[] = [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20];
export const BOUNDARY_IDS: readonly number[] = [5, 6, 15, 16, 17];

export function laneForId(id: number): Lane | undefined {
  if (FRONT_END_ONLY_IDS.includes(id)) return "front-end-only";
  if (BOUNDARY_IDS.includes(id)) return "boundary";
  return undefined;
}

export interface LaneScore {
  readonly lane: Lane;
  readonly passed: number;
  readonly scored: number;
  readonly rate: number;
  /**
   * Outcomes whose classification is one the fixture's own definition declared, and the rate over the same denominator.
   *
   * `passed` keeps its single meaning - the fixture ran and passed - because the gate and every report already read it that way.
   * A boundary fixture is the case the two numbers separate: `fixture-15` exists to be refused, so a by-design refusal is
   * `satisfied` and not `passed`. Counting it as passed would let a fixture that must NOT pass inflate the rate the charter
   * pre-registered; counting it as nothing would hide that the boundary behaved exactly as designed.
   */
  readonly satisfied: number;
  readonly satisfiedRate: number;
}

export interface GateReport {
  readonly frontEndOnly: LaneScore;
  readonly boundary: LaneScore;
  /** Reported for reference only; §5 says it is not the sole kill criterion. */
  readonly overall: LaneScore;
  /** Front-end ids that produced no outcome, so the gate cannot be met. */
  readonly missing: readonly number[];
  readonly gateMet: boolean;
}

/** Did this outcome do what its definition said it would? An outcome with no recorded expectation answers only for `PASS`. */
const satisfiedOutcome = (outcome: FixtureOutcome): boolean =>
  (outcome.expected ?? ["PASS"]).includes(outcome.classification);

function scoreLane(lane: Lane, outcomes: readonly FixtureOutcome[]): LaneScore {
  const inLane = outcomes.filter((outcome) => outcome.fixture.lane === lane);
  const passed = inLane.filter((outcome) => outcome.classification === "PASS").length;
  const satisfied = inLane.filter(satisfiedOutcome).length;
  return {
    lane,
    passed,
    scored: inLane.length,
    // A lane with nothing scored has no rate. 0 keeps the type honest; `missing` carries the reason.
    rate: inLane.length === 0 ? 0 : passed / inLane.length,
    satisfied,
    satisfiedRate: inLane.length === 0 ? 0 : satisfied / inLane.length,
  };
}

export function scoreGate(outcomes: readonly FixtureOutcome[]): GateReport {
  // The same fixture scored twice would silently change the denominator, which is the one number the
  // gate rests on. That is a harness bug (charter §4.7), so it fails loudly instead of averaging.
  const seenIds = new Set<number>();
  for (const outcome of outcomes) {
    if (seenIds.has(outcome.fixture.id)) {
      throw new Error(`fixture ${outcome.fixture.id} was scored more than once`);
    }
    seenIds.add(outcome.fixture.id);
  }

  const frontEndOnly = scoreLane("front-end-only", outcomes);
  const boundary = scoreLane("boundary", outcomes);
  const passed = outcomes.filter((outcome) => outcome.classification === "PASS").length;
  const satisfied = outcomes.filter(satisfiedOutcome).length;

  const missing = FRONT_END_ONLY_IDS.filter((id) => !seenIds.has(id));

  return {
    frontEndOnly,
    boundary,
    overall: {
      lane: "front-end-only",
      passed,
      scored: outcomes.length,
      rate: outcomes.length === 0 ? 0 : passed / outcomes.length,
      satisfied,
      satisfiedRate: outcomes.length === 0 ? 0 : satisfied / outcomes.length,
    },
    missing,
    gateMet: missing.length === 0 && frontEndOnly.rate >= GATE_THRESHOLD,
  };
}
