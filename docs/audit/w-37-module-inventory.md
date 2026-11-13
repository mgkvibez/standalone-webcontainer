# W-37: the seven stranded modules, assessed one by one

**Status:** investigation complete, recommendations only. **Nothing deleted, migrated or modified.**
**Register:** W-37 stays **open** until a per-module ruling is recorded.
**Method:** `npm run guard:modules` (`tools/checks/module-reachability.ts` + `tools/checks/stranded-modules.ts`) supplies
the consumer graph; every claim below is read from that graph or from the commit that produced the current state.
**Baseline:** `main` @ `55481f1` (PR #92 merged), `npm run verify` exit 0 at 1,551 tests / 114 files, browser lane 55
passed / 2 skipped. W-22 is untouched by this document.

## Why these seven are stranded, in one paragraph

On 2026-11-10 at 10:05 (`94e3c92`) the fixture CLI stopped interpreting commands itself and started running them through
the **product's** `Container`. Its commit message gives the two reasons, and both are still the reasons: the previous
executor could not read a file a program had just written (writes exist only in the live VFS) and could not probe a
server it started (that needs the real `PreviewGateway`). Five hours earlier, at 05:06 (`d646949`), a pnpm command
vocabulary had been added to that same interpreter. The interpreter has been unreachable since 10:05 that morning; the
test suite has kept it green for three days.

That is the whole shape of W-37: **not seven unrelated orphans, but three displaced generations** - a step interpreter,
a service-worker protocol, and one encoding helper, each replaced by a later design, plus a barrel that never had a
consumer.

---

## 1. `src/harness/execute.ts` (359 lines)

**Original purpose.** The fixture step interpreter required by ADR-0009: take a definition's step, plan it, run it against
a `StepRuntime`, and return a `StepExecution` carrying a termination and the raw evidence assertions read. Its header
states two rules that still govern the harness: an unbuilt capability is a **harness** fault and never
`UNSUPPORTED_BY_DESIGN`, and a project's own mistake is a normal exit code and stderr, not an exception.

**History.** `87fd01a` (2026-11-04) created it with the command interpreter; `d10a8e0` (11-04) added npm scripts and
installed bins; `423b68e` staged ES modules through the CommonJS loader; `c1e4de7` made a refusal a step outcome;
`d646949` (11-10 05:06) added the pnpm profile. **No commit since 94e3c92 (11-10 10:05) has touched it.**

**Consumers now.** `src/harness/index.ts:27` (the stranded barrel, item 7) and five test files. **Zero `tools/` consumer,
zero other `src/` consumer.** `createStepExecutor` is constructed only by tests: `fixtures.run.test.ts:65,83`,
`harness.command.test.ts:162,521`, `harness.fixture-e2e.test.ts:111,140,177,276,305,328,386`, `harness.project.test.ts:165`,
`harness.restriction.test.ts:142`.

**Is any product capability dependent on it indirectly?** One, and it is a finding rather than a reason to keep the file.
`runner.ts` (live: the CLI imports it) supports a step termination of `"restricted"` and classifies it as
`UNSUPPORTED_BY_DESIGN` (`src/harness/runner.ts:270-280`). The **only** producers of `termination: "restricted"` in the
tree are `command.ts` and `execute.ts`. `tools/harness/fixture-executor.ts` returns only `"ok"` or `"harness-fault"`. So
since 2026-11-10 the gate's `UNSUPPORTED_BY_DESIGN` classification has had no live supplier, and a policy refusal
reaches the verdict as an ordinary exit code. Nothing is scored wrongly today because no shipped fixture expects that
classification (fixture-12 expects `PASS` and is about `npx` being refused *and reported*, and fixtures 15 and 19 have no
files yet), but the register's fixture-freezing work will need it, and ADR-0010 amendment 2's three-way distinction
("a runtime refusal, our defect, a policy we chose") currently has its third case unproduced.

**Does the functionality exist elsewhere?** Execution does, and better: `tools/harness/fixture-executor.ts:137-190` drives
`container.execute(session.id, step.command)`, then reads `container.lastExitCode`, process state and `previewPorts`. The
classification vocabulary does **not** exist elsewhere (see above).

**Is it unfinished capability or duplicated capability?** Both, in a specific split:

| Part of `execute.ts` | Verdict |
| --- | --- |
| command planning to runtime calls, per command kind | **Duplicated** by `Container` (install, `npm ci`, `npm run`, node, `npx`, builtins), which is also where two rounds of fixes landed (W-30 to W-33). |
| producing a `Restriction` record for a chosen policy | **Unfinished and displaced**: written, tested, and now unreachable through the product. |
| the offline-registry `npx` gate | **Divergent** from the product, and documented as a test hazard. |

The divergence is already written down in the repo, by this project, in a test file:

> It goes through `runDefinition`, the executor the CLI actually runs, and not `createStepExecutor`: that one gates `npx`
> earlier with its own offline-registry policy and returns exit 1 whatever the container said, so a test against it passes
> even with the defect in place. (Checked by mutation: reverting the fix leaves this test red and that one green.)
> - `tests/unit/harness.fixture-e2e.test.ts:409-413`

Two executors that answer the same command string differently is the reason this cluster matters more than its line
count. `src/harness/execute.ts:19` returns a **restriction** for `npx <missing bin>`; `src/container/container.ts:848-906`
resolves by binary name and refuses with its own wording. Neither is wrong in isolation; having both means a test can be
green about behaviour no user can reach.

**Do its tests verify product behaviour?** Four answer yes through the wrong door, two answer no:

| Test file | Tests | What it actually pins |
| --- | --- | --- |
| `harness.command.test.ts` (551 lines) | 45 | The stranded interpreter itself (`parseStepCommand` + `createStepExecutor`). **Stranded by construction.** |
| `harness.scripts.test.ts` (119 lines) | 11 | `scripts.ts` resolution rules, against a real npm-shaped tree. Pins a duplicate of the Container's own lookup. |
| `harness.restriction.test.ts` | 9 | `restriction.ts` - live via `runner.ts` - but driven through the fake executor. **Migration target.** |
| `harness.project.test.ts` | 9 | `project.ts` staging rules - live via the CLI - driven through the fake executor. **Migration target.** |
| `fixtures.run.test.ts` | 4 | Real corpus definitions (fixtures 04, 07) through the **in-process** runtime. Genuinely product-relevant evidence, wrong executor. **Migration target.** |
| `harness.fixture-e2e.test.ts` (436 lines) | 9 | End-to-end classification through the fake executor, **plus** one test that already uses `runDefinition` and says why (quoted above). **Migration target.** |

**Consequences of removing it.** No `src/` module gains a broken import: pruning it strands nothing else, because
`restriction.ts` is also reached from `runner.ts`, which the CLI imports. What breaks is declarative and countable:
the barrel's re-export (`index.ts:27`), 56 tests that exist only to exercise it (`harness.command` 45 + `harness.scripts`
11), and the *driving harness* of 31 more tests whose subject is live (`restriction` 9, `project` 9, `fixtures.run` 4,
`fixture-e2e` 9) and which would need re-pointing at `runDefinition` / `Container`.

