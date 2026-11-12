# Remaining work: the register

**Opened:** 2026-11-12. **Source:** the November audit (`@Michael`, "Standalone WebContainer: Full Scan, Errors and Gaps"), checked
against this tree rather than copied from it. **This file is the list.** An item leaves it only when a commit closes it, and the row
then says which commit and which evidence, so the register stays a record of what was true rather than a wish list.

**Snapshot caveat.** The audit reviewed `0a97bf7d-standalone-webcontainer-main1.zip`, a snapshot with no `.git`, pinned at 1,263
unit tests and TS 5.9.3. Main today is **1,345 tests across 98 files** (see the badge in `README.md`). Four things it lists as open
are already closed since that snapshot, and are recorded here so nobody reopens them:

| Already closed | Where |
| --- | --- |
| The API-surface measurement lane (`npm run diff:api`) and its P0/P1 members: `fs.rmSync`, `appendFileSync`, `copyFileSync`, `accessSync`, `mkdtempSync`, `truncateSync`, `lstatSync`, `Stats`, `fs.constants`, `timers`/`timers/promises`, `process.exitCode`, `events.once`, `assert.rejects`, `util.parseArgs`, `crypto.randomInt`, `process.hrtime/memoryUsage/uptime` | `docs/audit/api-surface-p0.md`, 30/30 cases |
| Outbound HTTP decided and refused by name | ADR-0025 |
| The link model decided: tree, no link layer, refused by name | ADR-0026 |
| `utimesSync`/`utimes`/`lutimes`/`promises.utimes` made real (seconds → milliseconds in one place) | ADR-0026 |

Two of the audit's own claims are worth restating because I checked them: `src/process/*` really has **zero** importers outside tests
and benchmarks, and the two ADR-0017 files really do both exist. Its "live registry lane exists" row needs one qualifier the audit
could not know without the product path: the **page** still installs from the committed `@corpus/*` only (`src/browser/main.ts:19`
loads `loadOfflineRegistry`), and the network/snapshot lanes belong to the fixture runner.

---

## 1. Product connection (the audit's first priority, and it is right)

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-1 | Connect the process model to the product | **Done, 2026-11-12 (ADR-0029).** `src/browser/runtime.worker.ts` holds a `ProcessKernel`: `src/process/*` is imported by the product, `RuntimeSupervisor` and its `#runQueue` are deleted, and every command runs in its own Worker. The seam that made this impossible came first (ADR-0028): a preview request now reaches a server inside a process Worker, so a `listen(3200)` can actually be previewed. A command's outcome means **settled**, not exited: a process still owning a port is held open (Node's rule for a ref'd handle), which is what lets a dev server idle while the terminal runs something else. Two defects fell out and are pinned by `tests/browser/p1b.spec.ts` (start a server, stop it, run the starter: its output must appear): the terminal's dimensions were not forwarded across the Worker boundary, and output was routed by PROCESS id while the page addresses runs, so a second run's stdout was posted with an id the client had no pending entry for and silently dropped. | **Next: nothing here.** Output a held-open program writes after it settles is no longer displayed (the command boundary has reported); streaming a live server's logs belongs with HMR/streaming (W-3). |
| W-2 | Run the real page under `crossOriginIsolated`, end to end, including the preview shell | The headers ship (`vite.config.ts`, `vercel.json`, kept in sync by `tests/unit/isolation.headers.test.ts`) and `tests/browser/kernel-fs.spec.ts` proves the syscall channel **inside a test harness**. No test proves the product page boots isolated. | One browser test that loads the app, runs a program with a real fs syscall, and asserts `crossOriginIsolated === true` plus a served preview. |
| W-6 | The runtime origin (ADR-0019) | ADR-0019 is accepted, and there is no `boot.html` and no runtime iframe: user code runs in a Worker on the host origin. Needs a registrable domain the project does not own yet. | Blocked on the domain decision, not on code. Do the Worker hardening (W-19) first, because that part needs no domain. |
| W-3 | Decide COEP `credentialless` against a real framework app | Open question 1 of ADR-0019. `public/preview-sw.js` sends `COEP: require-corp` + `COOP: same-origin` on every HTML document it serves, so a previewed app that loads a CDN font, an analytics script or an embed without CORP/CORS fails. | Test one real framework app (Vite + a CDN asset) under both modes in Chromium before settling it. |

