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
 * Files and HTTP work the way they do in the browser: `file-exists` reads the runtime VFS (a program's writes exist only there)
 * and HTTP assertions go through the same preview gateway the proxy uses, with the fixture's `http://localhost:<port>/…` mapped
 * onto `/preview/<port>/…` by `preview-target.ts`.
 *
 * The CLI lives in `run-fixture.ts`; this module is the part a test can call.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Container } from "../../src/container/container.js";
import type { ProjectFiles } from "../../src/container/types.js";
import type { RegistryClient } from "../../src/npm/install.js";
import { ProbeFault, type AssertionEnvironment } from "../../src/harness/assertions.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";
import { NotPreviewable } from "../../src/harness/preview-target.js";
import { InProcessClient } from "./in-process-client.js";

export { InProcessClient };
import { runFixture, type ExecuteStep, type FixtureRunReport } from "../../src/harness/runner.js";
import type { RunProvenanceInput } from "../../src/harness/provenance.js";
import { loadCorpusRegistry } from "../../src/registry/corpus.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const absolute = (path: string): string => (path.startsWith("/") ? path : `/${path}`);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A project's files as the container sees them: seeded from the definition, mutated by installs. */
export class MapFiles implements ProjectFiles {
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

/** Any registry the installer can use: the offline corpus by default, the live one when a run asks for it explicitly. */
export type Registry = RegistryClient;

export const loadRegistry = async (): Promise<Registry> => {
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

export const readDefinitions = (): FixtureDefinition[] => {
  const dir = join(repoRoot, "fixtures", "definitions");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FixtureDefinition);
};

export const runDefinition = async (
  definition: FixtureDefinition,
  registry: Registry,
  evidenceRoot: string,
  provenance?: RunProvenanceInput,
  replaceForeignEvidence?: boolean,
): Promise<FixtureRunReport> => {
  const files = new MapFiles(definition.files ?? {});
  const runtime = new InProcessClient();
  const container = new Container({ runtime, files, registry });
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
      // The container's own status, not a guess at its text. A refused command (`npx`, `sh`) writes its reason to the SYSTEM stream and
      // matches neither prefix here, so the old inference scored a refusal as success: `fixture-12`'s `npx tsc` was recorded as exit 0
      // with no output and the exit-code assertion passed on a command that never ran.
      const failed = container.lastExitCode !== 0;
      const said = `${stdout}\n${stderr}`.trim();
      return {
        termination: "ok",
        detail: `builtin command ${failed ? "reported a failure" : "completed"}${said === "" ? "" : `: ${said.split("\n")[0]}`}`,
        record: { index, exitCode: failed ? 1 : 0, stdout, stderr },
      };
    }

    // A `run` step that starts a server leaves a process the container marks "running" with ports, and it does that only when
    // the runtime reported exit 0 for the program and at least one port came up. So the exit code is 0: the program started and
    // exited successfully, and the server outlives it. Anything else with no exit code did not finish, which is -1 rather than a
    // free pass for an exit-code assertion.
    const serving = process.state === "running" && (process.previewPorts?.length ?? 0) > 0;
    const ports = process.previewPorts ?? [];
    return {
      termination: "ok",
      detail: serving
        ? `process ${process.pid} exited 0 and left a server listening on port(s) ${ports.join(", ")}`
        : `process ${process.pid} ${process.state}${process.exitCode === undefined ? " without an exit code" : ` with exit ${process.exitCode}`}`,
      record: {
        index,
        exitCode: process.exitCode ?? (serving ? 0 : -1),
        stdout: process.stdout ?? "",
        stderr: process.stderr ?? "",
      },
    };
  };

  const environment: AssertionEnvironment = {
    // The project snapshot first, then the runtime VFS: a file the definition seeded and the program never touched lives in the
    // snapshot, and a file the program wrote lives in the VFS. `fs.writeFileSync` over a seeded file lands in both.
    readFile: async (path) => files.read(path) ?? runtime.readFile(path),
    request: async (url) => {
      try {
        return await runtime.probe(url);
      } catch (error) {
        // A target this runner will not route (a remote host, a URL with no port) is a defect in the fixture or the harness, not
        // evidence about the runtime, so it is classified differently on purpose.
        if (error instanceof NotPreviewable) throw new ProbeFault("HARNESS_BUG", error.message);
        throw new ProbeFault("NETWORK", `the preview gateway could not be reached: ${describe(error)}`);
      }
    },
  };

  return runFixture({
    definition,
    executeStep,
    environment,
    evidenceRoot,
    // Passed straight through: a run that cannot say how it was executed does not get to write evidence (W-27).
    ...(provenance === undefined ? {} : { provenance }),
    ...(replaceForeignEvidence === undefined ? {} : { replaceForeignEvidence }),
  });
};

