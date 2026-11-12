# API surface: the P0 block, measured

**Date:** 11 November 2026
**Base:** `main` at `a85d9af`
**Instrument:** `npm run diff:api` (`tools/differential/{api,api-cases}.ts`)
**Result:** 0/29 → **29/29 cases match real Node**

## Why this document exists

The audit of 11 November made the sharpest point of the whole project so far, and it was about the gate rather than the code:

> The gate cannot catch absent names, because it tests what exists, not what a real dependency asks for.

That is exactly right, and it is not a small gap. 1,263 tests were green while `fs.rmSync` — how every modern tool deletes a tree —
did not appear anywhere in `src/shims/fs.ts`. The suite had no way to say so: every test it owns calls members the shim already has.

So the first deliverable here is not a feature. It is a measurement that can see absence.

## The instrument

29 small programs, each asking one question ("does `rmSync` remove a tree, and does the tree then read as gone?"). Each is run twice and compared:

- **real Node**, staged as a `.cjs` file in a fresh temp directory per case;
- **this runtime**, against a fresh `FileSystem` and `InProcessRuntime`.

Comparison is **stdout plus exit status**, and the exit status is the load-bearing half. A program that dies on a missing member prints
nothing, so stdout alone reports two empty strings as a match: the audit's own §12.5 notes its version compared stdout only, which is precisely
how a missing name can look like agreement.

Two design rules the first version broke and this one encodes:

1. **Relative paths only.** The runtime's cwd is `/`, and real Node in this sandbox runs as root, so an absolute path in a case wrote to the
   machine's own filesystem root. Every case now uses relative paths.
2. **One fresh VFS per case**, not a shared one, or case N inherits case N-1's files and the table measures history rather than the surface.

## The baseline, before any change

`0 of 28`. Not "a few rough edges": every single case deviated, and the failures spread well past `fs`:

| Area | What the baseline showed |
| --- | --- |
| `fs` sync twins | `rmSync`, `appendFileSync`, `copyFileSync`, `accessSync`, `mkdtempSync`, `truncateSync`, `lstatSync`, `fs.constants`, `fs.Stats`: absent from the file entirely |
| `timers`, `timers/promises` | `MODULE_NOT_FOUND` — while the implementation existed elsewhere in the tree |
| `events.once` | absent, though `EventEmitter` itself is real |
| `assert.rejects` | absent, on the module and on `strict` |
| `os.availableParallelism` | absent |
| `process.exitCode` | accepted and ignored: `body-ran; exit=0` where Node exits 3 |
| `buffer.isUtf8` | absent: `buffer` was `{ Buffer }` and nothing else |
| `crypto.randomInt` | absent |
| `util.parseArgs` | absent |
| `process.hrtime` / `memoryUsage` / `uptime` | absent |

## What closed

### P0: `fs` synchronous surface

All of it composes over VFS calls that already existed. That is the finding behind the audit's number: the capability was there, the **names**
were not, and a missing name fails at the call site with nothing useful in the output.

- `rmSync(path, {recursive, force})` — children before parents; `EISDIR` without `recursive`; `ENOENT` without `force`.
- `appendFileSync`, creating a missing file (the reason it is everywhere in build tooling).
- `copyFileSync`, honouring `COPYFILE_EXCL` and reading the source before opening the destination, so copying a file onto itself cannot
  truncate it first.
- `accessSync` — existence, with the mode accepted and ignored because this VFS has no permission bits.
- `mkdtempSync` — six random base36 characters, retried on collision, and returned **in the caller's own shape**: `mkdtempSync("run-")` gives
  `run-abc123`, not an absolutised path, because a caller joins the answer onto its own base.
- `truncateSync` — both directions, since extending with zero bytes is the same operation in Node.
- `lstatSync` — `statSync`'s answer under the `lstat` syscall, because nothing in this VFS is a symlink. Named and documented rather than
  silently absent.
- `fs.constants` — `F_OK`, `R_OK`, `W_OK`, `X_OK`, `COPYFILE_EXCL`, with Node's values, all honoured. No `O_*` flags: `open` takes string flags
  here, so shipping five constants that change nothing would be five more names that lie.
- `fs.Stats` — a real class, so `statSync(p) instanceof fs.Stats` is true. This was not in the audit's P0 list and is worth the extra line:
  packages store a stat and ask it later.
- `fs.promises.appendFile`, `copyFile`, `truncate`, `mkdtemp` — the same helpers as the sync forms, so the two calling conventions cannot
  disagree about what appending means.

The callback forms (`appendFile`, `copyFile`, `truncate`, `mkdtemp`) are **derived** from the promise members through the existing `asCallback`,
which is how Node layers them and how the file already handled `readFile` and friends.

### P0: `timers` and `timers/promises`

`require("timers")` threw `MODULE_NOT_FOUND` while `src/shims/presets.ts` imported a timers preset and documented it as a substrate. A missing
feature and a missing line in a table look identical at the call site; this was the second.