## 2. Isolation and hosting

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-19 | Process-Worker hardening is specified and unimplemented | ADR-0019 lists it (capture closures, virtual fetch, delete XHR/WebSocket/indexedDB) and calls the design "defence in depth, NOT a sandbox". Today a program has the page origin's `fetch` and `XMLHttpRequest`. | Implement inside the process worker, with a test that a program cannot reach `fetch` or `XMLHttpRequest`. |
| W-20 | Same-site is not same-origin | The plan puts editor, runtime and previews in one zone; a domain-wide cookie on the host would reach preview code. StackBlitz uses a separate registrable domain. | Part of the domain decision behind W-6. Record the choice in ADR-0019 rather than in a chat. |
| W-15 | Preview nonce travels in the URL query (`__preview_nonce`) | Low confidence, and worth confirming: a frame's own code can read its URL, so the worker must accept the nonce ONLY for the shell it was minted for. | Read `public/preview-sw.js` against `preview-handshake.ts` and pin the rule with a test. |

## 3. Node compatibility

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-17 | `process.platform` is still `"browser"` | `src/shims/process.ts:209`. P0-5 accepted `"linux"`. | Change it, then run the full suite: it is one string but many fixtures and shims branch on it. |
| W-4 | Streaming (done) and WebSocket (open) | **Streaming done, 2026-11-12 (ADR-0030).** A response sends its headers on the first byte and each `write()` leaves as its own chunk, through five hops that each carry the request id; a buffered caller is untouched and a late chunk is dropped rather than landing in the next response. `tests/browser/streaming.spec.ts` proves it end to end in a real `fetch`, with the first chunk required before a second request releases the rest, so a buffered implementation deadlocks instead of passing slowly (removing the sink fails both tests). **Still open:** no `ws` shim, so Vite's HMR cannot work: a dev server can be previewed but not a live one. Also not claimed: no backpressure (chunks queue), no keep-alive. | WebSocket next: a `fetch`-based shim cannot do it, so it needs its own transport events and a browser-side client, plus the preview SW upgrade path. |
| W-18 | ESM is an acorn→CommonJS transform with no live bindings | Documented at `src/loader/commonjs.ts`. Top-level await is detected and a synchronous `require` of such a module refuses with `ERR_REQUIRE_ASYNC_MODULE`. | Boundary to document, not close. Say so where a user meets it. |
| W-13 | Peer dependencies are not installed, and lifecycle scripts have no policy | `docs/audit/live-registry-measurement.md`; the installer records neither. | Peer deps first (a real `express` install already succeeds without them, so measure what breaks). Lifecycle scripts need a policy decision: which ones, and in what sandbox. |
| W-14 | Native addons are out of reach by design | Fixture 15's expected verdict is `UNSUPPORTED_BY_DESIGN`, and ADR-0009/0014 define refusal semantics. | Nothing to build. Keep the refusal legible. |
| W-12 | `randomFillSync` over a SharedArrayBuffer-backed view | **Closed in this commit.** Node fills a shared view; browsers refuse one, and the shim calls the browser's `getRandomValues`. Fixed by filling a plain buffer and copying in, in one `fill()` shared by `randomFillSync` and `getRandomValues`. `tests/unit/shims.crypto-sab.test.ts` (9 tests) proves it by installing a spec-compliant `getRandomValues` and importing the shim fresh; the three browser-rule tests fail without the fix. | Done. |

