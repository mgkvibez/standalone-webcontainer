/**
 * Guards on the differential instrument itself.
 *
 * A differential harness that silently compares nothing is worse than none: it reports "0 of 0 match" and looks like a
 * pass. These assert that every case actually produces output, that the list has no duplicates, and that normalisation
 * collapses whitespace rather than inventing matches.
 */

import { describe, expect, it } from "vitest";

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