**Recommendation: MIGRATE, then REMOVE.**
1. Move restriction production onto the product path - the `Container` already distinguishes `"refused"` and
   `"unsupported"` command kinds (`container.ts:283-294`), so `fixture-executor.ts` can map them to a `Restriction`
   record and the runner's `UNSUPPORTED_BY_DESIGN` branch becomes live again. Without this, removal silently deletes a
   classification the register expects for fixtures 15 and 19.
2. Re-point the four live-subject test files at `runDefinition`. This is the W-26 lesson applied: they should assert the
   path the CLI runs.
3. Then delete `execute.ts` and the two tests that exist only for it.

---

## 2. `src/harness/command.ts` (423 lines)

**Original purpose.** Parse a fixture's command string into a plan: `install`, `list-scripts`, `run-script`, `node`,
`exec`, `invalid` (`command.ts:37-85`), plus the `npx` refusal policy and - later - the **pnpm command vocabulary under
the declared `pnpm-resolution` profile** (`d646949`), with its mandatory disclosure string
(`PNPM_RESOLUTION_DEVIATION`, `command.ts:27-33`) required by `docs/phase-6/pnpm-command-contract.md`.

**History.** `87fd01a` (11-04) then `ec9b6ea` (npx as bin resolution, install-shaped forms refused by name), `14cc6d4`
(a chosen policy must never be filed as a defect), `d646949` (11-10 05:06, pnpm vocabulary). Five hours later the CLI
stopped calling it.

**Consumers now.** Two test files, and nothing else: `tests/unit/harness.command.test.ts:11` and
`tests/unit/fixtures.corpus.test.ts:17`. The latter is worth naming precisely, because it is the one corpus check that
depends on this module: `fixtures.corpus.test.ts:67` calls `parseStepCommand` inside
"runs only scripts its own package.json defines", so the rule *"a definition may only `npm run` a script it ships"* is
currently enforced by the interpreter the gate does not use.

