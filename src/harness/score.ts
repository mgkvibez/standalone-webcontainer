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

function scoreLane(lane: Lane, outcomes: readonly FixtureOutcome[]): LaneScore {
  const inLane = outcomes.filter((outcome) => outcome.fixture.lane === lane);
  const passed = inLane.filter((outcome) => outcome.classification === "PASS").length;
  return {
    lane,
    passed,
    scored: inLane.length,
    // A lane with nothing scored has no rate. 0 keeps the type honest; `missing` carries the reason.
    rate: inLane.length === 0 ? 0 : passed / inLane.length,
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

  const missing = FRONT_END_ONLY_IDS.filter((id) => !seenIds.has(id));

  return {
    frontEndOnly,
    boundary,
    overall: {
      lane: "front-end-only",
      passed,
      scored: outcomes.length,
      rate: outcomes.length === 0 ? 0 : passed / outcomes.length,
    },
    missing,
    gateMet: missing.length === 0 && frontEndOnly.rate >= GATE_THRESHOLD,
  };
}
