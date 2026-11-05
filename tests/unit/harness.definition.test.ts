/**
 * The corpus is only real if it validates. These tests are the difference between "twenty definitions
 * exist" and "twenty definitions are usable", and they are written to fail loudly if someone edits a
 * fixture into a different lane, renames it, or quietly marks an unsigned definition scoreable.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isExpectedOutcome, isScoreable, parseDefinition } from "../../src/harness/definition.js";
import { parseManifest, undefinedFixtures } from "../../src/harness/manifest.js";
import { laneForId } from "../../src/harness/score.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";

const ROOT = process.cwd();
const IDS = Array.from({ length: 20 }, (_, index) => index + 1);

function definitionPath(id: number): string {
  return join(ROOT, "fixtures", "definitions", `fixture-${String(id).padStart(2, "0")}.json`);
}

function loadDefinition(id: number): FixtureDefinition {
  return parseDefinition(JSON.parse(readFileSync(definitionPath(id), "utf8")), `fixture-${id}`);
}

function loadAll(): readonly FixtureDefinition[] {
  return IDS.map(loadDefinition);
}

describe("fixture corpus", () => {
  it("has a definition file for every pre-registered slot", () => {
    for (const id of IDS) {
      expect(existsSync(definitionPath(id)), `missing definition for fixture ${id}`).toBe(true);
    }
  });

  it("parses all twenty without error", () => {
    expect(loadAll()).toHaveLength(20);
  });

  it("keeps every definition in the lane the charter assigns to its number", () => {
    for (const definition of loadAll()) {
      expect(definition.lane).toBe(laneForId(definition.id));
    }
  });

  it("keeps the front-end-only and boundary split at 15 and 5", () => {
    const all = loadAll();
    expect(all.filter((definition) => definition.lane === "front-end-only")).toHaveLength(15);
    expect(all.filter((definition) => definition.lane === "boundary")).toHaveLength(5);
  });

  it("marks every definition proposed, so none of them can decide the gate yet", () => {
    // Charter §4.9: the gate may not be redefined after results. A definition that scored before the
    // owner signed it off would be exactly that, so this assertion is a guard, not a formality.
    for (const definition of loadAll()) {
      expect(definition.status, `fixture ${definition.id}`).toBe("proposed");
      expect(isScoreable(definition)).toBe(false);
    }
  });

  it("gives every definition at least one assertion tied to a real step", () => {
    for (const definition of loadAll()) {
      expect(definition.assertions.length).toBeGreaterThan(0);
      for (const assertion of definition.assertions) {
        expect(assertion.step).toBeGreaterThanOrEqual(0);
        expect(assertion.step).toBeLessThan(definition.steps.length);
      }
    }
  });

  it("states at least one legitimate outcome per definition", () => {
    for (const definition of loadAll()) {
      expect(definition.expected.length, `fixture ${definition.id}`).toBeGreaterThan(0);
    }
  });

  it("makes fixture 15 a must-refuse fixture rather than a must-pass one", () => {
    const definition = loadDefinition(15);
    expect(definition.expected).toEqual(["UNSUPPORTED_BY_DESIGN"]);
    expect(isExpectedOutcome(definition, "PASS")).toBe(false);
    expect(isExpectedOutcome(definition, "UNSUPPORTED_BY_DESIGN")).toBe(true);
  });

  it("never lists an outcome outside the charter classifications", () => {
    const allowed = new Set(["PASS", "RUNTIME_INCOMPATIBILITY", "HARNESS_BUG", "NETWORK", "TIMEOUT", "INVALID_BASELINE", "UNSUPPORTED_BY_DESIGN"]);
    for (const definition of loadAll()) {
      for (const outcome of definition.expected) expect(allowed.has(outcome)).toBe(true);
    }
  });
});

describe("manifest wiring", () => {
  it("reports no missing definitions now that the corpus exists", () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(ROOT, "fixtures", "manifest.json"), "utf8")));
    expect(undefinedFixtures(manifest)).toEqual([]);
  });

  it("points every manifest entry at a file that exists", () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(ROOT, "fixtures", "manifest.json"), "utf8")));
    for (const entry of manifest) {
      expect(entry.definitionPath).not.toBeNull();
      expect(existsSync(join(ROOT, entry.definitionPath as string)), `fixture ${entry.id}`).toBe(true);
    }
  });
});

describe("definition validation", () => {
  const base = () => JSON.parse(readFileSync(definitionPath(4), "utf8")) as Record<string, unknown>;

  it("rejects a step whose timeout class contradicts its kind", () => {
    const raw = base();
    const steps = raw["steps"] as Record<string, unknown>[];
    steps[0] = { ...steps[0], timeoutClass: "run" };
    expect(() => parseDefinition(raw)).toThrow(/timeoutClass/);
  });

  it("rejects a lane that disagrees with the charter", () => {
    expect(() => parseDefinition({ ...base(), lane: "boundary" })).toThrow(/lane/);
  });

  it("rejects a slug that does not match the id", () => {
    expect(() => parseDefinition({ ...base(), slug: "fixture-07" })).toThrow(/slug/);
  });

  it("rejects an id outside the pre-registered range", () => {
    expect(() => parseDefinition({ ...base(), id: 21, slug: "fixture-21" })).toThrow(/1-20/);
  });

  it("rejects an invented classification", () => {
    expect(() => parseDefinition({ ...base(), expected: ["PROBABLY_FINE"] })).toThrow(/classification/);
  });

  it("rejects an assertion that indexes a step which does not exist", () => {
    const raw = base();
    const assertions = raw["assertions"] as Record<string, unknown>[];
    assertions[0] = { ...assertions[0], step: 9 };
    expect(() => parseDefinition(raw)).toThrow(/step/);
  });

  it("rejects an unsupported assertion kind", () => {
    const raw = base();
    const assertions = raw["assertions"] as Record<string, unknown>[];
    assertions[0] = { ...assertions[0], kind: "looks-right" };
    expect(() => parseDefinition(raw)).toThrow(/kind/);
  });
});