**Is any product capability dependent on it indirectly?** No. The `Container` parses commands independently
(`container.ts:256` documents its own supported set and commands `npm install`, `npm ci`, `npm run <script> [-- args]`).

**Does the functionality exist elsewhere?** The command vocabulary does. **The pnpm profile does not, and this is the
substantive discovery in this module.** The product refuses pnpm by name - `container.ts:258`: `"Not supported: pnpm,
yarn, sh, bash, zsh."` - while `docs/phase-6/pnpm-command-contract.md` records the profile as **implemented**
(Nov 10 2026) with four owner decisions. Its D-1 ruling is the important one:

> the `pnpm-resolution` profile must not score fixture 10, and no `pnpm` command may be counted toward the gate ... the
> profile is a **command-vocabulary** facility, tested by its own unit tests.

So the profile was deliberately never a scoring path - but it was also, without anyone deciding it, never a *reachable*
path: from 10:05 the same morning, `pnpm install` in a fixture is refused by the Container, and fixture-10
(`pnpm install` then `node check.mjs`) is unscoreable for a second reason on top of D-1. Two documents now disagree about
what this project does when a project says `pnpm`: the contract says there is a vocabulary with an approved refusal
wording per case; the product says "Not supported".

**Is it unfinished capability?** Yes: a declared, documented, partially-implemented capability with no route to a user,
which is precisely the state P0-6 ruled on for `presets.ts`. The difference from P0-6 is that a written contract
depends on this one, so removing it is a documentation decision as much as a code one.

**Do its tests verify product behaviour?** No for `harness.command.test.ts` (45 tests, all about the interpreter and the
pnpm profile). Partly for the one corpus assertion, whose *rule* is sound and whose *mechanism* is stranded.

**Consequences of removing it.** `harness.command.test.ts` goes (45 tests); the corpus rule at
`fixtures.corpus.test.ts:60-77` needs re-expressing against the product's parser or the Container's `npm run`; and
`docs/phase-6/pnpm-command-contract.md` must stop claiming an implementation that no longer exists - either by retiring
the profile (D-1 already forbids it from scoring) or by moving the vocabulary into the Container, where a pnpm command
would meet the same parser a `npm` command does.

**Recommendation: MIGRATE one decision, REMOVE the rest.** The decision is the pnpm profile's fate, and it is the
owner's, not mine: **(a)** retire it - the Container's refusal stands, `docs/phase-6/pnpm-command-contract.md` gets a
superseded annotation, fixture-10's D-1 reasoning is preserved verbatim; or **(b)** move the vocabulary into the
Container's parser so the profile is answerable where it is asked. Recommendation: **(a)**, because D-1 already removed
its scoring role, the Container's refusal is honest and uniform, and (b) means implementing pnpm's semantics behind a
refusal that currently tells the truth. Either way, re-express the corpus script rule against the product parser, then
delete `command.ts` with its 45 tests.

---

## 3. `src/harness/scripts.ts` (151 lines)

**Original purpose.** Project-side script and binary lookup for the fixture interpreter: `readPackageScripts`,
`listInstalledPackages`, `resolveBin`, and a `ProjectError` distinguishing "the project is wrong" from "the harness is
wrong".

**History.** `d10a8e0` (2026-11-04), "run npm scripts and installed bins, which unblocks seven fixtures". Untouched since.

**Consumers now.** `tests/unit/harness.scripts.test.ts:11` only. Nothing else in `src/`, `tools/` or `tests/`.

**Is any product capability dependent on it indirectly?** No. The `Container` implements the same two lookups for
`npm run` (`container.ts:351,362` read `scripts[name]`) and for `npx` (`#npx` at `container.ts:848`, including the W-33
fix: a binary name is resolved through the package that publishes it, not through `/node_modules/<name>`).

**Does the functionality exist elsewhere?** Yes, twice over, and the product's copy is the one that has been repaired
under audit (W-30 to W-33). This module is the older copy that still has a green suite.

**Is it unfinished capability?** No. It is complete and unused.

**Do its tests verify product behaviour?** No. Eleven tests pin resolution rules against a real npm-shaped directory
tree (a good technique) but against the copy the product does not call. The rules themselves are product facts -
"a script naming an uninstalled bin is a project error, not a harness bug" - and they would be worth keeping if they ran
against the Container's resolution.

