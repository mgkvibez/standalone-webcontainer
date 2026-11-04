/**
 * A fixture's project files: the paths it may write, and that a definition is self-contained enough to stage.
 */

import { describe, expect, it } from "vitest";

import { parseDefinition } from "../../src/harness/definition.js";
import { assertSafeProjectPath, materializeProject, ProjectPathError } from "../../src/harness/project.js";
import { createStepExecutor } from "../../src/harness/execute.js";
import { runFixture } from "../../src/harness/runner.js";
import type { AssertionEnvironment } from "../../src/harness/assertions.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { createFakeRegistry } from "../helpers/registry.js";
import { bootVfs } from "../helpers/vfs.js";

const definitionBase = {
  formatVersion: 1,
  id: 18,
  slug: "fixture-18",
  lane: "front-end-only",
  title: "A definition ships its own project",
  intent: "Proves a fixture can stage the files its steps act on.",
  source: "harness project test",
  status: "proposed",
};

describe("assertSafeProjectPath", () => {
  it("accepts ordinary relative paths, including nested and scoped ones", () => {
    for (const good of ["package.json", "src/main.js", "src/lib/deep/mod.js", "@scope/pkg/file.txt", ".gitignore"]) {
      expect(() => assertSafeProjectPath(good), good).not.toThrow();
    }
  });

  it("rejects paths that could write outside the project", () => {
    for (const bad of ["/etc/passwd", "../escape.js", "src/../../escape.js", "a/./b.js", "a//b.js"]) {
      expect(() => assertSafeProjectPath(bad), bad).toThrow(ProjectPathError);
    }
  });

  it("rejects an empty path and a Windows separator", () => {
    expect(() => assertSafeProjectPath("")).toThrow(/empty/);
    expect(() => assertSafeProjectPath("src\\main.js")).toThrow(/forward slashes/);
  });

  it("rejects node_modules, because the installer must produce it", () => {
    expect(() => assertSafeProjectPath("node_modules/pkg/index.js")).toThrow(/installer/);
  });
});

describe("materializeProject", () => {
  it("creates parent directories and returns the paths it wrote", () => {
    const calls: string[] = [];
    const writer = {
      mkdirSync: (dir: string) => calls.push(`mkdir ${dir}`),
      writeFileSync: (file: string, data: string | Uint8Array) => calls.push(`write ${file} (${String(data).length})`),
    };

    const written = materializeProject(writer, "/app/", {
      "src/main.js": "console.log(1);",
      "package.json": "{}",
    });

    // Sorted, so two runs of the same fixture perform the same operations in the same order.
    expect(written).toEqual(["/app/package.json", "/app/src/main.js"]);
    // Alphabetical: "package.json" sorts before "src/main.js", so it is written first and needs no mkdir.
    expect(calls).toEqual([
      "write /app/package.json (2)",
      "mkdir /app/src",
      "write /app/src/main.js (15)",
    ]);
  });

  it("validates before writing anything, so a bad definition stages nothing", () => {
    let writes = 0;
    const writer = { mkdirSync: () => {}, writeFileSync: () => { writes += 1; } };

    expect(() => materializeProject(writer, "/app", { "ok.js": "1", "../bad.js": "2" })).toThrow(ProjectPathError);
    expect(writes).toBe(0);
  });
});

describe("files in a definition", () => {
  it("is optional, so a definition with no project still parses", () => {
    const parsed = parseDefinition({
      ...definitionBase,
      steps: [{ kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install" }],
      assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
      expected: ["PASS"],
    });
    expect(parsed.files).toBeUndefined();
  });

  it("is refused at parse time when a path is unsafe, not mid-run", () => {
    const build = (files: Record<string, unknown>): unknown => ({
      ...definitionBase,
      files,
      steps: [{ kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install" }],
      assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
      expected: ["PASS"],
    });

    expect(() => parseDefinition(build({ "../escape.js": "x" }))).toThrow(ProjectPathError);
    expect(() => parseDefinition(build({ "node_modules/pkg/index.js": "x" }))).toThrow(/installer/);
    expect(() => parseDefinition(build({ "ok.js": 42 }))).toThrow(/must be a string/);
  });
});

describe("a definition that stages its own project", () => {
  it("installs and runs from files the definition shipped", async () => {
    const parsed = parseDefinition({
      ...definitionBase,
      status: "frozen",
      files: {
        "package.json": JSON.stringify(
          { name: "staged-project", version: "1.0.0", dependencies: { greeter: "^1.0.0" } },
          null,
          2,
        ),
        "start.js": 'const greet = require("greeter");\nconsole.log(greet("world"));',
      },
      steps: [
        { kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the dependency" },
        { kind: "run", command: "node start.js", timeoutClass: "run", purpose: "Run the project's entry" },
      ],
      assertions: [
        { kind: "exit-code", step: 1, equals: 0 },
        { kind: "stdout-contains", step: 1, contains: "greeter@1.0.0" },
        { kind: "file-exists", step: 0, target: "/app/node_modules/greeter/package.json" },
      ],
      expected: ["PASS"],
    });

    const registry = await createFakeRegistry({
      packages: {
        greeter: [
          {
            version: "1.0.0",
            // The default fake package exports a string; this fixture calls it, so it has to be callable.
            files: { "index.js": 'module.exports = (name) => `hello ${name} from greeter@1.0.0`;' },
          },
        ],
      },
    });
    const { vfs, root } = bootVfs();

    const staged = materializeProject(vfs, root, parsed.files ?? {});
    expect(staged).toEqual(["/app/package.json", "/app/start.js"]);

    const environment: AssertionEnvironment = {
      readFile: async (path) => {
        try {
          return vfs.readFileSync(path, "utf8") as string;
        } catch {
          return null;
        }
      },
      request: async () => {
        throw new Error("this fixture makes no http requests");
      },
    };

    const runtime = new InProcessRuntime(vfs);
    const report = await runFixture({
      definition: parsed,
      executeStep: createStepExecutor({ runtime, registry, root }),
      environment,
      evidenceRoot: null,
    });

    expect(report.reason).toMatch(/^all 3 assertion\(s\) passed$/);
    expect(report.classification).toBe("PASS");
  });
});
