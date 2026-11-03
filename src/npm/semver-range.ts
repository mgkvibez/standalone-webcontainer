/**
 * Semantic versioning: comparison and range satisfaction, implemented rather than imported.
 *
 * `semver` is npm's own implementation and would be the obvious dependency. It is kept out of `src/` on
 * purpose: it ships to the browser inside the runtime bundle, and a package manager needs a specific
 * subset of its behaviour, not all of it. Instead it is a **dev** dependency used only to verify this
 * module differentially against the real thing, which is the same method used for the `path` shim and
 * which caught three real deviations there.
 *
 * The rules that are easy to get wrong, and are therefore spelled out:
 *
 * 1. **Prereleases are excluded from ranges that do not mention one.** `1.3.0-beta.1` does *not* satisfy
 *    `^1.0.0`, even though `1.3.0-beta.1 < 1.3.0` is false and `1.3.0-beta.1 >= 1.0.0` is true. A range
 *    admits a prerelease only if some comparator in it names a prerelease on the same
 *    major.minor.patch. This is the rule that makes `npm install` of an alpha not silently happen.
 * 2. **Caret with a zero major bounds differently.** `^0.2.3` is `>=0.2.3 <0.3.0`, not `<1.0.0`, because
 *    in 0.x the minor is the breaking axis. `^0.0.3` is `<0.0.4`.
 * 3. **A partial version is a range, not a version.** `1.2` means `>=1.2.0 <1.3.0`, and `>1.2` means
 *    `>=1.3.0`, not `>1.2.0`.
 * 4. **Build metadata is ignored in comparison.** `1.0.0+build7` and `1.0.0+build9` are equal in
 *    precedence, so range checks must not distinguish them.
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, already split. Empty means a normal release. */
  readonly prerelease: readonly (string | number)[];
  /** Build metadata, kept for display only. Never used in comparison. */
  readonly build: string;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

function splitIdentifiers(text: string): readonly (string | number)[] {
  if (text === "") return [];
  return text.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** Parse a full `x.y.z[-pre][+build]`. Returns null for anything that is not a complete version. */
export function parseVersion(text: string): Version | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, major, minor, patch, prerelease, build] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: splitIdentifiers(prerelease ?? ""),
    build: build ?? "",
  };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNumeric = typeof a === "number";
  const bNumeric = typeof b === "number";
  // Numeric identifiers always sort before alphanumeric ones.
  if (aNumeric && !bNumeric) return -1;
  if (!aNumeric && bNumeric) return 1;
  if (aNumeric && bNumeric) return a === b ? 0 : a < b ? -1 : 1;
  const aText = String(a);
  const bText = String(b);
  return aText === bText ? 0 : aText < bText ? -1 : 1;
}

