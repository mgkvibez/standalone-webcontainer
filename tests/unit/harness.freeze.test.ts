/**
 * Freeze verification. The point of these tests is that a fixture cannot stop being what it was while still counting
 * toward the gate, which is the difference between a measured rate and a claimed one.
 */

import { describe, expect, it } from "vitest";

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import {
  assertFreezeIntact,
  checkFreeze,
  definitionPayload,
  hashDefinition,
  scoreVerifiedFixtures,
} from "../../src/harness/freeze.js";
import { parseManifest, type ManifestEntry } from "../../src/harness/manifest.js";
import type { FixtureOutcome } from "../../src/harness/types.js";

/** A minimal definition that parses, so each test changes one thing about real, valid content. */
function rawDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 1,
    slug: "fixture-01",
    lane: "front-end-only",
    title: "Vite dev server boots",
    intent: "Proves the shortest useful path end to end.",
    source: "stackblitz-conformance: Vite, adapted",
    status: "frozen",
    steps: [{ kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the toolchain" }],
    assertions: [{ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }],
    expected: ["PASS"],
    ...overrides,
  };
}

function definition(overrides: Record<string, unknown> = {}): FixtureDefinition {
  return parseDefinition(rawDefinition(overrides));
}

function entry(frozenHash: string | null, id = 1): ManifestEntry {
  return { id, slug: `fixture-${String(id).padStart(2, "0")}`, lane: "front-end-only", definitionPath: `fixtures/definitions/fixture-${String(id).padStart(2, "0")}.json`, frozenHash };
}

function outcome(id: number, classification: FixtureOutcome["classification"] = "PASS"): FixtureOutcome {
  return {
    fixture: { id, slug: `fixture-${String(id).padStart(2, "0")}`, lane: "front-end-only" },
    classification,
    evidenceDir: `evidence/fixture-${String(id).padStart(2, "0")}`,
  };
}

