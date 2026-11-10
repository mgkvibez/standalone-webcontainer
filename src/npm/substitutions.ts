/**
 * Packages whose published build cannot run here, and what to serve in their place.
 *
 * This is data, not code. Every entry is a row a person can read, diff and add without touching the resolver, because the second
 * substitution costs the same as the first and the twentieth must not need a twentieth code path.
 *
 * The first entry exists because of a measured structural fact: `esbuild` declares its platform binaries as optional dependencies and
 * then spawns one through `child_process` at module scope (`lib/main.js`, the head of the bundled `lib/npm/node.ts`), so merely
 * loading its JS API asks for a native process. `esbuild-wasm` is the same codebase compiled to WebAssembly, on the same version line,
 * with no dependencies at all. Serving it under the requested name means Node's directory-based resolution finds it where the caller
 * looks, and a package that says `require('esbuild')` needs no knowledge of the substitution.
 */

/** How the substitute's version is chosen. */
export type SubstitutionRule =
  /** The caller's own range, resolved against the substitute's versions. Correct when the two version lines move together. */
  | "range"
  /** One exact version, whatever the caller asked for. */
  | "exact"
  /** The substitute's newest version. A last resort: it ignores what the dependent can actually use. */
  | "latest";

export interface Substitution {
  /** The package as written in someone's dependency list. */
  readonly requested: string;
  /** The package whose bytes are served instead. */
  readonly substitute: string;
  readonly rule: SubstitutionRule;
  /** Required when `rule` is "exact"; refused otherwise, so a forgotten pin cannot silently behave like "range". */
  readonly pinnedVersion?: string;
  /**
   * A runtime hook the loaded module needs before it can be used, by name.
   *
   * `esbuild-wasm` must be `initialize()`d with its .wasm bytes before any API call, and callers (Vite among them) never do it. Named
   * here rather than called here: installing bytes and running a module's startup are different layers, and the runtime is the one that
   * can supply the binary.
   */
  readonly initHook?: string;
  /** Why this substitution exists, in words that will end up in a resolution trace and in a user's install log. */
  readonly reason: string;
}

/** One substitution actually applied during an install: what was asked for and what happened. */
export interface SubstitutionUse {
  readonly requested: string;
  readonly substitute: string;
  readonly rule: SubstitutionRule;
  readonly requestedRange: string;
  readonly version: string;
  readonly reason: string;
  readonly initHook?: string;
}

export class SubstitutionError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SubstitutionError";
    this.code = code;
  }
}

/**
 * The table.
 *
 * Entry one is `esbuild`. Everything after it will be added for the same kind of reason (a native binary, a platform SDK, a build-time
 * child process), and none of them should require a resolver change.
 */
export const SUBSTITUTIONS: readonly Substitution[] = [
  {
    requested: "esbuild",
    substitute: "esbuild-wasm",
    rule: "range",
    initHook: "esbuild-wasm:initialize",
    reason:
      "native esbuild spawns its platform binary from child_process at module scope; esbuild-wasm is the same codebase compiled to WebAssembly, on a matching version line, with no dependencies",
  },
];

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Validate a table before anyone resolves against it.
 *
 * Refuses the two ways a table rots: a row that names itself or points at another row's requested name (a chain, whose behaviour would
 * depend on iteration order), and a rule that cannot be honoured as written.
 */
export function parseSubstitutions(table: readonly Substitution[]): readonly Substitution[] {
  const requestedNames = new Set<string>();
  const substituted = new Set<string>();

  for (const entry of table) {
    if (!PACKAGE_NAME.test(entry.requested)) {
      throw new SubstitutionError("INVALID_REQUESTED_NAME", `${JSON.stringify(entry.requested)} is not a package name`);
    }
    if (!PACKAGE_NAME.test(entry.substitute)) {
      throw new SubstitutionError("INVALID_SUBSTITUTE_NAME", `${JSON.stringify(entry.substitute)} is not a package name`);
    }
    if (entry.requested === entry.substitute) {
      throw new SubstitutionError("SELF_SUBSTITUTION", `${entry.requested} cannot substitute for itself`);
    }
    if (requestedNames.has(entry.requested)) {
      throw new SubstitutionError("DUPLICATE_SUBSTITUTION", `${entry.requested} appears more than once`);
    }
    if (entry.reason.trim() === "") {
      throw new SubstitutionError("MISSING_REASON", `${entry.requested}: a substitution without a reason cannot be reviewed`);
    }
    if (entry.rule === "exact") {
      if (entry.pinnedVersion === undefined || !VERSION.test(entry.pinnedVersion)) {
        throw new SubstitutionError(
          "MISSING_PIN",
          `${entry.requested}: rule "exact" needs a pinnedVersion, and ${JSON.stringify(entry.pinnedVersion)} is not one`,
        );
      }
    } else if (entry.pinnedVersion !== undefined) {
      throw new SubstitutionError(
        "UNUSED_PIN",
        `${entry.requested}: pinnedVersion is set but rule is "${entry.rule}"; a pin that is ignored is worse than none`,
      );
    }

    requestedNames.add(entry.requested);
    substituted.add(entry.substitute);
  }

  for (const entry of table) {
    if (requestedNames.has(entry.substitute)) {
      throw new SubstitutionError(
        "CHAINED_SUBSTITUTION",
        `${entry.requested} -> ${entry.substitute}, which is itself substituted; a chain's outcome would depend on iteration order`,
      );
    }
  }

  return Object.freeze(table.map((entry) => Object.freeze({ ...entry })));
}

const TABLE: readonly Substitution[] = parseSubstitutions(SUBSTITUTIONS);
const BY_REQUESTED = new Map(TABLE.map((entry) => [entry.requested, entry]));

/** The row for a package name, if it has one. */
export function substitutionFor(name: string): Substitution | undefined {
  return BY_REQUESTED.get(name);
}

/** The range to resolve against the substitute's versions. */
export function resolvedRange(entry: Substitution, requestedRange: string): string {
  if (entry.rule === "exact") return entry.pinnedVersion ?? requestedRange;
  if (entry.rule === "latest") return "*";
  return requestedRange;
}
