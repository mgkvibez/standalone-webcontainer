# P0-6 inventory: the orphaned shim layer

**Date:** 2026-11-13. **Status:** inventory and recommendation only. **Nothing has been deleted or migrated.**
**Baseline:** `main` @ `ca26cc0`, clean tree. **Owner's question (P0-6):** "`src/shims/presets.ts`: wire or delete?"

The ruling has been open since 2026-11-08 because it was waiting on PR #6 (which landed) and then on PR #7 (closed as
superseded, 2026-11-13). It is now answerable, so this file inventories the three orphaned artefacts one by one: what each is,
who reaches it, what it costs to keep, and what breaks if it goes.

**Summary:** `src/shims/presets.ts`, `src/runtime/envelope.ts` and the `unenv` dependency are reachable from tests only. None
of the three is in the production bundle. The recommendation is **removal of all three in a single change**, with the
alternative (retain `envelope.ts` alone, documented as unused) stated in §5 for the owner to prefer if the option has value.

---

## 1. What P0-6 actually asked

From `docs/decisions/P0-rulings.md`:

> **P0-6. `src/shims/presets.ts`: wire or delete?** Recommendation: do not delete yet, open PR #6 wires it into the shim layer.
> Rule when that PR is resolved: either it lands and the file is live, or it closes and the file and the `unenv` dependency are
> removed together. **Leaving it dead is the worst of the three.**

PR #6 landed (the file is on `main`), but nothing was wired to it: it is present and still dead. The register records the same
thing as W-11, with the same recommendation ("deleting is the recommendation").

---

## 2. `src/shims/presets.ts` (84 lines)

**What it exports:** `initializeShims(syscall)`, `ShimContext`, `ShimModules`. It imports four `unenv` preset modules (path,
process, buffer, events), materialises a fifth (timers) from `globalThis`, and returns `{ syscall, modules }`.

**Who reaches it.** One importer in the whole tree:

| Reachable from | Count |
| --- | --- |
| `src/` (production): callers of `initializeShims` | **0** (the only match in `src/` is the definition) |
| `tests/`: `tests/unit/presets.test.ts` | 1 file, **7 tests** |
| Browser bundle: files in `dist/browser/assets/*.js` containing `initializeShims` | **0 of 9** |
| Other source comments that name it | 1: `src/shims/timers.ts:5`, which explains why the timers shim was written here instead of there |

**Its own docstring already describes a superseded architecture.** It says the context "carries the typed envelope client;
every fs-adjacent syscall routes through it (envelope.ts) to the VFS in the owning worker. The fs shim itself is deliberately
NOT here, it lands next phase". The fs shim landed, and it does **not** route through the envelope: it has a direct synchronous
seam over `src/vfs/port.ts` (`src/shims/fs.ts`), which is the architecture ADR-0001's closure and ADR-0018's scope ruling now
record. So the file does not merely sit unused, it argues for a design the product rejected.

**What it costs while it stays:**

1. Five packages plus a duplicate `pathe` in the lockfile (see §4), installed on every `npm ci`.
2. An `unenv` entry in `"dependencies"` (not devDependencies), which reads to any auditor as a load-bearing runtime dependency.
3. Seven tests that pin a context nothing constructs. They pass, and they prove the presets work, which is not a claim about
   this product.
4. A reader who finds it will conclude the boundary protocol is the envelope. That is the expensive cost, and it is exactly
   what this inventory exists to remove.

**The three options, and what each really requires:**

