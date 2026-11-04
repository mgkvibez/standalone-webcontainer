/**
 * CLI for the freeze trainer. Executed, never imported.
 *
 * Kept as its own file so that "am I the entry module?" does not have to be detected: this file always does its job
 * when it is run, and the library it calls does nothing on import. The tests import `freeze-corpus.ts` and drive this
 * file as a subprocess, which is the only way to prove the argv and exit-code wiring actually works.
 */

import { runFreeze } from "./freeze-corpus.js";

const result = await runFreeze(process.argv.slice(2), process.cwd());
for (const line of result.lines) console.log(line);
process.exitCode = result.exitCode;
