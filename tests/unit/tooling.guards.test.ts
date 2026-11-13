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
import {
  collectConsumers,
  collectLane,
  ENTRIES,
  findStranded,
  problemsWithDeclarations,
  type Declaration,
} from "../../tools/checks/module-reachability.js";

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

/**
 * The dead-module guard.
 *
 * P0-6 is the reason this exists, so the most important case here is the one that reproduces its shape: a protocol
 * module imported only by an integration module, which itself is imported only by a test. A one-hop "does anything in
 * src import me" check calls the protocol live. This guard must not, and the second test is that regression.
 */
describe("dead-module guard", () => {
  const tree = (
    src: Record<string, string>,
    options: { tools?: Record<string, string>; tests?: Record<string, string> } = {},
  ) =>
    collectConsumers({
      src: new Map(Object.entries(src)),
      tools: new Map(Object.entries(options.tools ?? {})),
      tests: new Map(Object.entries(options.tests ?? {})),
    });

  it("reports a module whose only audience is a test", () => {
    const consumers = tree(
      { "src/shims/presets.ts": "export const x = 1;\n" },
      { tests: { "tests/unit/presets.test.ts": 'import { x } from "../../src/shims/presets.js";\n' } },
    );
    const stranded = findStranded(consumers, [], "src/");
    expect(stranded.map((f) => f.module)).toEqual(["src/shims/presets.ts"]);
    expect(stranded[0]?.kind).toBe("test-only");
    expect(stranded[0]?.tests).toEqual(["tests/unit/presets.test.ts"]);
  });

  it("reports the module behind a stranded module, which a one-hop check would call live (the P0-6 shape)", () => {
    const consumers = tree(
      {
        "src/runtime/envelope.ts": "export const protocol = 1;\n",
        "src/shims/presets.ts": 'import { protocol } from "../runtime/envelope.js";\n',
      },
      { tests: { "tests/unit/presets.test.ts": 'import "../../src/shims/presets.js";\n' } },
    );
    expect(findStranded(consumers, [], "src/").map((f) => f.module)).toEqual([
      "src/runtime/envelope.ts",
      "src/shims/presets.ts",
    ]);
  });

  it("keeps a module that a tool imports, and everything that tool's module reaches", () => {
    const consumers = tree(
      { "src/harness/freeze.ts": "export const f = 1;\n", "src/harness/manifest.ts": "export const m = 1;\n" },
      { tools: { "tools/freeze-corpus.ts": 'import "../../src/harness/freeze.js";\n' } },
    );
    // freeze.ts is a root because a tool imports it; manifest.ts is not reachable, so it is the only finding.
    expect(findStranded(consumers, [], "src/").map((f) => f.module)).toEqual(["src/harness/manifest.ts"]);
  });

  it("counts a Worker built from a URL as a consumer, because nothing imports a Worker entry", () => {
    const consumers = tree(
      {
        "src/process/process-worker.ts": "export const w = 1;\n",
        "src/process/process-host.ts":
          'const worker = new Worker(new URL("./process-worker.ts", import.meta.url));\n',
      },
      { tests: { "tests/unit/host.test.ts": 'import "../../src/process/process-host.js";\n' } },
    );
    // Both are stranded while the host's only audience is a test: the Worker is reachable only through a dead importer.
    expect(findStranded(consumers, [], "src/").map((f) => f.module)).toEqual([
      "src/process/process-host.ts",
      "src/process/process-worker.ts",
    ]);
    // Give the host a real consumer and both go live, which only holds if the URL form resolved as an edge.
    const withTool = tree(
      {
        "src/process/process-worker.ts": "export const w = 1;\n",
        "src/process/process-host.ts":
          'const worker = new Worker(new URL("./process-worker.ts", import.meta.url));\n',
      },
      { tools: { "tools/probe.ts": 'import "../../src/process/process-host.js";\n' } },
    );
    expect(findStranded(withTool, [], "src/")).toEqual([]);
  });

  it("distinguishes an orphan from a test-only module", () => {
    const consumers = tree({ "src/process/base64.ts": "export const b = 1;\n" });
    const stranded = findStranded(consumers, [], "src/");
    expect(stranded).toEqual([{ module: "src/process/base64.ts", kind: "orphan", tests: [] }]);
  });

  it("never judges tools/, where nothing importing a CLI is the normal state", () => {
    const consumers = tree(
      { "src/a.ts": "export {};\n" },
      {
        tools: {
          "tools/probe-timer.ts": 'import "../src/a.js";\n',
          "tools/verify/deployment.ts": "export {};\n",
        },
      },
    );
    // a.ts is live because a probe imports it; neither CLI is reported, because running a script on purpose is not a defect.
    expect(findStranded(consumers, [], "src/")).toEqual([]);
    expect(findStranded(consumers, [], "tools/").map((f) => f.module)).toEqual([
      "tools/probe-timer.ts",
      "tools/verify/deployment.ts",
    ]);
  });

  it("refuses a stranded declaration with no register row, or one naming a module that is gone", () => {
    const consumers = tree({ "src/a.ts": "export {};\n" });
    const undocumented: Declaration[] = [{ module: "src/a.ts", kind: "known-stranded", reason: "parked" }];
    const stale: Declaration[] = [{ module: "src/gone.ts", kind: "known-stranded", reason: "parked", register: "W-37" }];
    expect(problemsWithDeclarations(consumers, undocumented)).toEqual([
      "src/a.ts: a known-stranded declaration must cite a register row",
    ]);
    expect(problemsWithDeclarations(consumers, stale)).toContain("src/gone.ts: declared, but no such module exists");
  });

  it("passes on this repository, which is the claim the gate makes", () => {
    const consumers = collectConsumers({
      src: collectLane("src"),
      tools: collectLane("tools"),
      tests: collectLane("tests"),
    });
    expect(findStranded(consumers, ENTRIES)).toEqual([]);
    expect(problemsWithDeclarations(consumers, ENTRIES)).toEqual([]);
    // The declared entries must still be real: a declaration for a deleted module is how an exemption outlives its reason.
    expect(ENTRIES.every((entry) => consumers.has(entry.module))).toBe(true);
  });
});
