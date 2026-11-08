# Phase 0 rulings: what needs deciding, by whom, and what each answer changes

**Date:** 2026-11-08
**Status:** Open. Nine questions, each with a recommendation. Nothing here has been implemented.
**Decider:** the project owner / expert. The charter reserves architecture to the human expert, so this page is a
decision request, not a decision record.

Phase 0 of the fix plan says: ratify decisions before building, because three existing decisions conflict with
StackBlitz-style behaviour and everything else sits on top of them. This page is that ratification request. It changes no
code, which is why it is safe to do while the rulings are pending.

## Supersession table

| ADR | Current decision | Proposed outcome | State after this commit |
| --- | --- | --- | --- |
| 0013 | Drain continuations, 1,000 virtual ms budget, interval cap | Superseded by ADR-0018; virtual clock becomes opt-in test mode | Annotated, pending R-3 |
| 0009 | Fixed command language, no shell | Superseded; a real shell is required (Phase 6) | **Not annotated**: byte-pinned by a test, pending R-2 |
| 0012 | ESM transformed to CommonJS | Superseded; native ESM with live bindings and TLA (Phase 5) | Annotated, pending R-4 |
| 0004 D-3 | `process.platform` is `"browser"` | Amended to `"linux"` | Annotated, pending R-5 |
| 0004 D-1 | Hand-written fs/path/buffer instead of unenv/memfs | Kept; `src/shims/presets.ts` wired in or deleted, not left dead | Annotated, pending R-6 |
| 0004 D-5 | A `while (true)` loop cannot be stopped | Resolved for the process lane by ADR-0018 | Annotated |
| 0016 | Volatile offline dependency overlay | Superseded by real installs (Phase 7); corpus stays as the test lane | Annotated, pending R-7 |
| 0017 | Origin-separated previews | Kept and extended to the runtime itself by ADR-0019 | Annotated, pending R-8 |
| 0007 | Fixtures frozen before results exist | Kept; actually freeze them (Phase 10 step 7) | Annotated, pending R-9 |

Two new ADRs are proposed and both need a named decider and a date to become real:

- **ADR-0018** — real processes, real event loop, one Worker per process, synchronous syscall channel.
- **ADR-0019** — the runtime itself moves to a separate origin, with COOP/COEP and a boot handshake.

## Rulings requested

Each entry states the question, the recommendation, and what changes if the recommendation is rejected. A ruling only
needs the number and a word; the reasoning is in the linked ADR.

**R-1. Accept ADR-0018 (process model)?** Recommendation: accept. Without it a dev server cannot stay alive, which
blocks Phases 1, 6, 7 and 9. If rejected, the project stays a script runner and the compatibility target should be
restated honestly.

**R-2. Accept ADR-0009's supersession (real shell)?** Note: ADR-0009 cannot even carry a supersession note until this is
ruled. `tests/unit/harness.refusal-contract.test.ts` asserts the file is byte-identical, because fixture 15's refusal
semantics are pinned to it. The annotation was attempted and the test caught it, which is the guard working. Whoever rules
on R-2 must also update that hash deliberately. Recommendation: accept at Phase 6, not before. If rejected, `&&`,
pipes and `npx`/`pnpm` refusals remain permanent and the parity claim narrows.

**R-3. Accept ADR-0013's supersession (real timers)?** Recommendation: accept, keeping `virtualClock: true` for unit
tests. This one has a fixture consequence: fixture 4's timing assertions must be re-validated under real time. If
rejected, keep the virtual clock and give up on live servers.

**R-4. Accept ADR-0012's supersession (native ESM)?** Recommendation: accept at Phase 5. The acorn transform cannot give
live bindings or top-level await, and ESM-only packages such as `chalk@5` already fail.

**R-5. Amend ADR-0004 D-3 to `process.platform = "linux"`?** Recommendation: yes. Packages branch on `linux` to pick
code paths that are already the ones we implement; `"browser"` sends them down branches nobody here has heard of. Cost is
honesty about what we are not.

**R-6. `src/shims/presets.ts`: wire or delete?** Recommendation: do not delete yet — open PR #6 wires it into the shim
layer. Rule when that PR is resolved: either it lands and the file is live, or it closes and the file and the `unenv`
dependency are removed together. Leaving it dead is the worst of the three.

**R-7. Accept ADR-0016's supersession (real install)?** Recommendation: accept at Phase 7. The corpus stays as the
deterministic lane so CI keeps working without a registry.

**R-8. Accept ADR-0019 (cross-origin runtime)?** Recommendation: accept, and treat it as the gating decision for all
deployment work. It also forces R-10 (persistence placement) earlier than planned.

**R-9. Freeze the 20 fixtures?** Recommendation: yes, but not until they run real packages (Phase 10 step 7). Freezing
the current synthetic set would freeze the wrong target.

**R-10. Where does persistence live once the runtime is cross-origin?** New question raised by ADR-0019, and it changes
Phase 8: OPFS on the runtime origin, or host-origin storage with file traffic over the port. Recommendation: OPFS on the
runtime origin, because it is the only place the filesystem is coherent — and accept that the host editor then talks to it
only through the port.

## What is blocked until these are answered

- **Phase 1** (event loop, process lifecycle) depends on R-1.
- **Phase 2** (isolation) depends on R-8, which the plan itself says to hold.
- **Phase 3 step 2** (missing parents throw ENOENT) can proceed, but the fix list assumes the caller changes are acceptable.
- **Any deployment** depends on R-8 plus a domain decision: the runtime needs `runtime.<domain>` and previews need
  `*.<previewBase>`, and the audited Vercel account currently has no custom domain and a hobby plan.

## What is not blocked

Phase 10 steps 1–3 and 5 need no architectural ruling and are implemented alongside this page: true test counts, split
TypeScript lanes, and CI guards.
