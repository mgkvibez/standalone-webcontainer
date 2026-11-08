/**
 * CLI for the README test count. Executed, never imported.
 *
 * Follows the repo's split (see tools/build-corpus.ts): the library does nothing on import, and this file always does its
 * job when run, so "is this the entry module?" never has to be detected.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { countsFromReport, renderBlock, replaceBlock } from "./counts.js";

const REPORT_PATH = "artifacts/test-report.json";
const README_PATH = "README.md";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const check = args.has("--check");
if (!write && !check) {
  console.error("usage: test-count.ts --write | --check  (reads artifacts/test-report.json)");
  process.exit(2);
}
if (!existsSync(REPORT_PATH)) {
  console.error(`missing ${REPORT_PATH}; run \`npm run test:report\` first`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Parameters<typeof countsFromReport>[0];
const counts = countsFromReport(report);
const block = renderBlock(counts);
const readme = readFileSync(README_PATH, "utf8");
const next = replaceBlock(readme, block);

if (write) {
  writeFileSync(README_PATH, next);
  console.log(`README updated: ${counts.tests} tests across ${counts.files} files`);
  process.exit(0);
}

if (next !== readme) {
  console.error("README test count is stale. The suite reports:");
  console.error(block);
  console.error("Run `npm run tests:count` and commit the result.");
  process.exit(1);
}
console.log(`README test count is accurate: ${counts.tests} tests across ${counts.files} files`);
