/**
 * CLI for the fixture executor: `npm run fixtures:run -- --id 4` or `--all`.
 */

import { join } from "node:path";

import { createHttpRegistryClient } from "../../src/npm/install.js";
import { loadRegistry, readDefinitions, repoRoot, runDefinition } from "./fixture-executor.js";

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

  // The corpus is the default because CI must be hermetic. `--registry network` is the product path, and it is never assumed: a
  // verdict has to say which bytes it ran against.
  const useNetwork = args.includes("--registry=network") || args[args.indexOf("--registry") + 1] === "network";
  const registry = useNetwork ? createHttpRegistryClient() : await loadRegistry();
  console.log(useNetwork ? "registry: network (registry.npmjs.org)" : "registry: offline corpus");
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