describe("definition pins", () => {
  it("hashes content, not JSON layout, so key order and whitespace do not matter", async () => {
    const ordered = definition();
    const shuffled = parseDefinition(
      // Same definition, keys in a different order, which a formatter or a hand edit will do routinely.
      Object.fromEntries(Object.entries(rawDefinition()).reverse()),
    );
    expect(definitionPayload(shuffled)).toBe(definitionPayload(ordered));
    expect(await hashDefinition(shuffled)).toBe(await hashDefinition(ordered));
  });

  it("does not change when the lifecycle label changes, so freezing does not invalidate the pin", async () => {
    const before = await hashDefinition(definition({ status: "proposed" }));
    const after = await hashDefinition(definition({ status: "frozen" }));
    expect(after).toBe(before);
  });

  it("changes when anything that decides or explains an outcome changes", async () => {
    const base = await hashDefinition(definition());

    // The command, the assertion, the legitimate outcome set and the prose limits are all covered: the first three
    // decide the result, and knownLimits is what a reader uses to interpret it.
    const variants: Record<string, unknown>[] = [
      { steps: [{ kind: "install", command: "npm ci", timeoutClass: "install", purpose: "Install the toolchain" }] },
      { assertions: [{ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 404 }] },
      { expected: ["PASS", "UNSUPPORTED_BY_DESIGN"] },
      { knownLimits: ["A proxy miss is HARNESS_BUG, not a runtime failure."] },
    ];
    for (const overrides of variants) {
      expect(await hashDefinition(definition(overrides))).not.toBe(base);
    }
  });

  it("produces a lowercase 64-character digest", async () => {
    expect(await hashDefinition(definition())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checkFreeze", () => {
  it("reports a proposed definition as unfrozen even when an old pin is lying around", async () => {
    const check = await checkFreeze(entry("a".repeat(64)), definition({ status: "proposed" }));
    expect(check.state).toBe("unfrozen");
  });

  it("reports a frozen definition with no pin as unpinned rather than scoreable", async () => {
    const check = await checkFreeze(entry(null), definition());
    expect(check.state).toBe("unpinned");
    expect(check.expected).toBeNull();
    expect(check.actual).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a frozen definition whose content matches the pin", async () => {
    const def = definition();
    const check = await checkFreeze(entry(await hashDefinition(def)), def);
    expect(check.state).toBe("frozen");
  });

  it("reports drift when the content changed after freezing", async () => {
    const pinned = await hashDefinition(definition());
    const edited = definition({
      steps: [{ kind: "install", command: "npm ci", timeoutClass: "install", purpose: "Install the toolchain" }],
    });
    const check = await checkFreeze(entry(pinned), edited);
    expect(check.state).toBe("drifted");
    expect(check.expected).toBe(pinned);
    expect(check.actual).not.toBe(pinned);
  });
});

describe("assertFreezeIntact", () => {
  it("passes when nothing is frozen yet, because an unwritten corpus is not corruption", async () => {
    const check = await checkFreeze(entry(null), definition({ status: "proposed" }));
    expect(() => assertFreezeIntact([check])).not.toThrow();
  });

  it("fails loudly on drift, naming both hashes", async () => {
    const pinned = await hashDefinition(definition());
    const check = await checkFreeze(entry(pinned), definition({ expected: ["PASS", "TIMEOUT"] }));
    expect(() => assertFreezeIntact([check])).toThrow(/fixture 1 pinned/);
    expect(() => assertFreezeIntact([check])).toThrow(/were edited/);
  });

  it("fails on a frozen claim with no pin, because it cannot be verified", async () => {
    const check = await checkFreeze(entry(null), definition());
    expect(() => assertFreezeIntact([check])).toThrow(/no pin for: 1/);
  });
});

describe("scoreVerifiedFixtures", () => {
  it("withholds an edited fixture from the gate and names it", async () => {
    const def = definition({ id: 1, slug: "fixture-01" });
    const pinned = await hashDefinition(def);
    const edited = definition({
      id: 1,
      slug: "fixture-01",
      steps: [
        { kind: "install", command: "npm install --prefer-offline", timeoutClass: "install", purpose: "Install the toolchain" },
      ],
    });

    const result = await scoreVerifiedFixtures({
      fixtures: [{ entry: entry(pinned), definition: edited }],
      outcomes: [outcome(1)],
    });

    // It passed, and it still does not count: that is the whole mechanism.
    expect(result.gate.frontEndOnly.scored).toBe(0);
    expect(result.gate.missing).toContain(1);
    expect(result.gate.gateMet).toBe(false);
    expect(result.withheld).toEqual([{ id: 1, state: "drifted" }]);
  });

  it("counts a verified fixture and leaves the gate to decide", async () => {
    const def = definition({ id: 1, slug: "fixture-01" });
    const result = await scoreVerifiedFixtures({
      fixtures: [{ entry: entry(await hashDefinition(def)), definition: def }],
      outcomes: [outcome(1)],
    });
    expect(result.gate.frontEndOnly.scored).toBe(1);
    expect(result.gate.frontEndOnly.passed).toBe(1);
    expect(result.withheld).toEqual([]);
    // One of fifteen front-end fixtures is not 90%.
    expect(result.gate.gateMet).toBe(false);
    expect(result.gate.missing).toHaveLength(14);
  });

  it("refuses a slot paired with a definition that has a different id", async () => {
    const def = definition({ id: 2, slug: "fixture-02" });
    await expect(
      scoreVerifiedFixtures({ fixtures: [{ entry: entry(null, 1), definition: def }], outcomes: [] }),
    ).rejects.toThrow(/paired with definition 2/);
  });
});

describe("manifest pins", () => {
  it("accepts an absent or null pin and a well-formed one", () => {
    const parsed = parseManifest({
      fixtures: [
        { id: 1, slug: "fixture-01", lane: "front-end-only", definitionPath: null },
        { id: 2, slug: "fixture-02", lane: "front-end-only", definitionPath: null, frozenHash: null },
        {
          id: 3,
          slug: "fixture-03",
          lane: "front-end-only",
          definitionPath: null,
          frozenHash: "b".repeat(64),
        },
      ],
    });
    expect(parsed.map((item) => item.frozenHash)).toEqual([null, null, "b".repeat(64)]);
  });

  it("rejects a pin that could not have come from the hasher, instead of treating it as a mismatch", () => {
    for (const bad of ["B".repeat(64), "abc", 7, "z".repeat(64)]) {
      expect(() =>
        parseManifest({
          fixtures: [{ id: 1, slug: "fixture-01", lane: "front-end-only", definitionPath: null, frozenHash: bad }],
        }),
      ).toThrow(/frozenHash must be a 64-character lowercase hex digest/);
    }
  });
});