- **Wire it in.** Only one of the five presets is even arguable, and it must not be wired: the runtime's timers are built from
  the scheduler (`createTimersShim(scheduler)` in `src/runtime/in-process.ts`), so `require("timers")` and a bare `setTimeout`
  are the same clock, with ref/unref and the callback budget applying to both. `unenv`'s timers preset delegates to
  `globalThis.setTimeout`, which is the platform clock. Wiring it would put **two clocks** in one process and break the rule
  ADR-0018 depends on. The code already says so, in `src/shims/timers.ts`: *"WHY THE SCHEDULER AND NOT THE PRESET: the preset in
  presets.ts delegates to the platform's `globalThis.setTimeout`. That is the wrong clock."* The other four presets would replace hand-written shims that carry differential evidence
  (`npm run diff:api`, 30/30 cases) and would reverse ADR-0004 D-1, whose whole argument was keeping the audited dependency
  surface at four packages instead of twenty-plus.
- **Retain as is.** This is the option P0-6 already calls the worst of the three, and it is now the only thing keeping
  `envelope.ts` alive.
- **Remove.** Recommended: §5.

---

## 3. `src/runtime/envelope.ts` (227 lines)

**What it exports:** `SyscallClient`, `SyscallKernel`, `SyscallRequest`/`SyscallResponse`/`SyscallErrorRecord`,
`OutstandingCallsMap`, `SyscallError`, `rehydrateError`, `serializeError`, `UNKNOWN_ERROR_CODE`, `UNIMPLEMENTED_ERROR_CODE`.

**What it is:** a `postMessage`-based request/reply protocol. Monotonic `msgId`s, an outstanding-calls map, errors crossing as
structured-cloneable `{code, message}` records rehydrated caller-side. Well built, and it is what PR #7's fs shim spoke.

**Its header makes a claim that is no longer true.** It says it is "the single request/reply channel crossing the Runtime <->
Worker boundary (ADR-0003, Decision 2)". The boundary today is `src/process/syscall-channel.ts` (shared memory, header state,
`Atomics.wait`) plus `src/process/frame.ts` (the wire codec), and `envelope.ts` is not part of it.

**Who reaches it.**

| Reachable from | Count |
| --- | --- |
| `src/`: `src/shims/presets.ts` | 1 importer, and that importer is itself dead (§2) |
| `tests/`: `tests/unit/envelope.test.ts`, `tests/unit/presets.test.ts` | 2 files, **18 tests** between them |
| `dist/browser/assets/*.js` | **0 of 9** |

**What is genuinely unique about it, stated fairly.** It needs no `SharedArrayBuffer`, so it works in a document that is not
cross-origin isolated. That is a real capability the shipped channel does not have. It is also not needed by any lane that
exists: the process lane is the isolated one by design, and the in-process lane crosses no boundary at all. So the capability
is potential, not current.

**The risk while it stays.** Two protocols for one boundary is the failure mode ADR-0018's own implementation note records in
writing: *"Duplicated concurrency logic rots asymmetrically. If two paths differ only in how they wait, share everything
else."* A maintainer who finds `envelope.ts` after finding `syscall-channel.ts` has to work out which one is live, and nothing
in `envelope.ts` says it is not.

**Options:**

- **Remove with `presets.ts`** (recommended): one protocol, one story.
- **Retain, documented as unused.** Acceptable if the owner wants the non-isolated option kept available. Cheaper change, and it
  should then carry a header paragraph naming `src/process/syscall-channel.ts` as the live boundary and stating that this module
  has no production consumer. That keeps the option and removes the ambiguity, at the cost of 227 lines and 11 tests that pin a
  protocol nothing uses.
- **Migrate:** there is nothing to migrate. No caller wants it, and the lane that would use it does not exist.

---

## 4. `unenv` (1.10.0, MIT)

| Fact | Value |
| --- | --- |
| Declared | `"dependencies": { "unenv": "^1.10.0" }` in `package.json:64` |
| Resolved | `unenv` 1.10.0, MIT |
| Brings | `consola` 3.4.2, `defu` 6.1.7, `mime` 3.0.0, `node-fetch-native` 1.6.7, and a nested `pathe` 1.1.2 |
| Duplicate | the repo already depends on `pathe` 2.0.3, so the tree carries **two** copies of one path library |
| Licences | all MIT; `npm run guard:licences` passes today, so this is not a licence problem |
| Reachability | only through `src/shims/presets.ts` |
| Presence in the production bundle | **none**: 0 of 9 `dist/browser/assets/*.js` files contain `unenv`, `consola`, `defu`, `node-fetch-native` or `initializeShims` |

