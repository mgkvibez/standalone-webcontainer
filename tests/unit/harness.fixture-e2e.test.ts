/**
 * One definition, run for real: install from a registry, execute a program, evaluate assertions, write evidence.
 *
 * This is the composition test for the whole harness stack. The unit tests above prove each piece in isolation; this
 * one proves they fit, and it is the shape every fixture will take once the corpus is frozen.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { createStepExecutor } from "../../src/harness/execute.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import type { FileSystem } from "../../src/vfs/index.js";
import { createFakeRegistry } from "../helpers/registry.js";
import { bootVfs, exists, text } from "../helpers/vfs.js";

const scratch = mkdtempSync(join(tmpdir(), "swc-fixture-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const definition: FixtureDefinition = parseDefinition({
  formatVersion: 1,
  id: 1,
  slug: "fixture-01",
  lane: "front-end-only",
  title: "A dependency installs and a script that requires it exits 0",
  intent: "Proves the shortest useful path: resolve, install, execute, assert.",
  source: "harness integration test",
  status: "frozen",
  steps: [
    { kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the dependency" },
    { kind: "run", command: "node scripts/check.js", timeoutClass: "run", purpose: "Run a program requiring it" },
  ],
  assertions: [
    { kind: "exit-code", step: 1, equals: 0 },
    { kind: "file-exists", step: 1, target: "/app/node_modules/greeter/index.js" },
    { kind: "stdout-contains", step: 1, contains: "greeter@1.2.0" },
  ],
  expected: ["PASS"],
});

/** The VFS as the assertion environment sees it, plus an HTTP probe that should never be reached. */
function environmentFor(vfs: FileSystem): AssertionEnvironment {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return text(vfs, path);
      } catch {
        return null;
      }
    },
    async request(): Promise<never> {
      throw new Error("no fixture in this test makes an HTTP request");
    },
  };
}

  it("runs npm run, which reaches the bin an installed package provides", async () => {
    // The chain under test: package.json script -> command interpreter -> bin lookup in node_modules -> the runtime
    // loading a file that starts with a shebang. Anything broken in that chain fails here rather than at gate time.
    const { vfs, root } = bootVfs();
    vfs.writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ name: "app", scripts: { start: "tool --loud" }, dependencies: { tool: "^1.0.0" } }, null, 2),
    );

    const registry = await createFakeRegistry({
      packages: {
        tool: [
          {
            version: "1.0.0",
            bin: { tool: "cli.js" },
            files: {
              "cli.js": "#!/usr/bin/env node\nconsole.log('tool v1 ' + process.argv.slice(2).join(','));",
            },
          },
        ],
      },
    });
    const runtime = new InProcessRuntime(vfs);

    const scripted: FixtureDefinition = parseDefinition({
      formatVersion: 1,
      id: 18,
      slug: "fixture-18",
      lane: "front-end-only",
      title: "npm run reaches an installed bin",
      intent: "Proves a package.json script resolves through node_modules to a file the runtime can start.",
      source: "harness integration test",
      status: "frozen",
      steps: [
        { kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the tool" },
        { kind: "run", command: "npm run start", timeoutClass: "run", purpose: "Run the project's start script" },
      ],
      assertions: [
        { kind: "exit-code", step: 1, equals: 0 },
        { kind: "stdout-contains", step: 1, contains: "tool v1 --loud" },
      ],
      expected: ["PASS"],
    });

    const report = await runFixture({
      definition: scripted,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: null,
    });

    expect(report.steps.map((entry) => entry.termination)).toEqual(["ok", "ok"]);
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(report.classification).toBe("PASS");
  });

