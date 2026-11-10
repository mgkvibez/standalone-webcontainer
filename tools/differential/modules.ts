/**
 * Runs every module case in real Node and in this runtime, then reports where they differ.
 *
 * Same contract as the event-loop differential: this is a measurement, not a gate. It exits 0 with a table, and `--strict` turns
 * deviations into a failure once the runtime is expected to match. A mismatch here is a finding about resolution, and hiding it
 * behind a red test would make it look like a code defect to be silenced.
 *
 * Each case is staged twice from the same source of truth: a temp directory for Node, and the VFS for this runtime. Staging both
 * from one description is what makes a difference attributable to the resolver rather than to two hand-kept fixtures drifting.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystem } from "../../src/vfs/index.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { MODULE_CASES, type ModuleCase } from "./module-cases.js";

export interface ModuleCaseResult {
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

/** Real Node is the oracle. */
function runInNode(testCase: ModuleCase): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-mod-"));
  try {
    for (const [path, contents] of Object.entries(testCase.files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    const result = spawnSync(process.execPath, [join(dir, testCase.entry)], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    const stdout = normalise(result.stdout ?? "");
    // A case that dies before printing is a result too, and its exit code is the only honest description of it.
    return stdout === "" ? `no-output exit=${String(result.status)}` : stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runInRuntime(testCase: ModuleCase): Promise<string> {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(testCase.files)) {
    vfs.writeFileSync(`/${path}`, contents);
  }
  const runtime = new InProcessRuntime(vfs);
  const result = await runtime.run(`/${testCase.entry}`, { timeoutMs: 10_000 });
  const stdout = normalise(result.stdout);
  return stdout === "" ? `no-output exit=${String(result.exitCode)}` : stdout;
}

const results: ModuleCaseResult[] = [];
for (const testCase of MODULE_CASES) {
  const node = runInNode(testCase);
  const runtime = await runInRuntime(testCase);
  results.push({ id: testCase.id, question: testCase.question, node, runtime, matches: node === runtime });
}

const width = Math.max(...results.map((result) => result.id.length));
for (const result of results) {
  const mark = result.matches ? "same" : "DIFF";
  console.log(`${mark}  ${result.id.padEnd(width)}  ${result.question}`);
  if (!result.matches) {
    console.log(`        node:    ${result.node}`);
    console.log(`        runtime: ${result.runtime}`);
  }
}

const matched = results.filter((result) => result.matches).length;
console.log(`\n${matched} of ${results.length} module case(s) match Node.`);

const strict = process.argv.includes("--strict");
if (strict && matched !== results.length) {
  console.error("--strict: module resolution differs from Node.");
  process.exit(1);
}
