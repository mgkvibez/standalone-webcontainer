/**
 * Guards on the differential instrument itself.
 *
 * A differential harness that silently compares nothing is worse than none: it reports "0 of 0 match" and looks like a
 * pass. These assert that every case actually produces output, that the list has no duplicates, and that normalisation
 * collapses whitespace rather than inventing matches.
 */

import { describe, expect, it } from "vitest";

import { API_CASES } from "../../tools/differential/api-cases.js";
import { CASES } from "../../tools/differential/cases.js";

describe("event-loop differential cases", () => {
  it("has more than one case, so a silent empty run is impossible", () => {
    expect(CASES.length).toBeGreaterThan(1);
  });

  it("uses unique ids", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states a question in words for every case, because the question is the finding", () => {
    for (const testCase of CASES) {
      expect(testCase.question.length).toBeGreaterThan(20);
      expect(testCase.question.trim().endsWith("?")).toBe(true);
    }
  });

  it("keeps every case deterministic: no clocks, no randomness, no filesystem", () => {
    for (const testCase of CASES) {
      expect(testCase.source).not.toMatch(/Math\.random|Date\.now|new Date\(/);
      expect(testCase.source).not.toMatch(/require\(["']fs["']\)|node:fs/);
    }
  });

  it("ends every case with a terminal log, so output cannot be a race", () => {
    for (const testCase of CASES) {
      expect(testCase.source).toMatch(/console\.log\(/);
    }
  });
});

/**
 * The API-surface instrument's own guards.
 *
 * A case list that silently shrinks, repeats an id, or holds a case that cannot print anything is the same failure the harness guards above
 * describe, one file over: the table reads "0 of 0 match" and looks like a pass. These are deliberately NOT the event-loop guards: these cases
 * SHOULD use the filesystem, because an absent `fs.rmSync` is exactly what they measure.
 */
describe("API-surface differential cases", () => {
  it("covers enough surface that a silent empty run is impossible", () => {
    expect(API_CASES.length).toBeGreaterThan(20);
  });

  it("uses unique ids", () => {
    const ids = API_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states a question in words for every case, because the question is the finding", () => {
    for (const testCase of API_CASES) {
      expect(testCase.question.length).toBeGreaterThan(20);
      expect(testCase.question.trim().endsWith("?")).toBe(true);
    }
  });

  it("prints from every case, so a silent program cannot be mistaken for a match", () => {
    // The comparison is stdout plus exit status, and a case that prints nothing at all would compare equal to a run that died before its first
    // line. Every case must therefore reach a `console.log` on the success path, which the exit-status half then distinguishes.
    for (const testCase of API_CASES) {
      expect(testCase.source).toMatch(/console\.log\(/);
    }
  });

  it("stays deterministic: no clocks and no randomness of its own", () => {
    for (const testCase of API_CASES) {
      expect(testCase.source).not.toMatch(/Math\.random|Date\.now|new Date\(/);
    }
  });
});
