# Baseline, 2026-11-13: three measurement defects closed, and the gate re-counted

**Base commit:** `30bdd41`. **Suite:** `npm run verify` exit 0 (1,463 tests / 107 files). **Browser lane:** unchanged from
`db53ed3` (52 passed + 2 skipped), since nothing in this round touches the page.

`docs/audit/baseline-nov-12.md` is the audit that produced the defects; this file is what happened when they were fixed. It
supersedes that file for the score, and keeps its history rather than editing it.

Every verdict below came from `npm run fixtures:run` in the lane the fixture names, and every record now carries
`provenance.json` with a `runId`, a definition hash, the registry lane and snapshot digest, the argv, the budgets, the verdict,
and **whether the tree was dirty**. These eight runs were made from a tree 67 files ahead of `30bdd41`, and the evidence says so
in as many words.

## 1. What was fixed, and what each fix was measured by

**W-27 — evidence now names the run that produced it.** `src/harness/provenance.ts` gives each execution an identity; the runner
refuses to write evidence without one, refuses to overwrite a record from a different lane, refuses a record it cannot read, and
treats pre-provenance evidence as *unattributed* rather than "nothing to replace". Evidence bundles are schema 4, with a per-run
record under `runs/<runId>.json`. 15 tests.

**W-28 — the harness can see a held-open server.** `tools/harness/in-process-client.ts` now implements the ports report the
process Worker has, applies the kernel's own hold-open rule, and can shut servers down deterministically; a step's readiness is a
counted real request with its deadline recorded on the step (`src/harness/assertions.ts`), never a banner. Measured through vite
5.4.21 in this container: **port bound at +1.1 s, first answer at +5.1 s** — which is why "running" and "ready" had to be
different facts. Removing the hold-open rule makes a program that resumes stdin (vite's own shape) hang, and the regression test
says `hung`. 11 tests.

**W-29 — a sink that claims `isTTY` now carries the TTY API.** `process.stdout` reported `isTTY: true` and had no `clearLine`,
so `vite build` died at `dep-BK3b2jBa.js:65845` with `process.stdout.clearLine is not a function`. Fixtures 11 and 18 could not
pass while the flag lied, on any commit. The sink now carries `clearLine`, `cursorTo`, `moveCursor` and `clearScreenDown` when a
terminal is attached, and carries none of them (and no `isTTY`) when it is not. This is the same class of defect as W-26's
"a method that returns success and does nothing": the surface said yes and the behaviour said no. 4 tests.

Two further defects surfaced while making W-28 work, and both were fixed in the same change:

- **A server lived for one command.** The harness built a fresh runtime and filesystem per *run*, so `fixture-13`'s step 2 edit
  landed in a new filesystem and the observation found no server on port 3300 at all. One runtime now lives for a *fixture* and
  `reset()` discards it, so isolation is per fixture, exactly as before.
- **Readiness was not part of a step at all.** Bound port ≠ answering server, so a step that leaves a server now waits for the
  first real answer under a 15 s readiness deadline, and records the attempts, the elapsed time and the status.

## 2. The reconciled table, all twenty definitions

Eight have project files. Twelve have none, and no verdict about the runtime can be read from those: they fail at the first
assertion because there is nothing to run. Their committed evidence is schema 2, written before provenance existed, and is
**unattributed**: it is history, not a result.

| Fixture | Lane | Files | Verdict in evidence | Note |
|---|---|---|---|---|
| 01 Vite dev | vite snapshot | 3 | **PASS 2/2** | first real verdict; was recorded as "never a pass" |
| 04 core surface | corpus | 2 | **PASS 6/6** | |
| 07 CLI | corpus | 3 | **PASS 3/3** | |
| 08 express | express snapshot | 1 | **PASS 3/3** | |
| 11 `vite build` | vite snapshot | 5 | **PASS 2/2** | needed W-29 |
| 13 edit→dev server | vite snapshot | 4 | **PASS 2/2** | needed W-28 and the per-fixture runtime |
| 17 in-process sockets | vite snapshot | 5 | **PASS 1/1** | **boundary**, not a front-end pass |
| 18 shadcn build | vite snapshot | 5 | **PASS 3/3** | needed W-29 |
| 02, 03, 09, 10, 12, 14, 19, 20 | - | **0** | not measurable | no project files |
| 05, 06, 15, 16 | - | **0** | not measurable | no project files (15 is also the open refusal-model decision) |

Fixtures 11 and 18 are the correction that matters most in this file. The Nov 12 audit recorded both as **reproduced**. They
were not: re-running them at `30bdd41` with no local changes failed with `process.stdout.clearLine is not a function`, and the
"reproduced" rows were written from the evidence on disk rather than from a run. That is the same error the audit was about, made
by me, in the document about it. The rows are corrected here and the cause is W-29.

## 3. The gate number, computed rather than quoted

- 20 definitions, **all 20 still `status: proposed`**, so nothing here is scoreable and the gate cannot be earned today.
- 5 boundary (05, 06, 15, 16, 17), 15 front-end-only. 90% of 15 needs **14**.
- Front-end fixtures with project files: **7** (01, 04, 07, 08, 11, 13, 18).
- Of those, PASS in evidence right now: **7**. **7/15 = 46.7%.**

The number moved from 5/15 (33%) to 7/15 (46.7%) not because two fixtures started working unexpectedly, but because they could
finally be measured: both were dev servers with no verdict, and one of them (`vite build`) never had a working `stdout` either.
The remaining gap to the gate is not eight missing passes of polish — **eight front-end fixtures have no project files at all**,
and until they do they measure nothing.

## 4. What this does not claim

- **No fixture is frozen.** All 20 are `proposed`; the gate is not scoreable and this file does not move it.
- **The figures are from a dirty tree.** The eight runs are the code in this branch, recorded as 67 changed files over
  `30bdd41`. They are pinned to a run id, and the merge commit re-runs them.
- **Vite runs from a frozen snapshot, not the registry.** The product's page still installs from the `@corpus/*` corpus only;
  the snapshot lane belongs to the fixture runner.
- **`fixture-13`'s pass is the edit-to-server loop, not module-level HMR through the page.** W-26 proved the page-side loop
  separately with a purpose-built server; the two are complementary measurements, and neither one is a browser dev server.

## 5. Next, in the owner's order

W-27 and W-28 are closed, so the order the owner authorised is at step 4: reproduce 01 and 13 (done, above), recalculate the
baseline (this file), and stop for architectural review before choosing the next compatibility build. The open decision that
remains is not mine to take: the refusal model for `fixture-15` (`UNSUPPORTED_BY_DESIGN` versus an ordinary program failure),
and whether the next substantial work is the eight empty front-end fixtures or the product's real-registry path.

---

## 6. Second round, 2026-11-13: the registry lane is real, and two more fixtures measure it

Sections 1-5 above were about measuring honestly. This one is about what the measurement then found: the container could not run a
package manager's own two jobs, compiling and shelling out, and the gate could not see it because those fixtures had no project files.
`fixture-09`, `fixture-12` and `fixture-14` now do, and they run in the **network** lane against `registry.npmjs.org`.

| Fixture | Lane | Verdict | What it proves |
|---|---|---|---|
| 09 npm install → require | network | **PASS 2/2** | a real tarball installs, then a `require` of a package with an `exports` map and its own dependency answers correctly |
| 12 TypeScript compile | network | **PASS 2/2** | `npx tsc -p tsconfig.json` compiles a project and emits `dist/index.js` |
| 14 cowsay via npx | network | **PASS 2/2** | an installed package's binary runs through `npx --no-install` |
| 03 shadcn add | network | **RUNTIME_INCOMPATIBILITY** | `npx --yes shadcn@latest` needs an on-the-fly fetch, refused by name with the command that would work |

Four defects stood between "installs" and "compiles", and each was a lie of the same shape as W-26 and W-29: a surface that said
something untrue about itself.

- **W-30 — the exit status was read from stderr text.** A command refused by policy writes its reason to the *system* stream, so a
  stderr-only reader matched nothing and recorded **exit 0**. `fixture-12` passed its `exit-code equals 0` assertion on a command that
  never ran. `Container.lastExitCode` now exists, installs report honestly, and the harness reads it instead of guessing. 6 tests,
  mutation-checked; my first version of the step-level test was vacuous because it went through a layer that blocks `npx` separately,
  so it was retargeted at the executor the CLI actually runs.
- **W-31 — `process.browser` was `true`.** TypeScript 5.9 asks `isNodeLikeSystem()`, which is `typeof process !== "undefined" &&
  !!process.nextTick && !process.browser && typeof require !== "undefined"`. Our own shim answered "this is a browser", so `sys` came
  out `undefined` and `tsc` died with `Cannot read properties of undefined (reading 'tryEnableSourceMapsForHost')`, naming nothing that
  led here. `browser` is now `false`, with the measurement written in the shim.
- **W-32 — `fs.writeSync(fd)` was refused.** So a compiler that compiled perfectly could not emit: `TS5033` on every output file. The
  shim now implements both of Node's overloads as a read-modify-write of the whole file, honouring the descriptor cursor and `a`.
- **W-33 — `npx` collected flags by pattern instead of by position.** `tsc -p tsconfig.json` lost its `-p`, leaving the compiler a bare
  path it read as a source file: `error TS6054: File 'tsconfig.json' has an unsupported extension`. Only the flags before the package
  name belong to `npx` now; everything after it is the program's argv, verbatim.

One observation filed but not chased: a declared range that matches no published version (`^1.0.0` against a fake registry serving only
`2.0.0`) installs **nothing** and reports success. The npx tests found it; it is not on the path to any fixture.

### The gate number, again

- Front-end fixtures with project files: **9** (01, 04, 07, 08, 09, 11, 12, 13, 18).
- Of those, PASS in evidence: **9**. **9/15 = 60%.** Reference: 17 is boundary and does not count.
- The gap to 90% is now **five** fixtures with no project files (02, 10, 19, 20 and the open refusal-model fixture 15), not eight.
- Still **all 20 `proposed`**, so nothing is scoreable and the gate is unearnable regardless of the percentage.

### Not claimed

- None of this was verified on `main`; the runs describe a dirty tree, and each `provenance.json` says so.
- `npx` is not a package installer. `--yes <spec>` stays refused until a fetch-into-the-VFS path exists, which is why `fixture-03`
  is an incompatibility rather than a pass.