**Consequences of removing it.** `harness.scripts.test.ts` goes (11 tests), and with it the only direct test of "which
bin does this package publish" as a standalone rule. That coverage should land on the Container, not vanish.

**Recommendation: REMOVE, with the resolution rules re-asserted against the Container.** This is the cleanest of the
seven: pure duplicate, one test file, no documented contract.

---

## 4. `src/network/service-worker.ts` (125 lines)

**Original purpose.** `createPreviewFetchHandler(gateway)` (`service-worker.ts:78`): a fetch handler that answers
`/preview/<port>/...` by calling the `PreviewGateway` **directly**, handling HEAD/204/205/304 no-body rules, an
unparseable URL (400), a body-read failure (500), a 504 on deadline, and passing non-preview URLs to the network. Written
when the assumption was that a service worker could reach the runtime in its own scope.

**History.** `b476c12` (2026-11-03, "fetch handler and worker bridge, so a browser request reaches a server"). Untouched
since.

**Consumers now.** `tests/unit/network.service-worker.test.ts` (14 tests) only.

**Is any product capability dependent on it indirectly?** No - the opposite. A service worker **cannot** touch the page's
runtime (separate global scope), which is why `sw-bridge.ts` was written in the same commit, and why the shipped handler
is a hand-written file the page cooperates with.

**Does the functionality exist elsewhere?** Yes: `public/preview-sw.js` (190 lines, 8,045 bytes). Comparison, behaviour by
behaviour:

| Behaviour | `service-worker.ts` | `public/preview-sw.js` |
| --- | --- | --- |
| Route `/preview/<port>/...` | yes | yes (`PREVIEW_ROUTE`, line 1), **plus** a fallback to the requesting client's own URL (line 40) |
| Reach the runtime | direct `gateway` call - impossible in a real SW | `MessageChannel` to the page, correlated by id (lines 95-150) |
| Streaming | none (single `Response`) | `ReadableStream` with `start`/`chunk` messages (lines 100-140) |
| HEAD / 204 / 205 / 304 no body | yes | yes (`NO_BODY`, line 108) |
| Unparseable URL gives 400 | yes | yes (`plain()`, line 182) |
| Cross-origin isolation headers | none | `decorate()` adds COOP/COEP/CORP per response (line 83) |
| WebSocket client injection | none | `serveWebSocketClient()` (line 21) |
| Page half | n/a | `src/browser/preview-shell.ts`, which adds HTML injection and a socket relay |

So the shipped file is a **superset** in routing and security, and deliberately different in the one place
`service-worker.ts` cannot be right: it does not call the gateway, it asks the page. This module is not duplicated by
`public/preview-sw.js`; it is **superseded** by the design `public/preview-sw.js` implements.

**Is it unfinished capability?** No. It is a design generation that was completed elsewhere and later.

**Do its tests verify product behaviour?** No. Fourteen tests pin a handler no service worker runs, against a protocol no
page speaks. They give a false impression that preview routing is unit-tested, when the shipped handler is covered only
end-to-end by the browser lane (`tests/browser/isolation.spec.ts` and the preview specs).

**Consequences of removing it.** `network.service-worker.test.ts` goes (14 tests). The semantic rules it pins - HEAD and
the three bodyless statuses carry no body, an unparseable preview URL is a 400, a non-preview URL passes through - are
**still true of the shipped file** and would otherwise lose their only written form.

**Recommendation: REMOVE the module, and move the still-true rules onto the shipped artefact.** `public/preview-sw.js` is
plain JavaScript with one global (`self`) and standard `Request`/`Response`/`ReadableStream`, so a unit test can load it
under a stubbed `self` and assert the no-body and 400 rules against the code that actually ships. That converts 14 tests
about a ghost into a handful of tests about the product, which no other change in this document buys as cheaply.

---

## 5. `src/network/sw-bridge.ts` (196 lines)

**Original purpose.** The messaging half of the same design: `createWorkerSideProxy({send,timeoutMs})`
(`sw-bridge.ts:88`) owns correlation and the deadline in the worker, `createPageSideResponder({gateway,reply})` answers in
the page, a reply arriving after the deadline is dropped, expiry is a 504, and `closeAll()` on teardown. Protocol:
`preview-request` then `preview-response` or `preview-error` (three message types, no streaming).

**History.** `b476c12` (2026-11-03), same commit as item 4.