/** Semver precedence. Build metadata is ignored, as the specification requires. */
export function compareVersions(a: Version | string, b: Version | string): number {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (left === null || right === null) throw new TypeError("compareVersions requires full versions");

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  // A release sorts above any of its prereleases.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = left.prerelease[index];
    const bPart = right.prerelease[index];
    // A shorter prerelease list sorts lower when all shared identifiers are equal.
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const comparison = compareIdentifiers(aPart, bPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

interface Partial {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: readonly (string | number)[];
}

const PARTIAL_PATTERN = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

function parsePartial(text: string): Partial | null {
  const match = PARTIAL_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  const numeric = (value: string | undefined): number | null => {
    if (value === undefined || value === "x" || value === "X" || value === "*") return null;
    return Number(value);
  };
  return {
    major: numeric(major),
    minor: numeric(minor),
    patch: numeric(patch),
    prerelease: splitIdentifiers(prerelease ?? ""),
  };
}

interface Comparator {
  readonly operator: "=" | ">" | ">=" | "<" | "<=";
  readonly version: Version;
}

function version(major: number, minor: number, patch: number, prerelease: readonly (string | number)[] = []): Version {
  return { major, minor, patch, prerelease, build: "" };
}

/** The exclusive upper bound for a caret or tilde range over a possibly-partial version. */
function upperBoundForCaret(partial: Partial): Version {
  const { major, minor, patch } = partial;
  if (major === null) return version(Infinity, 0, 0);
  // With only a major given, the bound is always the next major, including ^0 (<1.0.0): a missing minor
  // means the range spans the whole line, verified against npm rather than assumed.
  if (minor === null) return version(major + 1, 0, 0);
  if (major > 0) return version(major + 1, 0, 0);
  // major === 0 with a minor given: the minor is the breaking axis, so bounds tighten as zeros go deeper.
  if (minor > 0) return version(0, minor + 1, 0); // ^0.2.3 -> <0.3.0
  if (patch === null) return version(0, 1, 0); // ^0.0 -> <0.1.0
  return version(0, 0, patch + 1); // ^0.0.3 -> <0.0.4
}

function comparatorsFor(token: string): Comparator[] | null {
  // A wildcard on its own admits everything that is a real version.
  // Dist-tags like `latest` are not range syntax: they are resolved by the registry layer, and treating
  // them as a wildcard here would silently install the wrong version when a tag points at an old release.
  if (token === "" || token === "*" || token === "x" || token === "X") {
    return [{ operator: ">=", version: version(0, 0, 0) }];
  }

  const operatorMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (operatorMatch === null) return null;
  const operator = operatorMatch[1] ?? "";
  const body = operatorMatch[2] ?? "";
  const partial = parsePartial(body);
  if (partial === null) return null;

  const { major, minor, patch, prerelease } = partial;
  const floor = version(major ?? 0, minor ?? 0, patch ?? 0, prerelease);

  if (operator === "^") {
    return [
      { operator: ">=", version: floor },
      { operator: "<", version: upperBoundForCaret(partial) },
    ];
  }

  if (operator === "~") {
    // ~1.2.3 is >=1.2.3 <1.3.0; ~1.2 is >=1.2.0 <1.3.0; ~1 is >=1.0.0 <2.0.0.
    if (major === null) return [{ operator: ">=", version: floor }];
    const upper = minor === null ? version(major + 1, 0, 0) : version(major, minor + 1, 0);
    return [
      { operator: ">=", version: floor },
      { operator: "<", version: upper },
    ];
  }

  if (operator === "" || operator === "=") {
    // A bare partial is an x-range: 1.2 means >=1.2.0 <1.3.0, not the single version 1.2.0.
    if (major === null) return [{ operator: ">=", version: floor }];
    if (minor === null) {
      return [
        { operator: ">=", version: floor },
        { operator: "<", version: version(major + 1, 0, 0) },
      ];
    }
    if (patch === null) {
      return [
        { operator: ">=", version: floor },
        { operator: "<", version: version(major, minor + 1, 0) },
      ];
    }
    return [{ operator: "=", version: floor }];
  }

  // `>1.2` means >=1.3.0 and `<=1.2` means <1.3.0: a partial bound is exclusive of its own gap.
  if (operator === ">") {
    if (minor === null) return [{ operator: ">=", version: version((major ?? 0) + 1, 0, 0) }];
    if (patch === null) return [{ operator: ">=", version: version(major ?? 0, minor + 1, 0) }];
    return [{ operator: ">", version: floor }];
  }
  if (operator === ">=") return [{ operator: ">=", version: floor }];
  if (operator === "<") return [{ operator: "<", version: floor }];
  if (operator === "<=") {
    if (patch === null && minor !== null) return [{ operator: "<", version: version(major ?? 0, minor + 1, 0) }];
    return [{ operator: "<=", version: floor }];
  }

  return null;
}

function matchesComparator(candidate: Version, comparator: Comparator): boolean {
  const comparison = compareVersions(candidate, comparator.version);
  switch (comparator.operator) {
    case "=":
      return comparison === 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
  }
}

/** Split a range into its AND-sets, expanding hyphen ranges before tokenising. */
function alternatives(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alternative of range.split("||")) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alternative);
    const tokens = hyphen === null ? alternative.trim().split(/\s+/).filter((token) => token !== "") : null;

    let comparators: Comparator[] = [];
    if (hyphen !== null) {
      const low = parsePartial(hyphen[1] ?? "");
      const high = parsePartial(hyphen[2] ?? "");
      if (low === null || high === null) return null;
      comparators.push({ operator: ">=", version: version(low.major ?? 0, low.minor ?? 0, low.patch ?? 0) });
      // The high end of a partial hyphen range includes the whole gap.
      const highUpper =
        high.patch === null && high.major !== null
          ? high.minor === null
            ? version(high.major + 1, 0, 0)
            : version(high.major, high.minor + 1, 0)
          : version(high.major ?? 0, high.minor ?? 0, high.patch ?? 0);
      comparators.push(
        high.patch === null && high.major !== null
          ? { operator: "<", version: highUpper }
          : { operator: "<=", version: highUpper },
      );
    } else {
      for (const token of tokens ?? []) {
        const parsed = comparatorsFor(token);
        if (parsed === null) return null;
        comparators = comparators.concat(parsed);
      }
    }
    sets.push(comparators);
  }
  return sets;
}

/**
 * Does `candidate` satisfy `range`?
 *
 * Returns false for an unparseable range rather than throwing: a bad range in a package's manifest must be
 * skipped, not crash an install, and the caller cannot distinguish "no match" from "impossible range" in
 * any useful way.
 */
export function satisfies(candidate: string | Version, range: string): boolean {
  const parsed = typeof candidate === "string" ? parseVersion(candidate) : candidate;
  if (parsed === null) return false;
  const sets = alternatives(range);
  if (sets === null) return false;

  return sets.some((comparators) => {
    if (!comparators.every((comparator) => matchesComparator(parsed, comparator))) return false;
    // Rule 1, applied to the whole AND-set rather than to each comparator. Putting it inside the loop made a
    // wildcard (`*`, which lowers to zero comparators) admit every prerelease, since the check never ran.
    if (parsed.prerelease.length === 0) return true;
    return comparators.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === parsed.major &&
        comparator.version.minor === parsed.minor &&
        comparator.version.patch === parsed.patch,
    );
  });
}

/** The highest version in `versions` that satisfies `range`, or null. Prereleases are excluded by rule 1. */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (satisfies(candidate, range) && (best === null || compareVersions(candidate, best) > 0)) best = candidate;
  }
  return best;
}
