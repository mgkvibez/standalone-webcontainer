/**
 * Guards on the module differential instrument.
 *
 * Same reasoning as the event-loop guard file: a harness that silently compares nothing reports "0 of 0 match" and looks like a
 * pass. These assert the cases are well-formed and self-contained, so a green run means fourteen real comparisons happened.
 */

import { describe, expect, it } from "vitest";

import { MODULE_CASES } from "../../tools/differential/module-cases.js";

describe("module differential cases", () => {
  it("has enough cases for the run to mean something", () => {
    expect(MODULE_CASES.length).toBeGreaterThan(10);
  });

  it("uses unique ids", () => {
    const ids = MODULE_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states every question as a question, because the question is the finding", () => {
    for (const testCase of MODULE_CASES) {
      expect(testCase.question.length).toBeGreaterThan(20);
      expect(testCase.question.trim().endsWith("?")).toBe(true);
    }
  });

  it("includes the entry file in its own tree, so a staging mistake cannot look like a resolver defect", () => {
    for (const testCase of MODULE_CASES) {
      expect(Object.keys(testCase.files)).toContain(testCase.entry);
    }
  });

  it("prints something in every case, so an empty run cannot read as agreement", () => {
    for (const testCase of MODULE_CASES) {
      expect(Object.values(testCase.files).join("\n")).toMatch(/console\.log\(/);
    }
  });

  it("keeps every case off the clock, the network and the outside filesystem", () => {
    for (const testCase of MODULE_CASES) {
      const source = Object.values(testCase.files).join("\n");
      expect(source).not.toMatch(/Math\.random|Date\.now|new Date\(/);
      expect(source).not.toMatch(/require\(["'](?:node:)?fs["']\)/);
      expect(source).not.toMatch(/require\(["'](?:node:)?(?:http|https|net)["']\)/);
      // Absolute paths would tie a case to one staging directory.
      expect(source).not.toMatch(/require\(["']\//);
    }
  });
});
