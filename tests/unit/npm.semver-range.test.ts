/**
 * Differential tests against npm's own `semver`, which is a dev dependency and never shipped.
 *
 * Writing a range parser from expectations is how you end up with a package manager that silently picks the
 * wrong version for the one range shape you did not think of. So the assertions here are not my opinion of
 * semver: they are "agree with the implementation npm itself uses", over a matrix wide enough to include the
 * shapes I did not have in mind when I wrote it.
 *
 * The four rules in the source each get a named test as well, so a failure says which rule broke rather than
 * just "matrix mismatch".
 */

import { describe, expect, it } from "vitest";
import semver from "semver";

import { compareVersions, maxSatisfying, parseVersion, satisfies } from "../../src/npm/semver-range.js";

/** Versions chosen to include every boundary the rules care about: zeros, ones, prereleases, build tags. */
const VERSIONS = [
  "0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.1.0", "0.1.5", "0.2.3", "0.2.9", "0.3.0", "0.9.9",
  "1.0.0", "1.0.1", "1.1.0", "1.2.0", "1.2.3", "1.2.9", "1.3.0", "1.9.9", "2.0.0", "2.0.1",
  "3.0.0", "10.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.2.3-beta.1",
  "1.2.3-beta.11", "2.0.0-rc.1", "0.0.1-rc.1", "1.0.0+build.7", "1.0.0+build.9",
];

const RANGES = [
  "*", "", "1", "1.2", "1.2.3", "=1.2.3", "v1.2.3",
  "^1.2.3", "^1.2", "^1", "^0.2.3", "^0.0.3", "^0.0", "^0", "^2.0.0",
  "~1.2.3", "~1.2", "~1", "~0.2.3", "~0.0.1",
  ">=1.2.3", ">1.2.3", "<1.2.3", "<=1.2.3", ">1", ">1.2", "<1.2", "<=1.2",
  "1.2.x", "1.x", "1.2.*", "1.X",
  ">=1.0.0 <2.0.0", ">1.0.0 <=1.2.3", "^1.0.0 || ^2.0.0", "1.2.3 || 2.0.0",
  "1.2.3 - 2.0.0", "1.2 - 2.0", "1 - 2",
  ">=1.0.0-beta.1", "^1.0.0-alpha", "~1.2.3-beta.1", ">=1.2.3-beta.1 <2.0.0",
];

