/**
 * Runs every API-surface case in real Node and in this runtime, then reports where they differ.
 *
 * A measurement, not a gate: exits 0 with a table, and `--strict` turns deviations into a failure once the runtime is
 * expected to match. Same discipline as the event-loop differential, for the same reason — a mismatch here is a finding
 * about the API surface, and a red test would make it look like a code defect to be silenced rather than a gap to close.
 *
 * stdlib only, like its sibling: it stages real Node in a temp directory and leaves nothing behind, and it never imports
 * the runtime's own shims to compare against them (which would be asking the subject to mark its own paper).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSystem } from "../../src/vfs/index.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { API_CASES } from "./api-cases.js";

export interface ApiCaseResult {
  readonly id: string;
  readonly question: string;
  readonly node: string;
  readonly runtime: string;
  readonly matches: boolean;
}

interface Answer {
  readonly stdout: string;
  readonly exitCode: number;
}

const normalise = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");

/**
 * The comparison is stdout plus exit status, joined so one string carries both.
 *
 * The exit status is the load-bearing half. A program that dies on an absent member prints nothing at all, so comparing
 * stdout alone reports two empty strings as a match and the instrument congratulates itself on a call that never ran.
 */
const asComparison = (answer: Answer): string => `${normalise(answer.stdout)}; exit=${answer.exitCode}`;

/** Real Node is the oracle. A fresh temp directory per case, so a case cannot see the previous one's files. */
function runInNode(source: string): Answer {
  const dir = mkdtempSync(join(tmpdir(), "api-node-"));
  try {
    const file = join(dir, "case.cjs");
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    return { stdout: result.stdout ?? "", exitCode: result.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runInRuntime(source: string): Promise<Answer> {
  // Seeded fresh per case, the way the harness does it: one shared VFS would let case N inherit case N-1's files.
  const vfs = new FileSystem();
  vfs.writeFileSync("/case.js", source);
  const runtime = new InProcessRuntime(vfs);
  const result = await runtime.run("/case.js", { timeoutMs: 10_000 });
  return { stdout: result.stdout, exitCode: result.exitCode };
}

const results: ApiCaseResult[] = [];
for (const testCase of API_CASES) {
  const node = asComparison(runInNode(testCase.source));
  const runtime = asComparison(await runInRuntime(testCase.source));
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
console.log(`\n${results.length - deviating}/${results.length} API cases match real Node`);

if (process.argv.includes("--strict") && deviating > 0) {
  console.error(`${deviating} case(s) deviate; --strict turns this into a failure.`);
  process.exit(1);
}
