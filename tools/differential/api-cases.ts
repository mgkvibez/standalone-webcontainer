/**
 * API-surface cases: programs that CALL a name, run twice, compared.
 *
 * Why this file exists, in the audit's own words: the module differential tests resolution semantics, which pass, while
 * the gate "cannot catch [absent names] because it tests what exists, not what a real dependency asks for". A green suite
 * proves the members it exercises work; it says nothing about `fs.appendFileSync` being absent from the file entirely.
 *
 * So each case here is a small program that a real tool would plausibly write, and the comparison is stdout AND exit
 * status. The exit status matters and was missing from the first version of this instrument: a program that dies on a
 * missing member prints nothing, so comparing stdout alone would report two empty strings as a match.
 *
 * Every case uses RELATIVE paths. That is not stylistic. The runtime's cwd is "/", while real Node in a sandbox runs as
 * root, so an absolute path in a case writes to the machine's own filesystem root. The first run of this instrument did
 * exactly that; see docs/audit/api-surface-p0.md.
 */

export interface ApiCase {
  readonly id: string;
  /** What a caller is trying to do, in words. */
  readonly question: string;
  readonly source: string;
}

/** `require` in both lanes: the runtime's loader hands a program CommonJS, and Node stages the same source as .cjs. */
const cases: ApiCase[] = [
  {
    id: "fs-rm-sync-recursive",
    question: "does fs.rmSync remove a tree, and does the tree then read as gone?",
    source: [
      "const fs = require('fs');",
      "fs.mkdirSync('d');",
      "fs.writeFileSync('d/a.txt', 'x');",
      "fs.rmSync('d', { recursive: true, force: true });",
      "try { fs.statSync('d'); console.log('still-there'); } catch (e) { console.log(e.code); }",
    ].join("\n"),
  },
  {
    id: "fs-rm-sync-missing-force",
    question: "is removing a path that never existed an error when force is set?",
    source: [
      "const fs = require('fs');",
      "fs.rmSync('never-existed', { recursive: true, force: true });",
      "try { fs.rmSync('never-existed', { recursive: true }); } catch (e) { console.log(e.code); }",
    ].join("\n"),
  },
  {
    id: "fs-append-sync",
    question: "do two appends land at the end of what is already there?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('a.txt', '1');",
      "fs.appendFileSync('a.txt', '2');",
      "fs.appendFileSync('a.txt', '3');",
      "console.log(fs.readFileSync('a.txt', 'utf8'));",
    ].join("\n"),
  },
  {
    id: "fs-append-creates",
    question: "does appendFileSync create a file that does not exist yet?",
    source: [
      "const fs = require('fs');",
      "fs.appendFileSync('fresh.txt', 'made');",
      "console.log(fs.readFileSync('fresh.txt', 'utf8'));",
    ].join("\n"),
  },
  {
    id: "fs-copy-sync",
    question: "does copyFileSync produce an independent copy of the bytes?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('a.txt', 'copy-me');",
      "fs.copyFileSync('a.txt', 'b.txt');",
      "fs.writeFileSync('a.txt', 'changed');",
      "console.log(fs.readFileSync('b.txt', 'utf8'));",
    ].join("\n"),
  },
  {
    id: "fs-access-sync",
    question: "does accessSync pass on a file, and report ENOENT on a missing one?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('here.txt', 'x');",
      "fs.accessSync('here.txt');",
      "console.log('present');",
      "try { fs.accessSync('gone.txt'); } catch (e) { console.log(e.code); }",
    ].join("\n"),
  },
  {
    id: "fs-mkdtemp-sync",
    question: "does mkdtempSync make a fresh directory carrying the prefix?",
    source: [
      "const fs = require('fs');",
      "const dir = fs.mkdtempSync('run-');",
      "console.log(fs.statSync(dir).isDirectory(), dir.startsWith('run-'), fs.readdirSync(dir).length);",
    ].join("\n"),
  },
  {
    id: "fs-truncate-sync",
    question: "does truncateSync cut a file to a length, and extend it short of its old one?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('t.txt', 'hello world');",
      "fs.truncateSync('t.txt', 5);",
      "console.log(fs.readFileSync('t.txt', 'utf8'));",
    ].join("\n"),
  },
  {
    id: "fs-lstat-sync",
    question: "does lstatSync answer about the path itself?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('l.txt', 'abc');",
      "const s = fs.lstatSync('l.txt');",
      "console.log(s.isFile(), s.isDirectory(), s.size);",
    ].join("\n"),
  },
  {
    id: "fs-constants",
    question: "are the access constants callers test against present with Node's values?",
    source: [
      "const fs = require('fs');",
      "const c = fs.constants;",
      "console.log(c.F_OK, c.R_OK, c.W_OK, c.X_OK);",
    ].join("\n"),
  },
  {
    id: "fs-stats-instanceof",
    question: "is a stat result an instance of the Stats class the module exports?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('s.txt', 'x');",
      "const s = fs.statSync('s.txt');",
      "console.log(typeof fs.Stats, s instanceof fs.Stats);",
    ].join("\n"),
  },
  {
    id: "fs-promises-append",
    question: "does fs.promises.appendFile behave like the sync form?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('p.txt', 'a');",
      "fs.promises.appendFile('p.txt', 'b').then(() => fs.promises.readFile('p.txt', 'utf8')).then((text) => console.log(text));",
    ].join("\n"),
  },
  {
    id: "fs-promises-copy-truncate",
    question: "do fs.promises.copyFile and truncate work through the promise surface?",
    source: [
      "const fs = require('fs');",
      "fs.writeFileSync('q.txt', 'abcdef');",
      "fs.promises.copyFile('q.txt', 'r.txt')",
      "  .then(() => fs.promises.truncate('r.txt', 3))",
      "  .then(() => fs.promises.readFile('r.txt', 'utf8'))",
      "  .then((text) => console.log(text));",
    ].join("\n"),
  },
  {
    id: "fs-promises-mkdtemp",
    question: "does fs.promises.mkdtemp make a directory?",
    source: [
      "const fs = require('fs');",
      "fs.promises.mkdtemp('tmp-').then((dir) => console.log(fs.statSync(dir).isDirectory(), dir.startsWith('tmp-')));",
    ].join("\n"),
  },
  {
    id: "timers-module-loads",
    question: "does require('timers') resolve at all?",
    source: ["const timers = require('timers');", "console.log(typeof timers.setTimeout, typeof timers.setInterval);"].join("\n"),
  },
  {
    id: "timers-module-fires",
    question: "does a timer taken from the module actually fire?",
    source: [
      "const timers = require('timers');",
      "timers.setTimeout(() => console.log('fired'), 1);",
    ].join("\n"),
  },
  {
    id: "timers-module-clear",
    question: "does clearTimeout from the module cancel its own timer?",
    source: [
      "const timers = require('timers');",
      "const handle = timers.setTimeout(() => console.log('must-not-print'), 1);",
      "timers.clearTimeout(handle);",
      "timers.setTimeout(() => console.log('still-alive'), 5);",
    ].join("\n"),
  },
  {
    id: "timers-promises-settimeout",
    question: "does the promise form of setTimeout resolve?",
    source: [
      "const timers = require('timers/promises');",
      "timers.setTimeout(1, 'value').then((value) => console.log('resolved', value));",
    ].join("\n"),
  },
  {
    id: "events-once-promise",
    question: "does events.once resolve on the next emit?",
    source: [
      "const { EventEmitter, once } = require('events');",
      "const emitter = new EventEmitter();",
      "once(emitter, 'ping').then((args) => console.log('once', args[0]));",
      "emitter.emit('ping', 'pong');",
    ].join("\n"),
  },
  {
    id: "assert-rejects",
    question: "does assert.rejects settle on a rejected promise?",
    source: [
      "const assert = require('assert');",
      "assert.rejects(Promise.reject(new Error('boom'))).then(() => console.log('rejected-ok'));",
    ].join("\n"),
  },
  {
    id: "process-exit-code",
    question: "does setting process.exitCode decide the exit status without exiting?",
    source: ["process.exitCode = 3;", "console.log('body-ran');"].join("\n"),
  },
  {
    id: "os-available-parallelism",
    question: "does os.availableParallelism report a positive worker count?",
    source: ["const os = require('os');", "console.log(os.availableParallelism() >= 1);"].join("\n"),
  },
  {
    id: "buffer-is-utf8",
    question: "does buffer.isUtf8 accept text and reject a lone continuation byte?",
    source: [
      "const { isUtf8 } = require('buffer');",
      "console.log(isUtf8(Buffer.from('héllo')), isUtf8(Buffer.from([0x80])));",
    ].join("\n"),
  },
  {
    id: "crypto-random-int",
    question: "does crypto.randomInt honour an exclusive upper bound repeatedly?",
    source: [
      "const { randomInt } = require('crypto');",
      "const seen = new Set();",
      "for (let i = 0; i < 200; i += 1) seen.add(randomInt(3));",
      "console.log([...seen].sort().join(','), randomInt(5, 6));",
    ].join("\n"),
  },
  {
    id: "util-parse-args",
    question: "does util.parseArgs read a flag and a value?",
    source: [
      "const { parseArgs } = require('util');",
      "const { values } = parseArgs({ args: ['--name', 'ada', '--verbose'], options: { name: { type: 'string' }, verbose: { type: 'boolean' } } });",
      "console.log(values.name, values.verbose);",
    ].join("\n"),
  },
];

export const API_CASES: readonly ApiCase[] = cases;