describe("satisfies agrees with npm's semver", () => {
  it("matches over the full version x range matrix", () => {
    const disagreements: string[] = [];
    for (const range of RANGES) {
      for (const candidate of VERSIONS) {
        const expected = semver.satisfies(candidate, range);
        const actual = satisfies(candidate, range);
        if (expected !== actual) {
          disagreements.push(`${range || "(empty)"} vs ${candidate}: expected ${expected}, got ${actual}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("matches for invalid input, which npm treats as no match rather than an error", () => {
    for (const range of ["not-a-range", ">= ", "^", "1.2.3.4", "^^1.0.0"]) {
      expect(satisfies("1.2.3", range), range).toBe(semver.satisfies("1.2.3", range));
    }
    expect(satisfies("not-a-version", "^1.0.0")).toBe(false);
  });
});

describe("compareVersions agrees with npm's semver", () => {
  it("orders every pair the same way, including prereleases and build metadata", () => {
    const disagreements: string[] = [];
    for (const left of VERSIONS) {
      for (const right of VERSIONS) {
        const expected = semver.compare(left, right);
        const actual = compareVersions(left, right);
        if (expected !== actual) disagreements.push(`${left} vs ${right}: expected ${expected}, got ${actual}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("treats build metadata as equal in precedence", () => {
    expect(compareVersions("1.0.0+build.7", "1.0.0+build.9")).toBe(0);
    expect(compareVersions("1.0.0+build.7", "1.0.1")).toBe(-1);
  });
});

describe("maxSatisfying", () => {
  it("picks the highest match, matching npm", () => {
    for (const range of RANGES) {
      const expected = semver.maxSatisfying(VERSIONS, range);
      expect(maxSatisfying(VERSIONS, range), range).toBe(expected);
    }
  });

  it("returns null when nothing matches", () => {
    expect(maxSatisfying(["1.0.0", "1.1.0"], "^2.0.0")).toBeNull();
  });
});

describe("the four rules, stated individually", () => {
  it("rule 1: a range without a prerelease does not admit one", () => {
    // The bug this prevents: installing an alpha because 1.3.0-beta.1 >= 1.0.0.
    expect(satisfies("1.3.0-beta.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.3.0-beta.1", ">=1.0.0")).toBe(false);
    // But a range that names a prerelease does admit that tuple.
    expect(satisfies("1.3.0-beta.2", ">=1.3.0-beta.1")).toBe(true);
    expect(satisfies("1.3.0-beta.2", "^1.3.0-beta.1")).toBe(true);
    // A prerelease on a different tuple is still excluded.
    expect(satisfies("2.0.0-rc.1", ">=1.3.0-beta.1")).toBe(false);
  });

  it("rule 2: caret bounds tighten as the major goes to zero", () => {
    expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  it("rule 3: a partial version is a range", () => {
    expect(satisfies("1.2.9", "1.2")).toBe(true);
    expect(satisfies("1.3.0", "1.2")).toBe(false);
    // >1.2 excludes the whole 1.2 gap rather than just 1.2.0.
    expect(satisfies("1.2.9", ">1.2")).toBe(false);
    expect(satisfies("1.3.0", ">1.2")).toBe(true);
    expect(satisfies("1.3.0", "<=1.2")).toBe(false);
  });

  it("rule 4: build metadata never affects precedence", () => {
    expect(satisfies("1.0.0+build.7", "1.0.0")).toBe(true);
    expect(satisfies("1.0.0+build.9", ">=1.0.0")).toBe(true);
  });
});

describe("parseVersion", () => {
  it("parses a full version with prerelease and build", () => {
    expect(parseVersion("1.2.3-beta.4+sha.abc")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", 4],
      build: "sha.abc",
    });
  });

  it("accepts a leading v, as manifests do", () => {
    expect(parseVersion("v1.2.3")?.major).toBe(1);
  });

  it("rejects a partial or malformed version, because comparison needs all three parts", () => {
    for (const text of ["1.2", "1", "1.2.3.4", "", "latest"]) {
      expect(parseVersion(text), text).toBeNull();
    }
  });
});

describe("ranges real packages publish", () => {
  // Measured, not invented: `safer-buffer` publishes `>= 2.1.2 < 3` and it appears twice in an express install. Splitting the
  // alternative on whitespace alone produced the token `>=`, which carries no version, so the range became unsatisfiable and the
  // installer reported NO_MATCHING_VERSION for a version that exists.
  const ranges = [">= 2.1.2 < 3", ">= 2.1.2 <3", ">=2.1.2 < 3", ">= 0.4 < 0.5", "> 1.2 < 2"];
  const versions = ["0.4.9", "1.0.0", "1.2.0", "1.3.0", "2.0.0", "2.1.1", "2.1.2", "2.9.9", "3.0.0"];

  it("agrees with npm's semver when an operator is separated from its version by a space", () => {
    for (const range of ranges) {
      for (const version of versions) {
        expect([range, version, satisfies(version, range)]).toEqual([range, version, semver.satisfies(version, range)]);
      }
    }
  });

  it("still answers the express case that exposed it", () => {
    expect(satisfies("2.1.2", ">= 2.1.2 < 3")).toBe(true);
    expect(satisfies("2.1.1", ">= 2.1.2 < 3")).toBe(false);
    expect(satisfies("3.0.0", ">= 2.1.2 < 3")).toBe(false);
  });
});
