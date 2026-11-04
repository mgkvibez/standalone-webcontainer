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
