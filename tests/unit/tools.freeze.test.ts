/**
 * The freeze trainer, including one run against the repository's real corpus.
 *
 * The temp corpora cover the behaviour; the last test covers the thing that would otherwise be discovered late, which
 * is that the twenty shipped definitions parse and agree with the slots the charter assigned them.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runFreeze } from "../../tools/freeze-corpus.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 1,
    slug: "fixture-01",
    lane: "front-end-only",
    title: "Vite dev server boots",
    intent: "Proves the shortest useful path end to end.",
    source: "stackblitz-conformance: Vite, adapted",
    status: "proposed",
    steps: [{ kind: "install", command: "npm install", timeoutClass: "install", purpose: "Install the toolchain" }],
    assertions: [{ kind: "http-status", step: 0, target: "http://localhost:3000/", equals: 200 }],
    expected: ["PASS"],
    ...overrides,
  };
}

interface Corpus {
  readonly cwd: string;
  readonly definitionPath: string;
  readonly manifestPath: string;
}

/** A fresh one-fixture project in its own temp directory, so no test can see another's files. */
function corpus(overrides: Record<string, unknown> = {}, manifestExtra: Record<string, unknown> = {}): Corpus {
  const cwd = mkdtempSync(join(tmpdir(), "swc-freeze-"));
  created.push(cwd);
  mkdirSync(join(cwd, "fixtures", "definitions"), { recursive: true });
  const manifest = {
    status: "test corpus",
    fixtures: [
      {
        id: 1,
        slug: "fixture-01",
        lane: "front-end-only",
        definitionPath: "fixtures/definitions/fixture-01.json",
        ...manifestExtra,
      },
    ],
  };
  const manifestPath = join(cwd, "fixtures", "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const definitionPath = join(cwd, "fixtures", "definitions", "fixture-01.json");
  writeFileSync(definitionPath, JSON.stringify(definition(overrides), null, 2));
  return { cwd, definitionPath, manifestPath };
}

function manifestOf(path: string): { fixtures: { frozenHash?: string | null }[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { fixtures: { frozenHash?: string | null }[] };
}

describe("fixtures:freeze", () => {
  it("refuses to pin a proposed definition, because sign-off is not the tool's to give", async () => {
    const { cwd, manifestPath } = corpus();
    const result = await runFreeze([], cwd);

    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/skipped, still proposed/);
    expect(manifestOf(manifestPath).fixtures[0]?.frozenHash).toBeUndefined();
  });

  it("pins a frozen definition, and the pin then verifies", async () => {
    const { cwd, manifestPath } = corpus({ status: "frozen" });

    const froze = await runFreeze([], cwd);
    expect(froze.exitCode).toBe(0);
    expect(froze.lines.join("\n")).toMatch(/pinned [0-9a-f]{12}/);

    const pin = manifestOf(manifestPath).fixtures[0]?.frozenHash;
    expect(pin).toMatch(/^[0-9a-f]{64}$/);

    const checked = await runFreeze(["--check"], cwd);
    expect(checked.exitCode).toBe(0);
    expect(checked.lines.join("\n")).toMatch(/frozen and intact/);
  });

  it("is idempotent: a second freeze writes nothing", async () => {
    const { cwd } = corpus({ status: "frozen" });
    await runFreeze([], cwd);
    const again = await runFreeze([], cwd);
    expect(again.lines.join("\n")).toMatch(/already pinned/);
    expect(again.lines.join("\n")).toMatch(/nothing to write/);
  });

  it("detects a definition edited after it was frozen, and fails the check", async () => {
    const { cwd, definitionPath } = corpus({ status: "frozen" });
    await runFreeze([], cwd);

    // The edit a gate would otherwise never see: same status, different command.
    writeFileSync(
      definitionPath,
      JSON.stringify(
        definition({ status: "frozen", steps: [{ kind: "install", command: "npm ci", timeoutClass: "install", purpose: "Install the toolchain" }] }),
        null,
        2,
      ),
    );

    const checked = await runFreeze(["--check"], cwd);
    expect(checked.exitCode).toBe(1);
    expect(checked.lines.join("\n")).toMatch(/DRIFTED/);
  });

  it("fails the check for a frozen definition that was never pinned", async () => {
    const { cwd } = corpus({ status: "frozen" });
    const checked = await runFreeze(["--check"], cwd);
    expect(checked.exitCode).toBe(1);
    expect(checked.lines.join("\n")).toMatch(/UNVERIFIABLE/);
  });

  it("does not verify a pin by writing one during a check", async () => {
    const { cwd, manifestPath } = corpus({ status: "frozen" });
    await runFreeze(["--check"], cwd);
    expect(manifestOf(manifestPath).fixtures[0]?.frozenHash).toBeUndefined();
  });

  it("treats a definition that disagrees with its slot as corruption, not drift", async () => {
    // id 1 slot holding a definition that claims to be fixture 2: it would score in the wrong lane if allowed.
    const { cwd } = corpus({ id: 2, slug: "fixture-02" });
    const result = await runFreeze(["--check"], cwd);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toMatch(/declares id 2 but sits in slot 1/);
  });

  it("reports a missing manifest as a corpus error rather than crashing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "swc-freeze-"));
    created.push(cwd);
    const result = await runFreeze(["--check"], cwd);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toMatch(/no such file/);
  });

  it("rejects an argument it does not understand instead of ignoring it", async () => {
    const { cwd } = corpus();
    const result = await runFreeze(["--dry-run"], cwd);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toMatch(/unknown argument/);
  });
});

describe("the command line", () => {
  // The library is exercised above; this drives the file npm actually runs, because the argv and exit-code wiring is
  // exactly what a silent no-op hides behind.
  const viteNode = join(repositoryRoot, "node_modules", "vite-node", "vite-node.mjs");
  const cli = join(repositoryRoot, "tools", "freeze-fixtures.ts");

  function runCli(cwd: string, ...flags: string[]): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [viteNode, cli, ...flags], { cwd, encoding: "utf8" });
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
  }

  it("prints a report and exits 0 for the shipped corpus", () => {
    const result = runCli(repositoryRoot, "--check");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/20 definitions, 0 frozen, 20 awaiting sign-off, exit 0/);
  }, 60_000);

  it("exits 1 on drift, so CI cannot be green while a frozen fixture has moved", async () => {
    const { cwd, definitionPath } = corpus({ status: "frozen" });
    await runFreeze([], cwd);
    writeFileSync(
      definitionPath,
      JSON.stringify(
        definition({ status: "frozen", title: "Vite dev server boots (edited)" }),
        null,
        2,
      ),
    );

    const result = runCli(cwd, "--check");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/DRIFTED/);
  }, 60_000);
});

describe("the shipped corpus", () => {
  it("has twenty definitions that parse and agree with their slots, none frozen yet", async () => {
    const result = await runFreeze(["--check"], repositoryRoot);

    expect(result.exitCode).toBe(0);
    const lines = result.lines.join("\n");
    expect(lines).toMatch(/20 definitions, 0 frozen, 20 awaiting sign-off/);
    // Nothing is frozen, so the gate cannot count any of them yet. That is the correct pre-signoff state, and this
    // assertion is here so it cannot drift into "somehow frozen" without the owner acting.
    expect(lines).not.toMatch(/frozen and intact/);
  });
});
