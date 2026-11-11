import { posix as nodePath } from "node:path";

import { describe, expect, it } from "vitest";

import { path } from "../../src/shims/path.js";

/**
 * Differential fidelity test: our shim is compared against Node's own POSIX
 * `path` for every case. This is the cheapest honest way to prove a shim is
 * faithful — if the substrate (`pathe`) ever diverges, these tests fail loudly
 * instead of a user's build failing mysteriously three weeks later.
 *
 * Deviations that are REAL and accepted are listed explicitly with a why; they
 * are not silently skipped.
 */
const CASES: readonly string[] = [
  "",
  "/",
  ".",
  "..",
  "a",
  "a/b",
  "/a/b",
  "/a/b/",
  "a//b",
  "/a//b///c",
  "/a/./b",
  "/a/../b",
  "../a",
  "../../a/b",
  "a/b/../c",
  "/a/b/../../c",
  "a.txt",
  "/dir/file.tar.gz",
  "/dir/.hidden",
  "/dir/",
  "//server/share/path",
  "/a/b/",
  "a/",
  "/./",
  "/..",
];

describe("path shim vs node:path.posix", () => {
  it("normalize matches", () => {
    for (const c of CASES) expect(path.normalize(c), c).toBe(nodePath.normalize(c));
  });

  it("dirname matches", () => {
    for (const c of CASES) expect(path.dirname(c), c).toBe(nodePath.dirname(c));
  });

  it("basename matches", () => {
    for (const c of CASES) expect(path.basename(c), c).toBe(nodePath.basename(c));
  });

  it("basename with extension matches", () => {
    for (const c of CASES) expect(path.basename(c, ".gz"), c).toBe(nodePath.basename(c, ".gz"));
  });

  it("extname matches", () => {
    for (const c of CASES) expect(path.extname(c), c).toBe(nodePath.extname(c));
  });

  it("isAbsolute matches", () => {
    for (const c of CASES) expect(path.isAbsolute(c), c).toBe(nodePath.isAbsolute(c));
  });

  it("join matches for two-part joins", () => {
    for (const a of CASES) {
      for (const b of ["x", "../y", "/abs", "", "."]) {
        expect(path.join(a, b), `${a} + ${b}`).toBe(nodePath.join(a, b));
      }
    }
  });

  it("resolve matches for relative inputs", () => {
    for (const c of ["a", "a/b", "./a", "../a", "a/../b"]) {
      expect(path.resolve(c), c).toBe(nodePath.resolve(c));
    }
  });

  it("relative matches", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ["/a/b", "/a/b/c"],
      ["/a/b", "/a/c"],
      ["/a/b", "/a/b"],
      ["/", "/a"],
      ["/a/b/c", "/a"],
    ];
    for (const [from, to] of pairs) {
      expect(path.relative(from, to), `${from} -> ${to}`).toBe(nodePath.relative(from, to));
    }
  });

  it("exposes the POSIX separator constants Node documents", () => {
    expect(path.sep).toBe(nodePath.sep);
    expect(path.delimiter).toBe(nodePath.delimiter);
  });

  it("toNamespacedPath is the POSIX identity, as in Node", () => {
    for (const c of CASES) expect(path.toNamespacedPath(c), c).toBe(nodePath.toNamespacedPath(c));
  });
});

describe("the two namespaces Node hangs off path", () => {
  it("path.posix is the POSIX implementation itself, not a copy", () => {
    // Node's own arrangement, and the reason it has to be a real namespace rather than absent: rollup reads `path.posix.sep` at module
    // scope, so an undefined `posix` is a crash at import time rather than a fallback.
    expect(path.posix.normalize).toBe(path.normalize);
    expect(path.posix.join).toBe(path.join);
    expect(path.posix.sep).toBe(nodePath.sep);
    expect(path.posix.delimiter).toBe(nodePath.delimiter);
    for (const c of CASES) expect(path.posix.normalize(c), c).toBe(nodePath.normalize(c));
  });

  it("path.win32 exists and refuses by name, rather than answering POSIX rules", () => {
    // Answering POSIX paths under a Windows name would compute wrong paths quietly, which is the one outcome worse than a throw.
    expect(path.win32.sep).toBe("\\");
    expect(path.win32.delimiter).toBe(";");
    expect(typeof path.win32.join).toBe("function");
    let caught: unknown;
    try {
      path.win32.join("a", "b");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" });
    expect((caught as Error).message).toContain("path.win32.join is not implemented");
    expect((caught as Error).message).toContain("wrong path");
  });
});
