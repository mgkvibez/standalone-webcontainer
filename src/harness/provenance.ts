/**
 * What produced a piece of evidence, and whether a new run is allowed to replace it (W-27).
 *
 * The defect this closes: `.evidence/fixtures/<slug>/` was one slot per fixture and nothing in `verdict.txt` or `steps.json`
 * named the registry lane, the definition, or the run. Two consequences followed, both observed. A run against the wrong
 * registry silently replaced a passing result with a failure — that is how `fixture-08`'s committed evidence came to say
 * `SNAPSHOT_MISSING: express` while the docs said PASS. And two runs of the same fixture, in different lanes, on different
 * commits, were indistinguishable on disk once the second one had written.
 *
 * The rule here is deliberately narrow: a re-run in the SAME lane replaces (that is a measurement being repeated, and the
 * latest one is the truth). A run from a DIFFERENT lane is refused unless the caller says so explicitly, and evidence written
 * before provenance existed cannot be replaced at all without that same explicit word. Every run also gets its own record, so
 * "the latest" and "the one that happened" are separate facts.
 */

import type { TimeoutClass } from "./definition.js";

/** Bumped when a field changes meaning; evidence records at a different version are not comparable and say so. */
export const PROVENANCE_SCHEMA_VERSION = 1;

/**
 * The bundle's own version, which is a different fact from the provenance record's.
 *
 * 3 added the per-step HTTP observations. 4 adds `provenance.json` plus a per-run record: a consumer can observe the bundle
 * gaining a file, so it is announced here rather than silently appearing.
 */
export const EVIDENCE_SCHEMA_VERSION = 4;

/** The three lanes of `docs/audit/registry-lanes.md`. A lane is a claim about the bytes, so it is part of the identity. */
export type RegistryLane = "corpus" | "network" | "snapshot";

export interface SnapshotIdentity {
  /** The directory the snapshot was read from, relative to the repo, e.g. `fixtures/snapshots/express`. */
  readonly directory: string;
  /** `snapshot.json`'s `capturedAt`. Two snapshots of the same directory can hold different bytes. */
  readonly capturedAt?: string;
  /** SHA-256 of `snapshot.json`, so "the same snapshot" is a fact rather than a path. */
  readonly digest?: string;
  readonly packages?: number;
}

export interface RegistryProvenance {
  readonly lane: RegistryLane;
  /** What a reader should see: "offline corpus", "registry.npmjs.org", "fixtures/snapshots/express". */
  readonly label: string;
  /** Present on the snapshot lane only. */
  readonly snapshot?: SnapshotIdentity;
  /** `RegistryClient.origin`, when the registry reports one. Secondary evidence, never the identity. */
  readonly origin?: string;
}

export interface DefinitionProvenance {
  /** SHA-256 of the canonical payload — the same hash a freeze pin uses, so "which definition" and "which pin" agree. */
  readonly sha256: string;
  readonly formatVersion?: number;
  readonly steps: number;
  readonly assertions: number;
}

/** Everything a fixture run must be able to say about itself. */
export interface RunProvenance {
  readonly schemaVersion: number;
  /** Distinct per execution, so two runs never share an identity even in the same lane and commit. */
  readonly runId: string;
  readonly fixture: { readonly id: number; readonly slug: string; readonly lane: string };
  readonly definition: DefinitionProvenance;
  readonly harness: { readonly name: string; readonly version: string };
  readonly runtime?: { readonly name: string; readonly version?: string };
  /** The commit the tree was at, or `"unknown"` when the runner could not ask. Never a guess. */
  readonly commit: string;
  /**
   * Whether the tree had uncommitted changes when this run happened.
   *
   * A commit alone does not describe the code that produced a result: during this project's own W-27/W-28 work, eight fixtures were
   * re-run from a tree that was a dozen files ahead of the recorded commit. The verdicts were good and the reference was wrong, which
   * is the exact failure mode an audit cannot detect by reading evidence. `changedFiles: null` means git could not be asked, and is
   * never reported as "clean".
   */
  readonly tree: { readonly dirty: boolean; readonly changedFiles: number | null };
  /** The arguments the runner was invoked with, and the commands the fixture actually ran. */
  readonly command: { readonly argv: readonly string[]; readonly steps: readonly string[] };
  readonly registry: RegistryProvenance;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly budgets: Readonly<Record<TimeoutClass, number>>;
  readonly verdict: { readonly classification: string; readonly reason: string };
}

/** What a caller must supply; the parts a run can only know when it finishes are added by the runner. */
export interface RunProvenanceInput {
  readonly runId: string;
  readonly definition: DefinitionProvenance;
  readonly harness: RunProvenance["harness"];
  readonly runtime?: RunProvenance["runtime"];
  readonly commit: string;
  readonly tree?: RunProvenance["tree"];
  readonly command: RunProvenance["command"];
  readonly registry: RegistryProvenance;
  readonly budgets: Readonly<Record<TimeoutClass, number>>;
}

