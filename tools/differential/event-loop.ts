/**
 * Runs every differential case in real Node and in this runtime, then reports where the orders differ.
 *
 * This is a measurement, not a gate: it exits 0 with a table, and `--strict` turns deviations into a failure once the
 * runtime is expected to match. Reporting first is deliberate — a mismatch here is a finding about the scheduler, and
 * hiding it behind a red test would make it look like a code defect to be silenced.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystem } from "../../src/vfs/index.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { CASES } from "./cases.js";

export interface CaseResult {
  readonly id: string;
  readonly question: string;
  readonly node: string;
  readonly runtime: string;
  readonly matches: boolean;
}

function normalise(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
}

/** Real Node is the oracle. A temp directory keeps each case isolated and leaves nothing behind. */
function runInNode(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-node-"));
  try {
    const file = join(dir, "case.cjs");
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    return normalise(result.stdout ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runInRuntime(source: string): Promise<string> {
  // Seed the way the harness does (writeFileSync), because a wrong seeding call produces an empty stdout that reads like a
  // runtime defect. My first version did exactly that and reported 0/8 matches.
  const vfs = new FileSystem();
  vfs.writeFileSync("/case.js", source);
  const runtime = new InProcessRuntime(vfs);
  const result = await runtime.run("/case.js", { timeoutMs: 10_000 });
  return normalise(result.stdout);
}

const results: CaseResult[] = [];
for (const testCase of CASES) {
  const node = runInNode(testCase.source);
  const runtime = await runInRuntime(testCase.source);
  results.push({ id: testCase.id, question: testCase.question, node, runtime, matches: node === runtime });
}

const width = results.reduce((max, result) => Math.max(max, result.id.length), 4);
for (const result of results) {
  console.log(`${result.matches ? "MATCH   " : "DEVIATES"}  ${result.id.padEnd(width)}  ${result.question}`);
  if (!result.matches) {
    console.log(`            node:    ${result.node}`);
    console.log(`            runtime: ${result.runtime}`);
  }
}

const deviating = results.filter((result) => !result.matches).length;
console.log(`\n${results.length - deviating}/${results.length} cases match real Node`);

if (process.argv.includes("--strict") && deviating > 0) {
  console.error(`${deviating} case(s) deviate; --strict turns this into a failure.`);
  process.exit(1);
}
