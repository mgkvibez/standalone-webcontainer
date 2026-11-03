/**
 * The fixture manifest: which numbered slot is which fixture, and which lane it scores in.
 *
 * The charter pre-registers the NUMBERING and the lane split (README §5). It does not define what
 * each fixture contains. That is why `definitionPath` is nullable: a slot with no definition is a
 * visible gap rather than a rumour, and the scorer counts it as missing instead of scoring it.
 */

import type { FixtureSlot, Lane } from "./types.js";
import { laneForId } from "./score.js";
import { assertSafeSlug } from "./evidence.js";

export interface ManifestEntry extends FixtureSlot {
  /** Path to the fixture definition, or null while the corpus is still being specified. */
  readonly definitionPath: string | null;
}

interface RawEntry {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly lane?: unknown;
  readonly definitionPath?: unknown;
}

function isLane(value: unknown): value is Lane {
  return value === "front-end-only" || value === "boundary";
}

export function parseManifest(raw: unknown): readonly ManifestEntry[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { fixtures?: unknown }).fixtures)) {
    throw new Error("manifest must be an object with a `fixtures` array");
  }

  const entries: ManifestEntry[] = [];
  const seen = new Set<number>();

  for (const candidate of (raw as { fixtures: unknown[] }).fixtures) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("every manifest entry must be an object");
    }
    const entry = candidate as RawEntry;

    if (typeof entry.id !== "number" || !Number.isInteger(entry.id)) {
      throw new Error(`manifest entry has a non-integer id: ${JSON.stringify(entry.id)}`);
    }
    const expectedLane = laneForId(entry.id);
    if (expectedLane === undefined) {
      throw new Error(`fixture id ${entry.id} is outside the pre-registered 1-20 range`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`fixture id ${entry.id} appears more than once`);
    }
    if (!isLane(entry.lane)) {
      throw new Error(`fixture ${entry.id} has an unknown lane: ${JSON.stringify(entry.lane)}`);
    }
    // The lane is not free data: the charter fixed it by number. A manifest that disagrees with the
    // charter would silently move a fixture into (or out of) the gate.
    if (entry.lane !== expectedLane) {
      throw new Error(
        `fixture ${entry.id} is lane ${entry.lane} but the charter assigns it to ${expectedLane}`,
      );
    }
    if (typeof entry.slug !== "string") {
      throw new Error(`fixture ${entry.id} has no slug`);
    }
    assertSafeSlug(entry.slug);

    if (entry.definitionPath !== null && typeof entry.definitionPath !== "string") {
      throw new Error(`fixture ${entry.id} definitionPath must be a string or null`);
    }

    seen.add(entry.id);
    entries.push({
      id: entry.id,
      slug: entry.slug,
      lane: entry.lane,
      definitionPath: typeof entry.definitionPath === "string" ? entry.definitionPath : null,
    });
  }

  return entries.sort((a, b) => a.id - b.id);
}

/** Slots that still have no fixture definition, so a report can name the gap precisely. */
export function undefinedFixtures(entries: readonly ManifestEntry[]): readonly number[] {
  return entries.filter((entry) => entry.definitionPath === null).map((entry) => entry.id);
}
