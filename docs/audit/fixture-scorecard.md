# The twenty fixtures, run for the first time

**Date:** 2026-11-10. **Commit:** `fef2388` plus this change. **Instrument:** `tools/harness/run-fixture.ts`
(`npm run fixtures:run -- --all`), which drives each definition through the real `Container`, the real runtime and the committed
offline corpus, and writes evidence to `.evidence/fixtures/<slug>/`.

## Why this had to be built before anything else could be said about release

The gate had definitions, scoring, evidence writing, freeze checking and a threshold. It had no step executor: every test supplied
a hand-written one, so nothing had ever turned a `FixtureStep` into a run. That is a second reason the gate produces no score, and it
is independent of the first (no fixture is frozen).

The adapter is thin on purpose: the command line goes through `Container`, the same dispatcher the workspace uses, so `npm install`,
`npm run <script>` and `node <file>` behave here as they do in the app; stdout, stderr and the exit code come from the process record
rather than from parsing the terminal; the corpus is read from the committed bytes, so no network is involved.

Three limits of the adapter itself, stated rather than left to be discovered in a verdict:

1. A program's filesystem writes are not mirrored back to the project, so `file-exists` reads only what the definition seeded.
2. HTTP assertions need the preview proxy, which this runner does not wire. Such a fixture is reported as a harness fault, which the
   classification precedence already treats as "not evidence about the runtime".
3. A `run` step that leaves a server up has no exit code; it is reported as `-1`, not `0`, so an exit-code assertion cannot pass on
   a process that never exited.

## The finding that matters more than any verdict

**Seventeen of the twenty definitions contain no files at all.** Only `fixture-01`, `fixture-04` and `fixture-07` ship a program.
A definition that says `npm install` and then `node check.mjs` with no `package.json` and no `check.mjs` cannot pass, in this runtime
or in Node. So the pre-registered corpus is mostly skeleton: intent, steps and assertions, with nothing to run.

Measured, in evidence rather than by reading:

```
fixture-09  step 0  exit 1  npm: only npm install/npm ci and --omit=dev are supported; package arguments and other flags are refused
fixture-09  step 1  exit 1  node: cannot find module '/check.mjs'
fixture-12  step 0  exit 1  npm error: MISSING_PACKAGE_JSON: no package.json at /package.json
fixture-12  step 1  exit 0  (nothing to build)
```

A second mismatch sits on top of the first: eleven definitions ask for something the approved profiles refuse on purpose
(`npm install <package>` with arguments, and `pnpm install` for fixture-10). Those refusals are correct behaviour under D-4 and the
pnpm contract; the definitions predate both.

## Every verdict, with its cause

| Fixture | Verdict | Cause | Runnable as written? |
|---|---|---|---|
| 01 Vite dev server | HARNESS_BUG | needs the preview proxy | yes, but needs the proxy wired |
| 02 Next.js-ish boot | HARNESS_BUG | needs the preview proxy; **no files** | no |
| 03 | RUNTIME_INCOMPATIBILITY | **no files**, so `file-exists` fails | no |
| 04 core surface | **PASS, 6/6** | all assertions passed | yes |
| 05 | HARNESS_BUG | needs the preview proxy; **no files** | no |
| 06 | HARNESS_BUG | needs the preview proxy; **no files** | no |
| 07 CLI | **PASS, 3/3** | all assertions passed | yes |
| 08 express | HARNESS_BUG | preview proxy; **no files**; install with arguments | no |
| 09 is-odd | RUNTIME_INCOMPATIBILITY | install refused (arguments); **no files** | no |
| 10 pnpm | RUNTIME_INCOMPATIBILITY | `pnpm install` restricted by D-4; **no files** | no |
| 11 | RUNTIME_INCOMPATIBILITY | **no files** | no |
| 12 tsc build | RUNTIME_INCOMPATIBILITY | **no files**, so no `package.json` to install | no |
| 13 | HARNESS_BUG | preview proxy; **no files** | no |
| 14 cowsay | RUNTIME_INCOMPATIBILITY (expected) | **no files**; install with arguments | no |
| 15 sharp | RUNTIME_INCOMPATIBILITY | **no files**; native refusal never reached | no |
| 16 ws | RUNTIME_INCOMPATIBILITY (expected) | **no files**; install with arguments | no |
| 17 | RUNTIME_INCOMPATIBILITY (expected) | **no files** | no |
| 18 | RUNTIME_INCOMPATIBILITY | **no files** | no |
| 19 libsql | RUNTIME_INCOMPATIBILITY (expected) | **no files**; install with arguments | no |
| 20 drizzle | RUNTIME_INCOMPATIBILITY (expected) | **no files**; install with arguments | no |

Seven verdicts fell inside their own expected set (04, 07, 14, 16, 17, 19, 20), which is not the same as seven passes: five of those
fixtures accept `RUNTIME_INCOMPATIBILITY` as a legitimate outcome, so their "expected" is a statement about a refusal, not a success.

**Measured facts about the runtime, from the two runnable fixtures.** `fixture-04` exercises `fs`, `http`, streams, timers and
`EventEmitter` in one script with six assertions, and all six passed through the real container. `fixture-07` exercises a CLI with
argv, a file read and an exit code, and its three assertions passed. That is the first time the gate's own path has produced a PASS
rather than a hand-written executor's claim of one.

## What this means for release

The distance is now concrete and none of it is about the runtime engine:

| Blocker | Size | Owner |
|---|---|---|
| 17 definitions have no program | 17 files to write, then freeze | product decision: the contents were always explicitly an owner call |
| 11 definitions predate the approved npm/pnpm profiles | rewrite as `npm install` against the corpus, or flip expected to the refusal | owner |
| The runner does not wire the preview proxy, so 6 fixtures cannot be probed | 6 fixtures' worth of bridging, reusing the existing gateway | implementation |
| Program-written files are not readable by `file-exists` | needs a VFS readback path | implementation |
| No fixture is frozen | one sign-off per definition, after the four items above | owner |

Everything the runtime itself needs for the two runnable fixtures is already there, and the engine's own suite is green (989 unit
tests, 48 browser tests). The gate is unearnable because its corpus is empty and its runner is new, not because the interpreter
cannot run the programs.

## Limits of this evidence

- Chromium-independent: this runner is Node-side, so it measures the container and the runtime, not the browser Worker path.
- One engine, one machine, no network. A future real-registry milestone changes fixtures 08-20 entirely.
- Evidence is written to `.evidence/` (git-ignored). Nothing here is a frozen outcome: an outcome is only an outcome once a
  definition is frozen and its assertions are signed off.
