/**
 * Freezing fixtures: pinning a definition so the gate cannot be satisfied by editing it afterwards.
 *
 * The scorer already refuses to count a `proposed` definition, which handles the honest case. It does not handle
 * the case the charter actually worries about: a definition that says `status: "frozen"` and has been quietly
 * edited since. Charter §4.9 forbids redefining the gate after results exist, and §4.10 forbids moving the
 * threshold, so "frozen means frozen" has to be checkable rather than asserted by whoever is reading it.
 *
 * The mechanism is a SHA-256 over the definition's content, recorded in the manifest. Verification recomputes it
 * and compares. Four states come out, and only one of them is scoreable:
 *
 * - `frozen`   content matches the pin. Scoreable.
 * - `unfrozen` still `proposed`; nobody has signed off. Not scoreable, not an integrity problem.
 * - `unpinned` claims to be frozen but the manifest records no pin, so nothing can be verified. Not scoreable:
 *              a frozen claim that cannot be checked is worth no more than a proposed one.
 * - `drifted`  content no longer matches the pin. Not scoreable, and `assertFreezeIntact` fails the run, because
 *              silently reducing the rate would hide the edit that caused it.
 *
 * Two deliberate choices, both for the audit rather than for me:
 *
 * 1. **The `status` field is excluded from the hash.** Freezing is a lifecycle transition, not a content change:
 *    the owner approves a definition by flipping `proposed` to `frozen`, and that must not invalidate the pin they
 *    just approved. Everything else is covered, including prose like `knownLimits`, because it informs how a
 *    result is read.
 * 2. **Canonical JSON, not the file bytes.** Key order and whitespace in a JSON file are not content, and hashing
 *    raw bytes would make a reformat look like tampering while a reordered semantic change slipped through.
 */

import type { FixtureDefinition } from "./definition.js";
import type { ManifestEntry } from "./manifest.js";
import { scoreGate, type GateReport } from "./score.js";
import type { FixtureOutcome } from "./types.js";

export type FreezeState = "frozen" | "unfrozen" | "unpinned" | "drifted";

export interface FreezeCheck {
  readonly id: number;
  readonly state: FreezeState;
  /** The pin recorded in the manifest, or null when there is none. */
  readonly expected: string | null;
  /** What the definition hashes to now. Always present, so a report can show the pair. */
  readonly actual: string;
}

/** Recursively order object keys. Array order is semantic and is left alone. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalize(source[key]);
    return ordered;
  }
  return value;
}

/**
 * The exact text a definition is pinned by.
 *
 * Exported so a test can assert what is and is not covered without reimplementing the rule, and so an authoring
 * tool hashes the same text the verifier does.
 */
export function definitionPayload(definition: FixtureDefinition): string {
  const { status: _lifecycle, ...content } = definition;
  return JSON.stringify(canonicalize(content));
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    // A browser without WebCrypto cannot verify a pin, and pretending otherwise would turn "unverifiable" into
    // "verified". Better to stop than to score on a promise.
    throw new Error("crypto.subtle is unavailable, so a fixture definition cannot be pinned or verified");
  }
  const digest = await subtle.digest("SHA-256", encoder.encode(text));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The pin for a definition: SHA-256 of its canonical content, lowercase hex. */
export async function hashDefinition(definition: FixtureDefinition): Promise<string> {
  return sha256Hex(definitionPayload(definition));
}

/**
 * Compare one definition against the pin the manifest records for it.
 *
 * The order of the checks is the point: `proposed` is reported as unfrozen even if a stale pin is present, because
 * a lifecycle label wins over a hash left behind by an earlier attempt.
 */
export async function checkFreeze(
  entry: ManifestEntry,
  definition: FixtureDefinition,
): Promise<FreezeCheck> {
  const actual = await hashDefinition(definition);
  if (definition.status !== "frozen") {
    return { id: entry.id, state: "unfrozen", expected: entry.frozenHash, actual };
  }
  if (entry.frozenHash === null) {
    return { id: entry.id, state: "unpinned", expected: null, actual };
  }
  return {
    id: entry.id,
    state: entry.frozenHash === actual ? "frozen" : "drifted",
    expected: entry.frozenHash,
    actual,
  };
}

/**
 * Fail the run when a definition was edited after it was frozen.
 *
 * `unfrozen` is not an integrity failure, so it is not this function's business: it means the corpus is still being
 * written, which the gate reports as missing rather than as corruption.
 */
export function assertFreezeIntact(checks: readonly FreezeCheck[]): void {
  const drifted = checks.filter((check) => check.state === "drifted");
  if (drifted.length > 0) {
    const detail = drifted
      .map((check) => `fixture ${check.id} pinned ${check.expected ?? "?"} but now hashes ${check.actual}`)
      .join("; ");
    throw new Error(`frozen fixture definitions were edited: ${detail}`);
  }
  const unpinned = checks.filter((check) => check.state === "unpinned");
  if (unpinned.length > 0) {
    const ids = unpinned.map((check) => check.id).join(", ");
    throw new Error(`fixtures claim to be frozen but the manifest holds no pin for: ${ids}`);
  }
}

export interface VerifiedScoring {
  readonly gate: GateReport;
  readonly freezes: readonly FreezeCheck[];
  /** Fixtures that produced an outcome but were withheld from the gate, with the reason. */
  readonly withheld: readonly { readonly id: number; readonly state: FreezeState }[];
}

/**
 * Score only what can be verified.
 *
 * Exists so that withholding a drifted fixture is the default rather than something a caller remembers to do: the
 * gate is computed from verified fixtures only, and anything withheld is listed alongside it. A withheld front-end
 * fixture still blocks the gate, because the charter's rate is over all fifteen.
 */
export async function scoreVerifiedFixtures(input: {
  readonly fixtures: readonly { readonly entry: ManifestEntry; readonly definition: FixtureDefinition }[];
  readonly outcomes: readonly FixtureOutcome[];
}): Promise<VerifiedScoring> {
  const freezes: FreezeCheck[] = [];
  for (const { entry, definition } of input.fixtures) {
    if (entry.id !== definition.id) {
      throw new Error(`manifest slot ${entry.id} was paired with definition ${definition.id}`);
    }
    freezes.push(await checkFreeze(entry, definition));
  }

  const scoreable = new Set(freezes.filter((check) => check.state === "frozen").map((check) => check.id));
  const withheld = input.outcomes
    .filter((outcome) => !scoreable.has(outcome.fixture.id))
    .map((outcome) => {
      const check = freezes.find((candidate) => candidate.id === outcome.fixture.id);
      // An outcome for a fixture with no definition cannot be verified at all; `unfrozen` is the closest truthful
      // state, since nothing about it has been approved.
      return { id: outcome.fixture.id, state: check?.state ?? "unfrozen" } as const;
    })
    .sort((a, b) => a.id - b.id);

  const counted = input.outcomes.filter((outcome) => scoreable.has(outcome.fixture.id));
  return { gate: scoreGate(counted), freezes: freezes.sort((a, b) => a.id - b.id), withheld };
}