describe("a whole fixture through the harness", () => {
  it("installs, runs, and passes with evidence on disk", async () => {
    const { vfs, root } = bootVfs();
    vfs.writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ name: "fixture-project", version: "1.0.0", dependencies: { greeter: "^1.0.0" } }),
    );
    vfs.writeFileSync(`${root}/scripts/check.js`, 'console.log(require("greeter"));\n');

    const registry = await createFakeRegistry({
      packages: {
        greeter: [{ version: "1.2.0", files: { "index.js": 'module.exports = "greeter@1.2.0";' } }],
      },
    });

    const runtime = new InProcessRuntime(vfs);
    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: scratch,
    });

    expect(report.classification).toBe("PASS");
    expect(report.assertions).toHaveLength(3);
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);

    // The dependency really landed in the VFS, and the program really requited it.
    expect(exists(vfs, `${root}/node_modules/greeter/index.js`)).toBe(true);
    expect(report.steps[1]?.record?.stdout).toContain("greeter@1.2.0");

    const evidenceDir = join(scratch, "fixture-01");
    const verdict = readFileSync(join(evidenceDir, "verdict.txt"), "utf8");
    expect(verdict).toContain("PASS");
    const steps = JSON.parse(readFileSync(join(evidenceDir, "steps.json"), "utf8")) as unknown[];
    expect(steps).toHaveLength(2);
  });

  it("fails the assertion, not the run, when the program exits non-zero", async () => {
    const { vfs, root } = bootVfs();
    vfs.writeFileSync(`${root}/package.json`, JSON.stringify({ name: "p", version: "1.0.0" }));
    vfs.writeFileSync(`${root}/scripts/boom.js`, "process.exit(2);\n");

    const runtime = new InProcessRuntime(vfs);
    const registry = await createFakeRegistry({ packages: {} });
    const failing = parseDefinition({
      ...JSON.parse(JSON.stringify(definition)),
      steps: [{ kind: "run", command: "node scripts/boom.js", timeoutClass: "run", purpose: "exit non-zero" }],
      assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
      expected: ["PASS", "RUNTIME_INCOMPATIBILITY"],
    });

    const report = await runFixture({
      definition: failing,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: null,
    });

    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toMatch(/exit-code/);
    expect(report.outcome).toBeNull();
  });

  it("does not run later steps once one times out", async () => {
    const { vfs } = bootVfs();

    const report = await runFixture({
      definition: parseDefinition({
        ...JSON.parse(JSON.stringify(definition)),
        steps: [{ kind: "run", command: "node slow.js", timeoutClass: "run", purpose: "overrun the budget" }],
        assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
        expected: ["PASS"],
      }),
      executeStep: async (_step, index) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { termination: "ok", detail: "finished far too late", record: { index, exitCode: 0, stdout: "", stderr: "" } };
      },
      environment: environmentFor(vfs),
      evidenceRoot: null,
      budgets: { install: 1000, build: 1000, run: 10 },
    });

    expect(report.classification).toBe("TIMEOUT");
    // ADR-0014 D-4 records an unevaluated assertion instead of dropping it, so the report shows what was never checked.
    expect(report.assertions).toHaveLength(1);
    expect(report.assertions[0]?.state).toBe("not-evaluated");
  });
});

/**
 * The pnpm profile through a WHOLE fixture: install, run, verdict, and the evidence written to disk.
 *
 * The unit tests elsewhere prove the plan and the detail string. This proves the part the contract actually claims — that the
 * deviation record reaches EVIDENCE (`steps.json`), which is what an auditor reads later — and that a refused pnpm command is
 * classified as a design boundary rather than as a bug of ours.
 */