**Consumers now.** `tests/unit/network.sw-bridge.test.ts` (10 tests) only.

**Is any product capability dependent on it indirectly?** No. The page half of the shipped design is
`src/browser/preview-shell.ts`, which imports `protocol.ts`, `html-inject.ts` and `socket-relay.ts` - **not** this module.

**Does the functionality exist elsewhere?** The messaging does, with a different and richer vocabulary:
`request` then `start` / `chunk` / `response` / `error`, with the port kept open across chunks
(`preview-shell.ts:54-99`, whose comment explains why only `response` and `error` may close it: "closing on the first
chunk would turn every stream into a one-chunk response that then hangs"). The shipped pair therefore covers correlation,
deadlines and ordering, and adds streaming; it does **not** cover this module's exact protocol, because that protocol is
no longer spoken.

**Is it unfinished capability?** No - although it is the one place in this pair with a real idea worth preserving: the
deadline-is-504 and late-reply-is-dropped rule, which the shipped pair implements in `public/preview-sw.js` (a timer that
ends the handler, and a `message.id !== id` early return).

**Do its tests verify product behaviour?** No. Ten tests pin the older protocol's invariants. The invariants are correct
and the product implements them elsewhere; the tests address the wrong artefact.

**Consequences of removing it.** `network.sw-bridge.test.ts` goes (10 tests). Nothing imports it, so nothing else moves.

**Recommendation: REMOVE.** The invariants belong to the shipped pair; item 4's proposal (a test that loads
`public/preview-sw.js`) is where the correlation and deadline rules can be asserted against code that runs.

---

## 6. `src/process/base64.ts` (27 lines)

**Original purpose.** `encodeBase64` and `decodeBase64`, chunked at 8,192 bytes so `String.fromCharCode(...bytes)` cannot
blow the call stack: base64 for byte payloads crossing a **JSON** syscall wire.

**History.** Introduced in `9e47b24` (2026-11-09, "move the filesystem behind the syscall channel") and orphaned the same
day by `e2c5b78` (2026-11-09 17:01, "frame binary bodies, and only messages that carry one"), which is ADR-0021 landing:
a message carrying a `Uint8Array` is framed behind a 10-byte prefix and the body travels as raw bytes.

**Proof that `frame.ts` fully replaces it.** Not by resemblance - by the removal of the interface it served. `e2c5b78`'s
diff deletes both call sites and the types that made base64 necessary:

- `const payload: string | Uint8Array = dataEncoding === "utf8" ? data : decodeBase64(data)` is **gone**; the handler now
  takes bytes and `dataEncoding: "base64"` is **refused** with a message saying binary arrives as bytes.
- `{ kind: "bytes"; base64: string }` is **gone** from the reply type; a read returns the `Uint8Array` itself.
- `data: encodeBase64(data), dataEncoding: "base64"` is **gone** from the client side.

There is no remaining JSON-bytes path for `frame.ts` to compete with, so the two functions have no caller and no
protocol. Confirming the negative: `base64.js` is imported nowhere in `src/`, `tools/` or `tests/`. The other
`btoa`/`atob` users in the tree each need their own conversion for their own reason and import nothing from here -
`npm/digest.ts` (integrity strings), `shims/crypto.ts`, `shims/socket.ts` (node's `encoding` argument),
`shims/websocket.ts`.

**Is it unfinished capability?** No. It is finished, correct, and surplus.

**Do its tests verify product behaviour?** There are none, which is itself a datapoint: the module has had no test since
its callers left, and nothing noticed.

**One extra reason to remove it.** Its header comment now states something false - "The channel's payloads are JSON (see
`syscall-channel.ts`), so a `Uint8Array` cannot travel as itself." That is exactly what `frame.ts` made untrue, and a
future reader would take it as the current design.

**Consequences of removing it.** None. One file, 27 lines, no importers, no tests.

**Recommendation: REMOVE.** The cheapest and least ambiguous of the seven: no migration, no documentation debt, and a
stale claim removed with it.

---

## 7. `src/harness/index.ts` (35 lines)

**Original purpose.** A convenience barrel re-exporting the harness's modules, so a consumer could import the harness in
one line.

**History.** `603e9c3` (2026-11-03) with the first harness infrastructure; `0279ca5`, `2e655f6`, `335a0a7` followed.
Later modules were added to the harness without being added to the barrel.

**Consumers now.** None. Every real consumer deep-imports (`tools/harness/fixture-executor.ts` imports `runner.js`,
`assertions.js`, `definition.js`, `preview-target.js` individually; the tests import modules directly).

