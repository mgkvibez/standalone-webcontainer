import { describe, expect, it } from "vitest";

import {
  BOUNDARY_IDS,
  FRONT_END_ONLY_IDS,
  GATE_THRESHOLD,
  laneForId,
  scoreGate,
} from "../../src/harness/score.js";
import type { Classification, FixtureOutcome } from "../../src/harness/types.js";

function outcome(id: number, classification: Classification): FixtureOutcome {
  const lane = laneForId(id);
  if (lane === undefined) throw new Error(`id ${id} has no lane`);
  return {
    fixture: { id, slug: `fixture-${String(id).padStart(2, "0")}`, lane },
    classification,
    evidenceDir: `/evidence/fixture-${id}`,
  };
}

const allFrontEnd = (classification: Classification): FixtureOutcome[] =>
  FRONT_END_ONLY_IDS.map((id) => outcome(id, classification));
const allBoundary = (classification: Classification): FixtureOutcome[] =>
  BOUNDARY_IDS.map((id) => outcome(id, classification));

describe("the pre-registered gate", () => {
  it("splits the twenty slots exactly as the charter numbers them", () => {
    expect(FRONT_END_ONLY_IDS).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20]);
    expect(BOUNDARY_IDS).toEqual([5, 6, 15, 16, 17]);
    expect(new Set([...FRONT_END_ONLY_IDS, ...BOUNDARY_IDS]).size).toBe(20);
  });

  it("fixes the threshold at 0.9 so it cannot be redefined after results", () => {
    expect(GATE_THRESHOLD).toBe(0.9);
  });
});

describe("scoreGate", () => {
  it("passes the gate at exactly 90% of the front-end lane", () => {
    const outcomes = allFrontEnd("PASS");
    outcomes[0] = outcome(FRONT_END_ONLY_IDS[0] as number, "RUNTIME_INCOMPATIBILITY");
    // 14 of 15 is 0.933.
    expect(scoreGate(outcomes).gateMet).toBe(true);
  });

  it("fails the gate below 90% even with every boundary fixture passing", () => {
    // Break three of fifteen: 12/15 = 80%. Keyed by id, because mutating array positions is exactly
    // how this test was wrong the first time.
    const broken = new Set([1, 2, 3]);
    const classifications: Record<number, Classification> = { 1: "RUNTIME_INCOMPATIBILITY", 2: "TIMEOUT", 3: "NETWORK" };
    const outcomes: FixtureOutcome[] = [];
    for (const id of FRONT_END_ONLY_IDS) {
      outcomes.push(outcome(id, broken.has(id) ? (classifications[id] as Classification) : "PASS"));
    }
    outcomes.push(...allBoundary("PASS"));
    const report = scoreGate(outcomes);
    expect(report.gateMet).toBe(false);
    expect(report.frontEndOnly).toEqual({
      lane: "front-end-only",
      passed: 12,
      scored: 15,
      rate: 12 / 15,
    });
    expect(report.boundary.passed).toBe(5);
  });

  it("refuses to meet the gate when a front-end fixture was never scored", () => {
    // Fourteen perfect results is not the pre-registered number; the missing slot has to be named.
    const outcomes = allFrontEnd("PASS").slice(0, 14);
    const report = scoreGate(outcomes);
    expect(report.gateMet).toBe(false);
    expect(report.missing).toEqual([20]);
  });

  it("never lets boundary results move the gate", () => {
    const outcomes = [...allFrontEnd("PASS"), ...allBoundary("UNSUPPORTED_BY_DESIGN")];
    const report = scoreGate(outcomes);
    expect(report.gateMet).toBe(true);
    expect(report.boundary.rate).toBe(0);
    expect(report.overall.scored).toBe(20);
  });

  it("refuses to score the same fixture twice", () => {
    expect(() => scoreGate([outcome(1, "PASS"), outcome(1, "PASS")])).toThrow(
      "fixture 1 was scored more than once",
    );
  });

  it("counts only PASS as a pass", () => {
    const outcomes = allFrontEnd("HARNESS_BUG");
    expect(scoreGate(outcomes).frontEndOnly.passed).toBe(0);
  });

  it("reports a 0 rate rather than NaN for a lane with nothing scored", () => {
    const report = scoreGate([]);
    expect(report.frontEndOnly.rate).toBe(0);
    expect(report.overall.rate).toBe(0);
    expect(report.gateMet).toBe(false);
  });
});