describe("the pnpm profile through a whole fixture", () => {
  const definitionFor = (
    id: number,
    slug: string,
    steps: readonly { kind: string; command: string }[],
    // A refused install stops the run at step 0, so the default assertions on step 1 do not apply to it.
    assertions: readonly { kind: string; step: number; equals?: number; contains?: string }[] = [
      { kind: "exit-code", step: 1, equals: 0 },
      { kind: "stdout-contains", step: 1, contains: "built" },
    ],
  ): FixtureDefinition =>
    parseDefinition({
      formatVersion: 1,
      id,
      slug,
      lane: "front-end-only",
      title: "pnpm profile integration",
      intent: "Proves a pnpm command runs under the declared profile and says so in evidence.",
      source: "harness integration test",
      status: "frozen",
      steps: steps.map((entry) => ({
        kind: entry.kind,
        command: entry.command,
        timeoutClass: entry.kind === "install" ? "install" : "run",
        purpose: "pnpm profile integration",
      })),
      assertions,
      expected: ["PASS"],
    });

  const DEVIATION =
    "pnpm-resolution profile: package.json install, npm-style hoisted node_modules, no pnpm-lock.yaml read or written";

  const project = (): { vfs: FileSystem; root: string } => {
    const { vfs, root } = bootVfs();
    vfs.writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ name: "pnpm-app", version: "1.0.0", scripts: { build: "node build.js" } }),
    );
    vfs.writeFileSync(`${root}/build.js`, "console.log('built');\n");
    return { vfs, root };
  };

  it("runs pnpm install and pnpm run, and records the deviation in evidence", async () => {
    const { vfs, root } = project();
    const registry = await createFakeRegistry({ packages: {} });
    const runtime = new InProcessRuntime(vfs);
    const definition = definitionFor(19, "fixture-19", [
      { kind: "install", command: "pnpm install" },
      { kind: "run", command: "pnpm run build" },
    ]);

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: scratch,
    });

    expect(report.classification).toBe("PASS");
    expect(report.steps.map((entry) => entry.termination)).toEqual(["ok", "ok"]);

    // The claim that matters: the record is IN the evidence an auditor reads, not only in a transient detail string.
    const steps = readFileSync(join(scratch, "fixture-19", "steps.json"), "utf8");
    expect(steps).toContain(DEVIATION);
    // And it is attached to the install step, which is the step that ran the installer.
    const parsed = JSON.parse(steps) as { record?: { stdout?: string } }[];
    expect(parsed[0]?.record?.stdout ?? "").toContain(DEVIATION);
    expect(parsed[1]?.record?.stdout ?? "").not.toContain(DEVIATION);
  });

  it("writes no deviation record for the same fixture under npm", async () => {
    const { vfs, root } = project();
    const registry = await createFakeRegistry({ packages: {} });
    const runtime = new InProcessRuntime(vfs);
    const definition = definitionFor(20, "fixture-20", [
      { kind: "install", command: "npm install" },
      { kind: "run", command: "npm run build" },
    ]);

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: scratch,
    });

    expect(report.classification).toBe("PASS");
    expect(readFileSync(join(scratch, "fixture-20", "steps.json"), "utf8")).not.toContain(DEVIATION);
  });

  it("classifies a refused pnpm command as a design boundary, with the approved wording in evidence", async () => {
    const { vfs, root } = project();
    const registry = await createFakeRegistry({ packages: {} });
    const runtime = new InProcessRuntime(vfs);
    const definition = definitionFor(
      14,
      "fixture-14",
      [{ kind: "install", command: "pnpm add left-pad" }],
      [{ kind: "exit-code", step: 0, equals: 1 }],
    );

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: scratch,
    });

    // Not HARNESS_BUG: a boundary we chose must never read as a defect to be fixed.
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.classification).not.toBe("HARNESS_BUG");

    const verdict = readFileSync(join(scratch, "fixture-14", "verdict.txt"), "utf8");
    expect(verdict).toContain("intentionally not supported");
    expect(verdict).toContain("declare it in package.json");
    // The policy is named in the step record, so a reader can find the decision without reading our source. It is in steps.json
    // rather than the verdict text because the verdict carries the sentence and the record carries the structure.
    const steps = readFileSync(join(scratch, "fixture-14", "steps.json"), "utf8");
    expect(steps).toContain('"policy": "pnpm-resolution"');
  });
});

describe("what a pnpm install actually leaves on disk", () => {
  const DEVIATION =
    "pnpm-resolution profile: package.json install, npm-style hoisted node_modules, no pnpm-lock.yaml read or written";

  it("writes npm's lockfile and never a pnpm one, which is what the deviation record promises", async () => {
    const { vfs, root } = bootVfs();
    vfs.writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ name: "lock-probe", version: "1.0.0", dependencies: { greeter: "^1.0.0" } }),
    );
    vfs.writeFileSync(`${root}/check.js`, 'console.log(require("greeter"));\n');

    const registry = await createFakeRegistry({
      packages: { greeter: [{ version: "1.0.0", files: { "index.js": 'module.exports = "greeter";' } }] },
    });
    const runtime = new InProcessRuntime(vfs);
    const definition = parseDefinition({
      formatVersion: 1,
      id: 20,
      slug: "fixture-20",
      lane: "front-end-only",
      title: "what pnpm leaves on disk",
      intent: "Proves the deviation record describes reality: npm-style tree and lockfile, no pnpm lockfile.",
      source: "harness integration test",
      status: "frozen",
      steps: [
        { kind: "install", command: "pnpm install", timeoutClass: "install", purpose: "Install under the profile" },
        { kind: "run", command: "node check.js", timeoutClass: "run", purpose: "Prove the tree is usable" },
      ],
      assertions: [
        { kind: "exit-code", step: 1, equals: 0 },
        { kind: "file-exists", step: 1, target: "/app/node_modules/greeter/index.js" },
      ],
      expected: ["PASS"],
    });

    const report = await runFixture({
      definition,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment: environmentFor(vfs),
      evidenceRoot: null,
    });

    expect(report.classification).toBe("PASS");
    // The tree is real: the dependency is where an npm-style hoisted install puts it.
    expect(exists(vfs, `${root}/node_modules/greeter/index.js`)).toBe(true);
    // And the lockfile is npm's, because that is the one we read and verify. A pnpm-lock.yaml appearing here would make the
    // deviation sentence false, so it is asserted absent rather than left to inspection.
    expect(exists(vfs, `${root}/package-lock.json`)).toBe(true);
    expect(exists(vfs, `${root}/pnpm-lock.yaml`)).toBe(false);
    expect(report.steps[0]?.record?.stdout ?? "").toContain(DEVIATION);
  });
});
