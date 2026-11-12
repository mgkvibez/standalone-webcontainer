# Fresh baseline, 2026-11-12: what reproduces, what does not, and what the gate actually is

**Commit:** `db53ed3`. **Suite:** `npm run verify` exit 0 (1,433 tests / 103 files); browser lane 52 passed + 2 skipped.
This file exists because the audit asked for the evidence discrepancies closed **before** any new build, and because a test
count is not a compatibility result.

Nothing here changes a definition, a threshold or a classification. It re-runs what was claimed and records what happened.

## 1. What was re-run, and what the evidence now says

Every run went through the fixture executor (`npm run fixtures:run`) against the lane each claim names.

| Fixture | Claimed | Lane used now | Verdict now | Note |
|---|---|---|---|---|
| 08 express | PASS | `--registry=snapshot:fixtures/snapshots/express` | **PASS 3/3** | reproduced; the evidence committed before this run was a **failure** (`SNAPSHOT_MISSING: express`) from a run against the wrong snapshot |
| 04 core surface | PASS 6/6 | corpus (no install) | **PASS 6/6** | reproduced |
| 07 CLI | PASS 3/3 | corpus (no install) | **PASS 3/3** | reproduced |
| 11 Vite build | PASS | `--registry=snapshot:fixtures/snapshots/vite` | **PASS 2/2** | reproduced |
| 18 shadcn build | PASS | `--registry=snapshot:fixtures/snapshots/vite` | **PASS 3/3** | reproduced |
| 17 in-process sockets | PASS | `--registry=snapshot:fixtures/snapshots/vite` | **PASS 1/1** | reproduced, but **17 is a boundary fixture**, so it is not a front-end pass |
| 13 edit→HMR | PASS | `--registry=snapshot:fixtures/snapshots/vite` | **TIMEOUT** | `npm run dev -- --port 3300` exceeded its 60 s run budget. Not reproducible, see W-28 |
| 01 Vite dev | never a pass | `--registry=snapshot:fixtures/snapshots/vite` | **TIMEOUT** | same defect as 13 |

So the audit's arithmetic is right for a reason it did not have: the eight-pass list includes a **boundary** fixture (17), and
two of its eight do not reproduce at all today. `fixture-01` was never a pass; the scorecard records it as
`RUNTIME_INCOMPATIBILITY` on `SNAPSHOT_MISSING: esbuild-wasm`.

## 2. The real gate number

- 20 definitions, **all 20 still `status: proposed`**, so no verdict here is scoreable and the gate cannot be earned yet.
- 15 front-end-only, 5 boundary. 90% of 15 needs **14**.
- Front-end fixtures that have project files: **7** (01, 04, 07, 08, 11, 13, 18). Twelve have none, exactly as listed.
- Front-end fixtures that PASS in the evidence right now: **5** (04, 07, 08, 11, 18) = **33%**.

The documented 7/15 (46.7%) counted 01 and 13. Both are dev-server fixtures that cannot currently be reproduced. The honest
figure is 5/15.

## 3. Two defects found by doing this, both blocking a reproducible gate

**W-27 — evidence does not record its registry lane.** `.evidence/fixtures/<slug>/` is one slot per fixture, and
`verdict.txt`/`steps.json` carry no lane. A run against the wrong lane **silently replaces** a passing evidence set with a
failure. That is exactly how `fixture-08`'s committed evidence came to say `SNAPSHOT_MISSING: express` while the docs said PASS
both from the network and from the express snapshot, and how `fixture-13`'s PASS was replaced twice today (once by a corpus-lane
run, once by a vite-snapshot run that timed out). Evidence is the thing an auditor is asked to trust: it must name the bytes it
ran against and the run that produced it, and one lane must not be able to overwrite another's result without saying so.

**W-28 — the harness lane cannot observe a held-open server.** W-26 fixed this for the product: a server that never ends
announces its ports live, through the broker's message funnel, instead of at settle. The in-process client the fixtures use has
no `onPorts` implementation, so `Container.execute("npm run dev …")` never resolves and the step dies on its budget. Measured
directly with `tools/probe-vite-start.ts`: **Vite 5.4.21 boots inside this runtime and prints its listening URL in about five
seconds**; the harness cannot see it. That is why 01 and 13 are unmeasured, it is the single reason the two most important
front-end fixtures have no verdict, and it is a harness defect rather than a runtime one. It must be fixed before any gate
number is quoted.

