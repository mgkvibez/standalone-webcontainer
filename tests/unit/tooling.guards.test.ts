/**
 * The project's own gates, tested like code.
 *
 * A guard that is never tested is a guard that quietly stops guarding: this repo already shipped a specified
 * forbidden-identifier check that did not exist. These cover the pure parts of the three tooling scripts.
 */

import { describe, expect, it } from "vitest";

import { countsFromReport, renderBlock, replaceBlock, START_MARKER, END_MARKER } from "../../tools/report/counts.js";
import { scanSource } from "../../tools/checks/identifiers.js";
import { auditLockfile, isAllowed, runtimeClosure, type Lockfile } from "../../tools/checks/licence-audit.js";

describe("test-count report", () => {
  it("counts files from testResults, not describe blocks", () => {
    const counts = countsFromReport({
      numTotalTestSuites: 201,
      testResults: [{}, {}, {}],
      numTotalTests: 705,
      numPassedTests: 705,
      numFailedTests: 0,
    });
    expect(counts.files).toBe(3);
    expect(counts.tests).toBe(705);
  });

  it("refuses an empty report instead of publishing a zero count", () => {
    expect(() => countsFromReport({ numTotalTests: 0 })).toThrow(/no tests/);
  });

  it("renders a block the README can carry and replaces it in place", () => {
    const block = renderBlock({ files: 50, tests: 705, passed: 705, failed: 0 });
    expect(block).toContain(START_MARKER);
    expect(block).toContain("705 tests passing");
    const readme = `before\n${block}\nafter`;
    const updated = replaceBlock(readme, renderBlock({ files: 50, tests: 706, passed: 706, failed: 0 }));
    expect(updated).toContain("706 tests passing");
    expect(updated.startsWith("before")).toBe(true);
    expect(updated.endsWith("after")).toBe(true);
  });

  it("fails loudly when the README lost its markers", () => {
    expect(() => replaceBlock("no markers here", "block")).toThrow(/markers/);
  });

  it("keeps a stale block stale rather than silently rewriting it", () => {
    const block = renderBlock({ files: 50, tests: 705, passed: 705, failed: 0 });
    const readme = `x\n${block}\ny`;
    const stale = replaceBlock(readme, renderBlock({ files: 50, tests: 700, passed: 700, failed: 0 }));
    expect(stale).not.toContain("705 tests passing");
    expect(END_MARKER).toBeTruthy();
  });
});

describe("forbidden-identifier guard", () => {
  const scan = (source: string) => scanSource(new Map([["src/x.ts", source]]));

  it("catches a trust-widening switch in source", () => {
    const hits = scan("const opts = { dangerouslyAllowSameOrigin: true };");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.identifier).toBe("dangerouslyAllowSameOrigin");
  });

  it("catches it without a prefix too, because the flag may be renamed", () => {
    expect(scan("if (allowSameOrigin) {}")).toHaveLength(1);
    expect(scan("skipOriginCheck = false;")).toHaveLength(1);
  });

  it("allows a comment that documents the ban when it says why", () => {
    expect(scan("// deliberately no allowSameOrigin here — guard-allow: explains the ban")).toHaveLength(0);
  });

  it("reports the line number, because a bare file name wastes a review", () => {
    const hits = scan("line one\nline two\nconst x = allowSameOrigin;");
    expect(hits[0]?.line).toBe(3);
  });

  it("does not match a longer identifier that merely contains the word", () => {
    expect(scan("const allowSameOriginByDefault = false;")).toHaveLength(1); // still the same concept
    expect(scan("const x = notTheFlagWeBan;")).toHaveLength(0);
  });
});

describe("licence audit", () => {
  const lock: Lockfile = {
    packages: {
      "": { dependencies: { runtimepkg: "^1.0.0" }, optionalDependencies: { optionalpkg: "^1.0.0" } },
      "node_modules/runtimepkg": { version: "1.0.0", license: "GPL-3.0", dependencies: { transitive: "^1.0.0" } },
      "node_modules/transitive": { version: "1.0.0", license: "MPL-2.0" },
      "node_modules/optionalpkg": { version: "1.0.0", license: "AGPL-3.0" },
      "node_modules/devpkg": { version: "1.0.0", license: "GPL-2.0" },
      "node_modules/okpkg": { version: "1.0.0", license: "MIT" },
      "node_modules/undocumented": { version: "2.0.0" },
    },
  };

  it("follows transitive and optional dependencies, not just direct ones", () => {
    const closure = runtimeClosure(lock);
    expect(closure.has("node_modules/runtimepkg")).toBe(true);
    expect(closure.has("node_modules/transitive")).toBe(true);
    expect(closure.has("node_modules/optionalpkg")).toBe(true);
    expect(closure.has("node_modules/devpkg")).toBe(false);
  });

  it("fails runtime violations and only prints dev-only ones", () => {
    // An explicit reader keeps this test off the filesystem, where "undocumented" does not exist.
    const audit = auditLockfile(lock, () => "MIT");
    expect(audit.runtime.map((f) => f.name).sort()).toEqual(["optionalpkg", "runtimepkg", "transitive"]);
    expect(audit.devOnly.map((f) => f.name)).toEqual(["devpkg"]);
  });

  it("falls back to the installed manifest when the lockfile omits the field", () => {
    const audit = auditLockfile(lock, (folder) => (folder === "undocumented" ? "Apache-2.0" : "unknown"));
    expect(audit.runtime.map((f) => f.name)).not.toContain("undocumented");
  });

  it("accepts every charter licence and rejects the copyleft ones", () => {
    for (const ok of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]) expect(isAllowed(ok, "x")).toBe(true);
    for (const bad of ["GPL-3.0", "AGPL-3.0", "MPL-2.0", "unknown"]) expect(isAllowed(bad, "x")).toBe(false);
  });
});
