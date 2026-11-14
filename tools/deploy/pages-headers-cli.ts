/**
 * CLI for the Cloudflare Pages header file. Executed, never imported.
 *
 * Same split as the corpus and freeze trainers: the library does nothing on import, and this file always does its job
 * when run, so "is this the entry module?" never has to be detected. `npm run headers:write` regenerates the committed
 * `public/_headers` from the isolation headers in `vite.config.ts`; `npm run headers:check` reports drift without
 * touching anything, and is part of `npm run verify`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveIsolationValues } from "./isolation-headers.js";
import { runPagesHeaders } from "./pages-headers.js";

const root = process.cwd();

const result = runPagesHeaders({
  argv: process.argv.slice(2),
  isolation: await resolveIsolationValues(),
  io: {
    read: (path: string) => {
      try {
        return readFileSync(resolve(root, path), "utf8");
      } catch (error) {
        // A missing file is a finding to report, not a crash: `--check` has to be able to say that it is missing.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write: (path: string, contents: string) => writeFileSync(resolve(root, path), contents),
  },
});

for (const line of result.lines) console.log(line);
process.exitCode = result.exitCode;