## 4. Documentation drift, reconciled

- `README.md` said the browser lane runs **48 tests across 15 spec files**. It collects **54 (52 passed + 2 skipped) across 20
  spec files**. Corrected here.
- The scorecard's "superseded" rows for 11, 13, 17 and 18 are now stale in the other direction for 13. The scorecard points at
  this file rather than keeping a second, drifting copy of the table.
- The scorecard still describes `fixture-13` as PASS. This file is the operative statement; the scorecard row keeps its history
  and points here.

## 5. What the audit is right about, confirmed against the tree rather than the README

- **The product cannot install a real package.** `src/browser/main.ts` loads `loadOfflineRegistry()`, whose corpus is the ten
  synthetic `@corpus/*` packages. The real installer, the network lane and the snapshot lane exist and are measured, but they are
  reachable only from the fixture runner. Nobody can open the workspace and `npm install` a real dependency.
- **The shell is a finite command interpreter.** `src/container/commands.ts` recognises a fixed set: no `sh`, no pipes, no
  redirection, no job control, and `npx`/`pnpm`/`yarn` are refused by name.
- **The process Workers are not a security boundary.** ADR-0019 says so; W-19 (hardening) and W-6 (runtime origin, needs a
  registrable domain) are open. COOP/COEP are sent and `crossOriginIsolated` is asserted in the browser lane, but the runtime is
  same-origin with the host, so a hostile project inherits the host's capabilities. No public multi-user execution.
- **Twelve of twenty fixtures have no files**, and none are frozen.

## 6. The decision the audit asked for, stated for the owner

The audit's P0 is a question I should not answer by continuing to build: **does this project stay a custom V8 + shim runtime, or
does its target require a different execution substrate?** ADR-0001 is not quietly amended either way.

| Option | What it means | Cost to reach "Vite + React works end to end" | What is lost |
|---|---|---|---|
| **A. Stay: native V8 + shims** (ADR-0001, as built) | Keep closing measured gaps, with the differential harness as the oracle | Unbounded in the tail in principle: each package can surface one more builtin or loader subtlety. The measured trajectory is real: Vite boots, express serves, `vite build` completes | Nothing already built. The ceiling stays "Node-compatible, not Node" |
| **B. Swap the substrate: WASI Node in the browser** | Run real Node compiled to WASM inside the Worker, keeping the workspace, kernel, gateway and preview | Large and front-loaded: a new execution path, a different syscall story, and the existing shims stop being load-bearing | The engine work that makes this repository distinctive, and the differential evidence behind it. Its own ceiling is not higher: native addons are absent there too |
| **C. Narrow the claim** | Keep the substrate, stop claiming Node compatibility, define the contract as "the packages we have measured" | Cheapest, and the only option that can be finished on a schedule | The StackBlitz comparison the project is measured against |

My recommendation, as the implementer rather than the decider: **A, with C as the way the claim is written**, re-evaluated after
the first React + Vite journey works end to end. The reason is evidence rather than preference: this runtime boots real Vite,
serves real express through the real preview gateway and completes a real `vite build`, and each of those arrived by closing one
specific measured gap. Option B spends the next month re-earning that position in a different language runtime for a ceiling that
is not higher on the axis that matters.

If B is chosen, ADR-0001 is superseded by a new ADR rather than edited, and the honest sequencing is: freeze the current
substrate as the reference implementation, port the fixture gate first so the comparison is measurable, then rebuild.

## 7. Proposed order of work

1. **W-28** (harness held-open servers): the two dev-server fixtures cannot be measured without it, so it precedes any gate claim.
2. **W-27** (evidence names its lane): a result has to be attributable before it can be accepted.
3. Re-run all eight, regenerate evidence under its lane, and publish one table generated from the evidence rather than written by
   hand.
4. The product's real-registry path (audit P2), because it is the gap between "the runner can install express" and "a person can".
5. Security and isolation (audit P1) before anything multi-user.
