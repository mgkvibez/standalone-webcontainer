/**
 * CLI for the dependency corpus. Executed, never imported.
 *
 * Same split as the freeze trainer: the library does nothing on import, and this file always does its job when run, so
 * "is this the entry module?" never has to be detected. `--write` regenerates the committed corpus, `--check` reports
 * drift without touching anything.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { runCorpusBuild } from "./corpus.js";

const result = await runCorpusBuild(process.argv.slice(2), process.cwd(), {
  mkdir: (path: string) => mkdirSync(path, { recursive: true }),
  write: (path: string, bytes: Uint8Array) => writeFileSync(path, bytes),
  read: (path: string) => new Uint8Array(readFileSync(path)),
  exists: (path: string) => existsSync(path),
});

for (const line of result.lines) console.log(line);
process.exitCode = result.exitCode;
