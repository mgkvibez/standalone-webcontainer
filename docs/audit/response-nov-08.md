# Response to the second audit: what is accepted, what is corrected, what changed since

**Date:** 2026-11-08
**Base:** `docs/p0-ratification` (Phase 0 ADRs + Phase 10 tooling already committed)
**Tone of this page:** each audit point gets evidence or a correction, not agreement. Where the audit is right, it is
recorded as right. Where the snapshot it read is older than the tree, the difference is stated with file and line.

## Test numbers

The audit cites 690 unit tests and 19 of 19 browser tests. That matches the tree after PR #6 was merged into `main`
(`e65e087`). This branch is ahead of it: **719 unit tests in 51 files and 20 browser tests**, and the README number is now
generated from vitest's own JSON report with `verify` failing on drift, so it cannot be hand-typed wrong again. CI runs
`42445083971` (success) and `42418119039` (success) are the evidence.

## The three corrections

**1. Persistence is `localStorage`, not IndexedDB. ACCEPTED, and the README is now fixed.**
`src/browser/main.ts:16` (`ProjectStore.load(window.localStorage)`) and `src/browser/projects.ts:8` (storage is
`localStorage`, one versioned key) are unambiguous. `README.md` line 87 claimed IndexedDB while line 12 said
`localStorage`; line 87 now says `localStorage` with the file reference and marks IndexedDB/OPFS as Phase 8 work.

**2. "No service worker is registered anywhere." OUTDATED for the code, CORRECT for the outcome.**
Registration now exists: `src/browser/preview-shell.ts:35` calls `navigator.serviceWorker.register("/preview-sw.js", { scope: "/" })` and
then waits for `ready` and for `controllerchange` before loading the preview iframe, so the navigation never reaches the
network cold. That landed with P1e (`d9bafc0`), after the audited snapshot.
The audit's substantive point still stands and is not softened here: a preview deployment only exists when
`VITE_PREVIEW_BASE_DOMAIN` is set, that build is the only one that enables previews, and **no production preview has ever
been served** because the account has no custom domain and the wildcard this needs does not exist. `preview-gateway.ts` and
`service-worker.ts` remain routing logic that tests call directly; browser tests passing says nothing about a deployed
service-worker preview. Risk P0-1 (previews on the host origin) is exactly what ADR-0019 now covers, pending a ruling.

**3. "The event-loop output is not proof of a real loop." ACCEPTED, and now measured.**
`src/runtime/scheduler.ts` is a virtual-clock scheduler with an explicit `budgetMs` and a `budget-exhausted` stop reason.
The audit asked for differential tests against real Node, so `tools/differential/event-loop.ts` runs seven ordering cases
in both and compares verbatim. Result: **3 of 7 match**. The four deviations reduce to two defects:

- `process.nextTick` is `queueMicrotask`, so it interleaves with promises instead of draining first (three cases).
- A promise chain does not settle before a 0 ms timer: the second `.then` runs *after* the timer (`microtask-starvation`).

Full table and consequences in [event-loop-differential.md](event-loop-differential.md).

## The architecture disagreement

The audit rejects the claim that parity needs a WASI kernel or an emulated machine, and argues the gaps are the process
model: a process table that is bookkeeping only, no real `child_process`, no shell. Nothing in the P0 plan disagrees with
that, and the two ADRs are the same design in document form: a kernel Worker owning the VFS with one Worker per process
(ADR-0018) and a separate runtime origin with a MessagePort transport (ADR-0019).

One correction to the ordering the fix list implies: **isolation cannot follow the kernel, it has to precede it.**
`Atomics.wait` needs `SharedArrayBuffer`, which needs `crossOriginIsolated`, which needs COOP/COEP on the host page and a
separate runtime origin. Building the kernel first and moving origins afterwards would rewrite every syscall channel. That
is why Phase 2 is held behind ADR-0019 rather than sequenced later.

## Gaps the audit lists that were already recorded

| Audit gap | Where it is already recorded | State |
| --- | --- | --- |
| ESM via acorn→CJS, no live bindings, no TLA, no destructured exports | ADR-0012, `P0-rulings.md` P0-4 | supersession proposed, ruling pending |
| User code runs with `new Function` on the host origin | ADR-0019, risk P0-1 | ADR proposed, ruling pending |
| VFS: implicit parents, no symlinks, no watch | Phase 3 steps 1–3, 6 | not started |
| `npx`, `pnpm`, `yarn`, `sh`, `bash`, `zsh` refused | ADR-0009, `P0-rulings.md` P0-2 | real shell required, Phase 6 |

## Fix order, as executed against this tree

1. **Phase 0 ADRs — done** (`63c3607`). ADR-0018, ADR-0019, and ten numbered rulings (`P0-1` to `P0-10`) in `P0-rulings.md`. Nothing in
   Phases 1–9 can be honestly started until those are answered.
2. **Live-registry and CORS spike — partly measured today.** From this environment: `registry.npmjs.org` returns
   `access-control-allow-origin: *` for both the packument (`application/json`, `max-age=300`) and the tarball
   (`application/octet-stream`, 2,774 bytes). So the browser can fetch both directly, which means a real install is a
   resolver problem, not a CORS problem. What is not measured: rate limits, redirects, and behaviour behind a service
   worker on a cross-origin page. Those need a browser lane, and the four fixes above come first.
3. **Real preview** (cross-origin frame, SW preview on its own origin, MessagePort) — blocked on ADR-0019 plus a domain.
4. **Kernel Worker + per-process Workers** — blocked on ADR-0018 (P0-1).
5. **Shell and PTY with xterm.js** — follows 3 and 4. The PTY core and its wire to the page are done (ADR-0023 and its
   amendment): sizes, `isTTY`, `require("tty")`, stdin delivery and resize all cross page → Worker → runtime. The xterm.js pane
   and raw keystroke input remain.
6. **Persistence on OPFS/IndexedDB with Web Locks** — blocked on ADR-0019's open question about *where* persistence lives.
7. **Node-semantics differential tests** — the event loop was first (`docs/audit/event-loop-differential.md`), and module
   resolution plus error shapes now follow (`docs/audit/module-differential.md`: 14 of 14 cases match Node, after two defects it
   found, and the comparison is part of `npm run verify`).
8. **ESM** — blocked on P0-4.
9. **Freeze the 20 fixtures and fix the README** — README corrections landed today; freezing waits for real packages.
10. **Benchmark against StackBlitz** — correctly last.

## Unverified, stated as unverified

The audit could not run the suites; the numbers here are ours, backed by CI run ids. Claims about StackBlitz internals in
ADR-0018/0019 are marked in those ADRs as coming from public descriptions and needing a check against current docs before
any decision depends on them.