/**
 * The lane's identity, and the only thing that decides whether two results may share a directory.
 *
 * The lane NAME alone is not enough: two snapshots both live on the `snapshot` lane (`express`, `vite`) and swapping them
 * silently is the same defect one level down. The digest, when the caller can supply one, is what makes "the same bytes"
 * checkable; the directory is the fallback when it cannot.
 */
export function laneIdentity(registry: RegistryProvenance): string {
  if (registry.lane !== "snapshot") return `${registry.lane}:${registry.label}`;
  const snapshot = registry.snapshot;
  const where = snapshot?.digest ?? snapshot?.directory ?? registry.label;
  return `snapshot:${where}`;
}

export function sameLane(a: RegistryProvenance, b: RegistryProvenance): boolean {
  return laneIdentity(a) === laneIdentity(b);
}

export type EvidenceWriteCode = "LANE_CONFLICT" | "UNATTRIBUTED_EVIDENCE" | "FOREIGN_SCHEMA";

export type EvidenceWriteDecision =
  | { readonly action: "write"; readonly replaces: "nothing" | "same-lane" }
  | { readonly action: "refuse"; readonly code: EvidenceWriteCode; readonly message: string };

export interface EvidenceWriteRequest {
  /** The provenance already on disk for this fixture, or null when there is none. */
  readonly existing: RunProvenance | null;
  readonly incoming: RegistryProvenance;
  /**
   * `true` only when a human asked for it. It is the one way to replace evidence from another lane or from before
   * provenance existed, and it is deliberately a flag on the command line rather than a default.
   */
  readonly replaceForeign?: boolean;
}

/**
 * Decide whether this run may write over what is already in the fixture's directory.
 *
 * Order matters. An unattributed record is checked before a lane conflict because a schema-3 bundle has no lane to compare:
 * reporting "lane conflict" for it would invent a lane it never recorded.
 */
export function decideEvidenceWrite(request: EvidenceWriteRequest): EvidenceWriteDecision {
  const { existing, incoming, replaceForeign = false } = request;
  if (existing === null) return { action: "write", replaces: "nothing" };

  if (existing.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    if (replaceForeign) return { action: "write", replaces: "same-lane" };
    // Two different refusals, because they need two different decisions from a human. A bundle with no provenance cannot be
    // ATTRIBUTED to any lane — it is old evidence, and replacing it is normal housekeeping. A bundle whose record this runner
    // cannot read is evidence someone else wrote, and overwriting it would destroy a measurement nobody asked to drop.
    const unattributed = existing.schemaVersion === 0 || existing.registry === undefined;
    return {
      action: "refuse",
      code: unattributed ? "UNATTRIBUTED_EVIDENCE" : "FOREIGN_SCHEMA",
      message: unattributed
        ? "the evidence on disk was written before provenance existed, so it cannot be shown to be from the same lane; pass --replace-unattributed to replace it deliberately"
        : `the evidence on disk carries provenance schema ${existing.schemaVersion}, which this runner does not write (schema ${PROVENANCE_SCHEMA_VERSION}); refusing to overwrite evidence it cannot interpret`,
    };
  }

  if (!sameLane(existing.registry, incoming)) {
    if (replaceForeign) return { action: "write", replaces: "same-lane" };
    return {
      action: "refuse",
      code: "LANE_CONFLICT",
      message: `the evidence on disk came from the ${laneIdentity(existing.registry)} lane and this run used ${laneIdentity(incoming)}; a result must not be replaced by a run in another lane (pass --replace-lane to replace it deliberately)`,
    };
  }

  return { action: "write", replaces: "same-lane" };
}

/**
 * A run id that sorts chronologically and carries enough of the run to read at a glance.
 *
 * `randomUUID` rather than a counter: two runners in two worktrees share the evidence directory, and a counter would collide
 * exactly when someone is comparing them.
 */
export function makeRunId(startedAt: Date, definitionSha: string): string {
  const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const entropy = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${stamp}-${definitionSha.slice(0, 8)}-${entropy}`;
}

/** The file every evidence directory carries, and the glob for the per-run records beside it. */
export const PROVENANCE_FILE = "provenance.json";
export const RUNS_DIRECTORY = "runs";

/**
 * Thrown when a run may not write its evidence where it was pointed.
 *
 * A typed error rather than a boolean so the CLI can say which refusal it was and exit non-zero: silently skipping the write
 * would leave a run that measured something and recorded nothing, which is worse than either outcome.
 */
export class EvidenceRefusedError extends Error {
  constructor(
    readonly code: EvidenceWriteCode,
    message: string,
    readonly fixture: string,
  ) {
    super(`${fixture}: ${message}`);
    this.name = "EvidenceRefusedError";
  }
}