**Is any product capability dependent on it indirectly?** No. And one measurement makes the point better than an
argument: the barrel re-exports **13 of the 17** modules in `src/harness/` and is silent on `preview-target`,
`provenance`, `restriction` and `scripts`. It is a second declaration of the harness API that has already drifted from
the API - which is what an unmaintained barrel does.

**Is it unfinished capability?** No.

**Do its tests verify product behaviour?** There are none.

**Consequences of removing the barrel.** None for the build: `tsconfig.runtime.json` typechecks `src/harness/**` by glob,
no `exports` field points at it, nothing in `docs/` names it as the harness's interface, and no test imports it. One
consequence is worth stating because it is easy to lose: the barrel is *why* the guard has to be transitive - a one-hop
reachability check called `execute.ts` live through this file while nothing used it. Removing the barrel removes that
particular decoy; it does not change the rule.

**Recommendation: REMOVE.** If the project later wants a declared harness surface, that surface should be created with a
consumer in the same change, so a guard can hold it live.

---

## Cross-cutting finding: the third classification has no producer

Stated once here rather than repeated per module, because it is the one thing in this investigation that is not
housekeeping:

> `runner.ts:270-280` classifies a step whose termination is `"restricted"` as `UNSUPPORTED_BY_DESIGN`. Since
> 2026-11-10 the only code that produces that termination is `command.ts`/`execute.ts` (stranded); the CLI's executor
> produces `"ok"` or `"harness-fault"`. A policy refusal therefore reaches a verdict as an ordinary exit code today.

Nothing is scored wrongly *yet*, because no shipped fixture expects that classification (fixture-12 expects `PASS`;
fixtures 15 and 19 have no files). It becomes wrong the moment fixture 15 - "a native addon is refused by design" - is
authored, which the register's freezing work intends. The fix is one mapping in `fixture-executor.ts` from the
Container's existing `"refused"`/`"unsupported"` kinds to a `Restriction` record, and it should land **before** the trio
is deleted so that nothing is lost in between.

---

## Recommendations, in the order they can safely ship

| # | Module | Lines | Verdict | What must happen first |
| --- | --- | --- | --- | --- |
| 6 | `src/process/base64.ts` | 27 | **REMOVE** | nothing |
| 7 | `src/harness/index.ts` | 35 | **REMOVE** | nothing |
| 4 | `src/network/service-worker.ts` | 125 | **REMOVE** | move HEAD/no-body/400 rules onto a test that loads `public/preview-sw.js` |
| 5 | `src/network/sw-bridge.ts` | 196 | **REMOVE** | same test covers correlation and deadline |
| 3 | `src/harness/scripts.ts` | 151 | **REMOVE** | re-assert bin/script resolution against `Container` |
| 2 | `src/harness/command.ts` | 423 | **REMOVE** (migrate one decision) | owner ruling on the pnpm profile; corpus script rule re-expressed against the product parser |
| 1 | `src/harness/execute.ts` | 359 | **MIGRATE then REMOVE** | restrictions produced on the product path; 4 live-subject test files re-pointed at `runDefinition` |

Totals if every recommendation is executed: **1,316 lines of `src/` removed**, 80 tests deleted with their subject
(`harness.command` 45, `harness.scripts` 11, `network.service-worker` 14, `network.sw-bridge` 10), and 31 tests
re-pointed rather than lost (`harness.restriction` 9, `harness.project` 9, `fixtures.run` 4, `harness.fixture-e2e` 9).
Two documented contracts need annotating (`docs/phase-6/pnpm-command-contract.md`, and ADR-0010 amendment 2's three-way
distinction), and one corpus assertion (`fixtures.corpus.test.ts:60-77`) changes mechanism.

**What would "wire" mean, for completeness.** For the SW pair it means abandoning `public/preview-sw.js`; for the harness
trio it means abandoning "the gate runs the product's Container", which is the decision W-26 and ADR-0034 were written to
protect. I recommend against both, and no recommendation here depends on them.

## What this document does not do

No module was deleted, migrated, moved or edited. The guard's declarations in
`tools/checks/stranded-modules.ts` are unchanged and stay in place, one per module with this register row, so the
findings remain visible until a ruling lands. **W-37 stays open.** W-22 is untouched: its benchmarks are still opt-in,
its liveness concern is still unresolved, and the process-liveness assertions were not weakened.
