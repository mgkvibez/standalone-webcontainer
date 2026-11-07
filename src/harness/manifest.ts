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
  /**
   * SHA-256 of the definition's canonical content, recorded when the owner froze it (see `freeze.ts`).
   *
   * Null means no pin exists. That is not the same as "matches": a frozen definition with no pin cannot be verified,
   * and `checkFreeze` reports it as `unpinned` rather than scoreable.
   */
  readonly frozenHash: string | null;
}

interface RawEntry {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly lane?: unknown;
  readonly definitionPath?: unknown;
  readonly frozenHash?: unknown;
}

/** Lowercase hex SHA-256. Rejecting other shapes here means a typo cannot masquerade as a pin mismatch later. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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

    const frozenHash = entry.frozenHash;
    if (frozenHash !== undefined && frozenHash !== null && !isHash(frozenHash)) {
      throw new Error(
        `fixture ${entry.id} frozenHash must be a 64-character lowercase hex digest or null, got ${JSON.stringify(frozenHash)}`,
      );
    }

    seen.add(entry.id);
    entries.push({
      id: entry.id,
      slug: entry.slug,
      lane: entry.lane,
      definitionPath: typeof entry.definitionPath === "string" ? entry.definitionPath : null,
      frozenHash: isHash(frozenHash) ? frozenHash : null,
    });
  }

  return entries.sort((a, b) => a.id - b.id);
}

/** Slots that still have no fixture definition, so a report can name the gap precisely. */
export function undefinedFixtures(entries: readonly ManifestEntry[]): readonly number[] {
  return entries.filter((entry) => entry.definitionPath === null).map((entry) => entry.id);
}
