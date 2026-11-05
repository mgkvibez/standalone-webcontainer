/**
 * The vocabulary the charter fixes for scoring a run (README §4.7 and §5).
 *
 * These values are the contract for every scored run, so they live in one place: a report can only
 * use a classification that exists here, and adding one is a charter change, not an implementation
 * detail.
 */

/** Charter §4.7. A wrong API call in the harness is HARNESS_BUG, never a runtime failure. */
export type Classification =
  | "PASS"
  | "RUNTIME_INCOMPATIBILITY"
  | "HARNESS_BUG"
  | "NETWORK"
  | "TIMEOUT"
  | "INVALID_BASELINE"
  | "UNSUPPORTED_BY_DESIGN";

export const CLASSIFICATIONS: readonly Classification[] = [
  "PASS",
  "RUNTIME_INCOMPATIBILITY",
  "HARNESS_BUG",
  "NETWORK",
  "TIMEOUT",
  "INVALID_BASELINE",
  "UNSUPPORTED_BY_DESIGN",
];

/**
 * Charter §5. The gate only ever counts the first lane; the second is reported so the expert can
 * decide whether those fixtures belong in the browser lane at all.
 */
export type Lane = "front-end-only" | "boundary";

/** A numbered slot in the pre-registered twenty. `slug` is how it appears on disk. */
export interface FixtureSlot {
  readonly id: number;
  readonly slug: string;
  readonly lane: Lane;
}

/**
 * One scored result. `evidenceDir` is required rather than optional because charter §4.8 forbids a
 * summary without evidence on disk: a result with nowhere to point is not a result.
 */
export interface FixtureOutcome {
  readonly fixture: FixtureSlot;
  readonly classification: Classification;
  readonly evidenceDir: string;
}

/**
 * Charter §4.5 hard timeouts. Values transcribed from the charter, not tuned here; ADR-0003 makes
 * the liveness-window constants tuning, but these three are stated outright.
 */
export const TIMEOUTS = {
  installMs: 180_000,
  buildMs: 240_000,
  runMs: 60_000,
} as const;

export function isClassification(value: string): value is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value);
}
