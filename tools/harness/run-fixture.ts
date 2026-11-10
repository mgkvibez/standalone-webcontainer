/**
 * CLI for the fixture executor: `npm run fixtures:run -- --id 4` or `--all`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RegistryClient } from "../../src/npm/install.js";
import { createHttpRegistryClient } from "../../src/npm/install.js";
import { loadSnapshotRegistry } from "../../src/registry/snapshot.js";
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
  let mismatches = 0;
  for (const definition of selected) {
    const report = await runDefinition(definition, registry, evidenceRoot);
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
