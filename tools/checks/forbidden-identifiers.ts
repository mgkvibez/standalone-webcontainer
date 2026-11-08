/**
 * CLI for the forbidden-identifier guard. Executed, never imported.
 */

import { collectSources, scanSource } from "./identifiers.js";

const sources = collectSources("src");
const violations = scanSource(sources);

if (violations.length > 0) {
  console.error(`forbidden identifiers in shipping source (${violations.length}):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line} ${v.identifier} — ${v.text}`);
  console.error("\nIf the mention is a comment explaining the ban, append `guard-allow: <reason>` to the line.");
  process.exit(1);
}
console.log(`no forbidden identifiers in ${sources.size} source files`);
