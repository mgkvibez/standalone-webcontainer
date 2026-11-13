/**
 * CLI for the dead-module guard. Executed, never imported.
 *
 * Fails when a module under `src/` is reachable only from tests, or from nothing. P0-6 was that state, kept for five
 * days, in the file that claimed to be the runtime's boundary; this is the gate that would have named it on the day it
 * appeared.
 */

import { collectConsumers, collectLane, ENTRIES, findStranded, problemsWithDeclarations } from "./module-reachability.js";

const lanes = {
  src: collectLane("src"),
  tools: collectLane("tools"),
  tests: collectLane("tests"),
};

const consumers = collectConsumers(lanes);

const declarations = problemsWithDeclarations(consumers);
const findings = findStranded(consumers, ENTRIES);

if (findings.length > 0) {
  console.error(`modules with no production consumer (${findings.length}):`);
  for (const finding of findings) {
    const audience = finding.kind === "test-only" ? `only ${finding.tests.join(", ")}` : "nothing at all";
    console.error(`  ${finding.module} (${finding.kind}) - imported by ${audience}`);
  }
  console.error(
    "\nA module under src/ that nothing in src/ or tools/ imports is either dead or wired to nothing. Delete it, wire\n" +
      "it, or declare it in tools/checks/module-reachability.ts with a register row (docs/audit/remaining-work.md).",
  );
}

if (declarations.length > 0) {
  console.error(`declaration problems (${declarations.length}):`);
  for (const problem of declarations) console.error(`  ${problem}`);
}

if (findings.length > 0 || declarations.length > 0) process.exit(1);

const modules = consumers.size;
console.log(`no stranded modules in ${modules} source files (${ENTRIES.length} declared entries)`);