**So the cost is not bundle weight.** It is lockfile surface, install time, an audit question ("why is this a production
dependency?"), and the duplicate `pathe`. If the presets were ever wired, the presets and their five transitive packages would
enter the browser bundle, which is precisely the cost ADR-0004 D-1 declined to pay once already.

---

## 5. Recommendation

**Remove all three in one change, after the owner's ruling.** The evidence, in one place:

| Reason | Measurement |
| --- | --- |
| No production consumer | `initializeShims`: 0 callers in `src/`. `envelope.ts`: 1 importer, and it is the dead file |
| No bundle presence | 0 of 9 files in `dist/browser/assets/` reference `unenv` or either module |
| Tests that assert nothing about the product | 18 (7 presets + 11 envelope) |
| Installed surface | 5 packages plus a duplicate `pathe` 1.1.2 |
| A docstring that contradicts the shipped architecture | `presets.ts` describes fs routing through `envelope.ts`; fs routes through `src/vfs/port.ts` |
| A duplicate boundary protocol | `envelope.ts` calls itself the boundary; the boundary is `src/process/syscall-channel.ts` |

**Blast radius, exhaustively** (measured by grep, not estimated):

1. Delete `src/shims/presets.ts`, `src/runtime/envelope.ts`, `tests/unit/presets.test.ts`, `tests/unit/envelope.test.ts`.
2. `package.json`: remove `unenv` from `dependencies`; regenerate `package-lock.json` with `npm install`.
3. `src/shims/timers.ts:5`: one comment references `presets.ts` ("it would serve already existed in the tree") and needs the
   same edit. Comment only, no behaviour.
4. README's test count, which is generated: `npm run test:report && npm run tests:count -- --write`.
5. Three record updates: this ruling's row in `P0-rulings.md`, W-11 in `docs/audit/remaining-work.md`, and a supersession note on
   ADR-0003 Decision 1 (annotate, never rewrite: the reason `unenv` was chosen is still history worth keeping).

Nothing else. No other file in `src/`, `tests/`, `tools/`, `fixtures/` or `public/` mentions either module.

**If the owner prefers to keep the option open**, the cheaper half is worth distinguishing: the *cost* lives in `presets.ts` plus
`unenv` (§4), and the *option* lives in `envelope.ts`. Keeping the option and dropping the cost means: delete `presets.ts`,
`presets.test.ts` and the `unenv` dependency; retain `envelope.ts` and its 11 tests with a header that says it has no production
consumer. That is a defensible answer, and it is the one to pick if a non-isolated lane is plausible within the year.

**What should not happen** is a fourth state where the three are left as they are. That state is what makes the next reader
believe the envelope is the boundary, and it is the state the register has already called the worst of the three.

---

## Appendix: the commands behind every number above

```bash
grep -rn "initializeShims" src/ tests/                     # 1 hit in src (the definition), 1 test file
grep -rn "runtime/envelope" src/ tests/ tools/             # 1 importer in src (presets.ts), 2 test files
grep -rn "shims/presets" src/ tests/ tools/                # 1 comment (timers.ts:5), 1 test file
npm run build:browser && for p in initializeShims unenv consola defu node-fetch-native; do
  echo "$p: $(grep -rl "$p" dist/browser/assets/*.js | wc -l) files"; done   # all 0
node -e "const l=require('./package-lock.json'); for (const k of Object.keys(l.packages)) if (/unenv|consola|defu|node-fetch-native|mime|pathe/.test(k)) console.log(k, l.packages[k].version, l.packages[k].license)"
grep -cE "^\s+it\(" tests/unit/envelope.test.ts tests/unit/presets.test.ts  # 11, 7
```