Registered against **this run's scheduler**, not the platform's timers. The preset delegates to `globalThis.setTimeout`, which is the wrong clock
under a virtual scheduler: a program mixing the two would see `Date.now()` jump 900 ms for a timer that fired in a microsecond, and `unref`'d
timers would keep the host alive instead of the virtual loop. Handles carry `id`, `kind`, `ref`, `unref`, `hasRef` and `close()`.

`timers/promises.setInterval` is **refused by name**. Node ships it, so a caller will reach for it, but it returns an async iterator whose
`break` must clear a timer, and a version never run under this runtime's stop conditions would fail inside the caller's loop instead of at the
call.

### P1: the seven members the audit listed

| Member | What was wrong | What it does now |
| --- | --- | --- |
| `events.once` | absent | resolves with the emitted args; rejects on `error` while waiting for anything else; resolves with the error when `error` is what it waited for. `on`, `listenerCount`, `getEventListeners` alongside it |
| `assert.rejects` / `doesNotReject` | absent, including on `strict` | fulfils-on-reject with RegExp / string / class / field matchers; a fulfilled promise is a failure; present on `strict` too |
| `os.availableParallelism` | absent | `navigator.hardwareConcurrency` floored to at least 1, never a guess |
| `process.exitCode` | accepted and ignored | decides the status without exiting, and only when the run had not already failed: Node still exits 1 when a throw follows, so this can never mask a crash as a chosen status |
| `buffer.isUtf8` | `buffer` was `{Buffer}` | decoded with `fatal: true`, so the answer agrees with the parser the caller is about to use |
| `crypto.randomInt` | absent | rejection sampling, not modulo: a biased id or shuffle is a defect nobody notices until it matters |
| `util.parseArgs` | absent | long/short options, `--no-flag`, `--`, `multiple`, strict refusals by name; grouped short flags refused rather than misread as a value |
| `process.hrtime` (+`.bigint()`) | absent | `performance.now()` scaled to `[seconds, nanoseconds]`, with the previous-reading difference normalised |
| `process.memoryUsage` | absent | Node's five fields, from `performance.memory` where Chromium exposes it; a zero means "not exposed", and the header says so |
| `process.uptime` | absent | seconds since this run's process shim was created |

`crypto.getHashes()` returns `["sha1", "sha256"]` — only what `createHash` accepts, because `getHashes` is how a caller decides whether the
digest it needs is available, and promising md5 then throwing elsewhere moves the failure to a worse place.

## The three that finished P1

The audit's P1 list ended with `process.hrtime` "via performance.now()" and `process.memoryUsage` "with honest fields where the browser
exposes them", and this document's first version stopped one member short of that. They are closed now, with three more differential cases:

- **`hrtime`** returns `[seconds, nanoseconds]` and a `.bigint()`, scaled from `performance.now()` and rounded **once** at the end, so the two
  components always reconstruct the same instant. The difference form normalises a negative nanosecond part the way Node does, because
  `hrtime()` minus a previous reading does not have to land on a second boundary. Its zero point is the page's, Node's is the process's, and
  nothing may compare the numbers across processes: the case compares a difference, which is how the member is used.
- **`memoryUsage`** reports Node's five fields. `performance.memory` (Chromium) supplies `heapUsed` and `heapTotal`; a browser has no API for
  RSS, external or arrayBuffers, so `rss` is the heap total and those two are 0. **A zero here means "not exposed", not "none used"**, which is
  stated in the shim's own header rather than left for a caller to assume the happy reading.
- **`uptime`** is seconds since this run's shim was created, which is this program's start.

## What this does NOT claim

- **Not every absent name in the audit's 39.** This closes the P0 block and the seven named P1 members. The audit's P2 items (the dev-server
  reload lane, `fs.watch` semantics) are untouched and still need the decision it says they need.
- **Not a gate change.** `diff:api` exits 0 with a table, like `diff:event-loop`; `--strict` turns deviations into a failure. It is not in
  `verify`'s chain yet, deliberately: a measurement that fails the build would be a measurement someone would learn to silence.
- **No symlinks.** `lstatSync` agreeing with `statSync` is a documented consequence of that, not a claim that links work.
- **`open` still refuses numeric flags**, so the `O_*` constants are absent rather than present and ignored.

## Regression cover

- `tools/differential/api-cases.ts` — 29 cases, with their own guards in `tests/unit/differential.cases.test.ts` (unique ids, a question
  ending in `?`, a `console.log` on every path, no clocks or randomness).
- `tests/unit/shims.fs.surface.test.ts` — 23 tests.
- `tests/unit/shims.api-p1.test.ts` — 30 tests.
- `tests/unit/shims.http-client.test.ts` — 9 tests for the HTTP client refusal (ADR-0025).

The differential proves the answer matches Node. The unit tests keep a later edit from changing it without a Node oracle in the loop.