## 4. Packaging

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-16 | Hoisting is shallow, and duplicate bytes are accepted | ADR-0006 D-15. Nested conflicts are handled; identical packages at different depths are stored twice. | Decision, not a bug: measure the cost on a real 68-package tree before changing the layout. |
| W-11 | `src/shims/presets.ts` is dead | Imported only by `tests/unit/presets.test.ts`, and `unenv` stays in `dependencies`. P0-6 says wire it in or delete it, and calls leaving it dead the worst of the three. | Delete both, or wire the timers preset to the runtime scheduler. The scheduler is now the right clock, so **deleting is the recommendation** and the ADR should say why. |
| W-22 | The payload benchmark is quarantined from the gate | `tests/browser/bench-scaling.spec.ts` is a measurement: both specs print a table and assert nothing about speed. In a full single-worker lane one process waited **60 s** for a syscall its own kernel never answered, while the same spec passes alone; `main` fails it the same way in a full lane, so the flake predates the streaming work (measured both ways before quarantining). It now skips unless `SWC_BENCH=1`. | Find the starvation: a synchronous `Atomics.wait` caller plus a kernel serve loop that has other work is the shape to examine, and `parking versus spinning` is the spec that already measures the wake-up. Until then the numbers are read on demand. |
| W-21 | `package.json` is `"version": "0.0.0"`, `"private": true` | Line 3-4. | Fine until a release. Fix at the first tag. |

## 5. Fixtures and the gate

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-8 | 12 definitions contain no program, and **none** is frozen | Measured in this commit: 8 definitions have `files` (01, 04, 07, 08, 11, 13, 17, 18), 12 do not (02, 03, 05, 06, 09, 10, 12, 14, 15, 16, 19, 20), `status: "proposed"` for all 20. ADR-0007 says to freeze before results exist; results now exist. | Write the 12, then freeze before the next gate reading (P0-9). |
| W-22 | The gate percentage is a hand calculation | The audit's ~47% (7 of 15 front-end) is illustrative. Nothing in the repo computes a live gate reading over frozen fixtures. | `npm run fixtures:score` printing the gate reading from evidence, so the number cannot drift from the evidence directory. |

## 6. Documentation and CI

| # | Item | State and evidence | Next action |
| --- | --- | --- | --- |
| W-9 | Docs that disagree with the code | **Closed in this commit** for the documentary half: README's three errors, the two stale "3 of 7" audit docs, the duplicate ADR-0017 (the persistence one is now ADR-0027), and `front-end-boundary-esbuild.md` marked superseded. **Still open:** `process.platform` is documented as `"linux"` in P0-5 while the code says `"browser"` (that is W-17, a code change). | W-17. |
| W-10 | Three `verify` steps never run in CI | `npm run verify` chains `fixtures:check`, `corpus:check` and `diff:modules:strict`; `.github/workflows/ci.yml` runs `typecheck`, the two guards, `test:report`, `tests:count:check`, the browser build and Playwright. Also: the workflow triggers on `main`, `integration/**`, `docs/**` and `feat/**`, so other branches are untested until a PR, which is how a broken branch reaches review. | Add the three steps to CI. Widen the trigger, or accept the PR-time check explicitly in the workflow comment. |
| W-23 | The Windows Playwright hang was never resolved | Recorded in the P1e deployment doc: Playwright stays alive after reporting success on Windows. | Not reproducible here (Linux only). Keep it visible; do not claim it is fixed. |

---

## How this list is maintained

- A row is added when a measurement or an audit produces one, with the evidence path and line where it was seen.
- A row moves to "Already closed" (with the commit) rather than being deleted, because the value of the register is that a later
  reader can tell a closed item from an unexamined one.
- Items needing an owner decision are marked as such and are **not** silently implemented. Those are W-3 (COEP mode), W-16
  (hoisting), W-13's lifecycle-script policy, W-6/W-20 (the domain), and W-8 (freezing).
