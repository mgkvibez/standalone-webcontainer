/**
 * Run fixture definitions through the real container and write their evidence.
 *
 * Until this file existed the harness had definitions, scoring, evidence writing and freeze checking, and nothing that turned
 * a `FixtureStep` into a run: every test supplied a hand-written executor. That is a second, separate reason the gate can
 * produce no score (the first being that no fixture is frozen). This is the missing adapter, deliberately thin:
 *
 *   - the command line goes through `Container`, the same dispatcher the workspace uses, so `npm install`, `npm run <script>`
 *     and `node <file>` behave here exactly as they do in the app;
 *   - the offline corpus is loaded from the committed bytes, so no network is involved and an unresolvable package fails the
 *     way it fails for a user;
 *   - stdout, stderr and the exit code come from the container's process record, not from parsing the terminal.
 *
 * Three limits are stated here rather than discovered by whoever reads a verdict:
 *
 *   1. A program's filesystem writes are not mirrored back to `ProjectFiles`, so `file-exists` reads the seeded project only.
 *      That is a real gap in this adapter: the browser keeps the runtime VFS inside the Worker.
 *   2. HTTP assertions need the preview proxy, which this runner does not wire. A fixture that needs it is reported as a
 *      harness fault, which the classification precedence already treats as "not evidence about the runtime".
 *   3. `npm run dev` style steps leave a server running; the exit code is then -1 rather than 0, so an exit-code assertion
 *      cannot pass on a process that never exited.
 *
 * Usage: npm run fixtures:run -- --id 4     (or --all for every definition)
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Container } from "../../src/container/container.js";
import type { ProjectFiles, RuntimeClient, RuntimeRunOutcome, RuntimeRunRequest } from "../../src/container/types.js";
import { ProbeFault, type AssertionEnvironment } from "../../src/harness/assertions.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";
import { runFixture, type ExecuteStep, type FixtureRunReport } from "../../src/harness/runner.js";
import { loadCorpusRegistry } from "../../src/registry/corpus.js";
import { RuntimeSupervisor } from "../../src/browser/runtime-supervisor.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const absolute = (path: string): string => (path.startsWith("/") ? path : `/${path}`);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A project's files as the container sees them: seeded from the definition, mutated by installs. */
class MapFiles implements ProjectFiles {
  readonly projectId = "fixture";
  readonly #files = new Map<string, string>();
  readonly #dirs = new Set<string>(["/"]);

  constructor(initial: Readonly<Record<string, string>>) {
    for (const [path, contents] of Object.entries(initial)) this.write(path, contents);
  }

  list(): readonly string[] {
    return [...this.#files.keys()];
  }

  listDirs(): readonly string[] {
    return [...this.#dirs];
  }

  read(path: string): string | null {
    return this.#files.get(absolute(path)) ?? null;
  }

  write(path: string, contents: string): void {
    const target = absolute(path);
    this.#files.set(target, contents);
    let dir = dirname(target);
    while (dir !== "/" && dir !== ".") {
      this.#dirs.add(dir);
      dir = dirname(dir);
    }
  }

  mkdir(path: string): boolean {
    const target = absolute(path);
    if (this.#dirs.has(target)) return false;
    this.#dirs.add(target);
    return true;
  }

  remove(path: string): boolean {
    return this.#files.delete(absolute(path));
  }
}

/** One runtime per run, in this process rather than a Worker: the supervisor already rebuilds the VFS per run. */
class InProcessClient implements RuntimeClient {
  readonly #supervisor = new RuntimeSupervisor();

  run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    return this.#supervisor.run(request);
  }

  reset(): void {
    // The supervisor rebuilds the VFS per run, so there is no long-lived runtime to discard between fixtures.
  }
}

type Registry = Awaited<ReturnType<typeof loadCorpusRegistry>>["registry"];

const loadRegistry = async (): Promise<Registry> => {
  const root = join(repoRoot, "fixtures", "registry");
  const manifestText = readFileSync(join(root, "manifest.json"), "utf8");
  const corpus = new Map<string, Uint8Array>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "manifest.json") corpus.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  };
  walk(root);
  const loaded = await loadCorpusRegistry({
    root: "/corpus",
    manifestText,
    mode: "resolution",
    read: (path) => {
      const key = path.startsWith("/corpus/") ? path.slice("/corpus/".length) : path;
      const bytes = corpus.get(key);
      if (bytes === undefined) throw new Error(`offline corpus file is missing: ${key}`);
      return bytes;
    },
    listFiles: () => [...corpus.keys()],
  });
  return loaded.registry;
};

