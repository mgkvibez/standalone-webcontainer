/**
 * CLI for the fixture executor: `npm run fixtures:run -- --id 4` or `--all`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RegistryClient } from "../../src/npm/install.js";
import { createHttpRegistryClient } from "../../src/npm/install.js";
import { loadSnapshotRegistry } from "../../src/registry/snapshot.js";
import { DEFAULT_BUDGETS } from "../../src/harness/runner.js";
import { makeRunId, type RegistryProvenance, type RunProvenanceInput } from "../../src/harness/provenance.js";
import { hashDefinition } from "../../src/harness/freeze.js";
import { EvidenceRefusedError } from "../../src/harness/provenance.js";
import { loadRegistry, readDefinitions, repoRoot, runDefinition } from "./fixture-executor.js";

/**
 * The registry lanes, named rather than implied.
 *
 * `corpus` (the default) keeps CI hermetic but cannot produce a verdict about a real package. `network` is the product path.
 * `snapshot:<dir>` is real tarballs frozen on disk, which is the lane a *compatibility* verdict should be measured on: real bytes,
 * no network, and the exact versions the snapshot holds rather than whatever `latest` means today.
 */
const snapshotRegistry = (directory: string): RegistryClient => {
  const root = directory.startsWith("/") ? directory : join(repoRoot, directory);
  const manifestText = readFileSync(join(root, "snapshot.json"), "utf8");
  const slug = directory.split("/").filter((part) => part !== "").at(-1) ?? directory;
  return loadSnapshotRegistry({
    slug,
    root,
    manifestText,
    read: (path) => new Uint8Array(readFileSync(path)),
  });
};

/** The commit a run's evidence belongs to, or `"unknown"` when nothing can say. Never a guess. */
const commitOf = (): string => {
  const fromCi = process.env.GITHUB_SHA ?? process.env.SWC_COMMIT;
  if (fromCi !== undefined && fromCi !== "") return fromCi;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

/**
 * Whether the working tree matched the commit, because the commit alone is not the code.
 *
 * `changedFiles: null` when git cannot answer (a tarball, a CI export with no history): reporting "clean" in that case would be a
 * guess dressed as a fact.
 */
const treeState = (): { dirty: boolean; changedFiles: number | null } => {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    const lines = status.split("\n").filter((line) => line.trim() !== "");
    return { dirty: lines.length > 0, changedFiles: lines.length };
  } catch {
    return { dirty: true, changedFiles: null };
  }
};

const harnessVersion = (): string => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
};

/**
 * The lane, described well enough that two snapshots cannot pose as one.
 *
 * A digest of `snapshot.json` rather than the directory name: `fixtures/snapshots/vite` gets rebuilt, so the path is a
 * location and the digest is the bytes. Without it, "the same lane" would mean "the same folder", which is how a stale
 * snapshot silently inherits another run's verdict.
 */
const registryProvenance = (flag: string): RegistryProvenance => {
  if (flag === "network") return { lane: "network", label: "registry.npmjs.org" };
  if (flag.startsWith("snapshot")) {
    const directory = flag.includes(":") ? flag.slice(flag.indexOf(":") + 1) : "fixtures/snapshots/express";
    const root = directory.startsWith("/") ? directory : join(repoRoot, directory);
    const bytes = readFileSync(join(root, "snapshot.json"));
    const manifest = JSON.parse(bytes.toString("utf8")) as { capturedAt?: string; packages?: Record<string, unknown> };
    return {
      lane: "snapshot",
      label: directory,
      snapshot: {
        directory,
        ...(manifest.capturedAt === undefined ? {} : { capturedAt: manifest.capturedAt }),
        digest: createHash("sha256").update(bytes).digest("hex"),
        ...(manifest.packages === undefined ? {} : { packages: Object.keys(manifest.packages).length }),
      },
    };
  }
  return { lane: "corpus", label: "offline corpus (fixtures/registry)" };
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

  // The corpus is the default because CI must be hermetic. `--registry=network` is the product path, and `--registry=snapshot:<dir>`
  // is the frozen lane. The lane is never assumed: a verdict has to say which bytes it ran against.
  const registryFlag =
    args.find((arg) => arg.startsWith("--registry="))?.slice("--registry=".length) ??
    (args.includes("--registry") ? args[args.indexOf("--registry") + 1] : undefined) ??
    "corpus";
  let registry: RegistryClient;
  if (registryFlag === "network") {
    registry = createHttpRegistryClient();
    console.log("registry: network (registry.npmjs.org)");
  } else if (registryFlag.startsWith("snapshot")) {
    const directory = registryFlag.includes(":") ? registryFlag.slice(registryFlag.indexOf(":") + 1) : "fixtures/snapshots/express";
    registry = snapshotRegistry(directory);
    console.log(`registry: frozen snapshot (${directory}) — real tarballs, pinned by integrity, no network`);
  } else {
    registry = await loadRegistry();
    console.log("registry: offline corpus");
  }
  const lane = registryProvenance(registryFlag);
  const replaceForeignEvidence = args.includes("--replace-lane") || args.includes("--replace-unattributed");
  let mismatches = 0;
  for (const definition of selected) {
    const provenance: RunProvenanceInput = {
      runId: makeRunId(new Date(), await hashDefinition(definition)),
      definition: {
        sha256: await hashDefinition(definition),
        formatVersion: definition.formatVersion,
        steps: definition.steps.length,
        assertions: definition.assertions.length,
      },
      harness: { name: "standalone-webcontainer fixture runner", version: harnessVersion() },
      runtime: { name: "node", version: process.version },
      commit: commitOf(),
      tree: treeState(),
      command: { argv: process.argv.slice(2), steps: definition.steps.map((step) => step.command) },
      registry: lane,
      budgets: DEFAULT_BUDGETS,
    };
    let report;
    try {
      report = await runDefinition(definition, registry, evidenceRoot, provenance, replaceForeignEvidence);
    } catch (error) {
      if (error instanceof EvidenceRefusedError) {
        console.log(`${definition.slug}  ${"EVIDENCE_REFUSED".padEnd(22)} not scored  ${error.message}`);
        mismatches += 1;
        continue;
      }
      throw error;
    }
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