const readDefinitions = (): FixtureDefinition[] => {
  const dir = join(repoRoot, "fixtures", "definitions");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FixtureDefinition);
};

const runOne = async (definition: FixtureDefinition, registry: Registry, evidenceRoot: string): Promise<FixtureRunReport> => {
  const files = new MapFiles(definition.files ?? {});
  const container = new Container({ runtime: new InProcessClient(), files, registry });
  const session = container.createSession("fixture");

  const executeStep: ExecuteStep = async (step, index) => {
    const before = new Set(container.processes().map((process) => process.pid));
    session.scrollback.length = 0;
    try {
      await container.execute(session.id, step.command);
    } catch (error) {
      return { termination: "harness-fault", detail: `the container threw: ${describe(error)}`, record: null };
    }

    const spawned = container.processes().filter((process) => !before.has(process.pid));
    const process = spawned[spawned.length - 1];
    if (process === undefined) {
      // A builtin (`npm install`, `cd`, `ls`) is handled by the container and creates no process, so its output is the
      // scrollback and its status has to be read from what it said. The container does not throw on a failed install; it
      // writes `npm error: …`, so that prefix is the failure signal rather than a guess at success.
      const stdout = session.scrollback.filter((line) => line.stream === "stdout").map((line) => line.text).join("\n");
      const stderr = session.scrollback.filter((line) => line.stream === "stderr").map((line) => line.text).join("\n");
      const failed = /^(npm error|npm: )/m.test(stderr);
      const said = `${stdout}\n${stderr}`.trim();
      return {
        termination: "ok",
        detail: `builtin command ${failed ? "reported a failure" : "completed"}${said === "" ? "" : `: ${said.split("\n")[0]}`}`,
        record: { index, exitCode: failed ? 1 : 0, stdout, stderr },
      };
    }

    // `exitCode` is absent while a server is still up, which is the correct state for a `run` step that starts one. Reported
    // as -1 rather than 0 so an exit-code assertion cannot pass on a process that never exited.
    return {
      termination: "ok",
      detail: `process ${process.pid} ${process.state}${process.exitCode === undefined ? " (still running)" : ` with exit ${process.exitCode}`}`,
      record: { index, exitCode: process.exitCode ?? -1, stdout: process.stdout ?? "", stderr: process.stderr ?? "" },
    };
  };

  const environment: AssertionEnvironment = {
    readFile: async (path) => files.read(path),
    // The preview proxy lives behind the Worker bridge; this runner has no bridge, so probing is a harness fault rather than a
    // claim about the runtime.
    request: async () => {
      throw new ProbeFault("HARNESS_BUG", "this runner does not wire the preview proxy, so HTTP assertions cannot be probed");
    },
  };

  return runFixture({ definition, executeStep, environment, evidenceRoot });
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const idIndex = args.findIndex((arg) => arg === "--id" || arg.startsWith("--id="));
  const id = idIndex === -1 ? null : Number(args[idIndex]?.includes("=") === true ? args[idIndex]?.split("=")[1] : args[idIndex + 1]);
  const all = args.includes("--all");
  const evidenceRoot = join(repoRoot, ".evidence", "fixtures");

  const definitions = readDefinitions();
  const selected = all ? definitions : definitions.filter((definition) => definition.id === id);
  if (selected.length === 0) {
    console.error("usage: npm run fixtures:run -- --id <1-20> | --all");
    return 2;
  }

  const registry = await loadRegistry();
  let mismatches = 0;
  for (const definition of selected) {
    const report = await runOne(definition, registry, evidenceRoot);
    const expected = definition.expected ?? [];
    const accepted = expected.includes(report.classification);
    if (!accepted) mismatches += 1;
    console.log(
      `${definition.slug}  ${report.classification.padEnd(22)} ${accepted ? "expected" : `NOT expected (expected: ${expected.join(", ")})`}  ${report.reason}`,
    );
    for (const assertion of report.assertions) {
      console.log(`    ${assertion.kind}#${assertion.index} ${assertion.state}  ${assertion.detail}`);
    }
  }
  // A measurement, not a gate: no fixture is frozen, so a disagreement is information rather than a failure.
  return args.includes("--strict") && mismatches > 0 ? 1 : 0;
};

process.exitCode = await main();
