# Phase 0 rulings: what needs deciding, by whom, and what each answer changes

**Date:** 2026-11-08
**Status:** **ACCEPTED 2026-11-09.** All ten rulings answered by the owner; see the acceptance record below. Acceptance is a decision, not an implementation: the code changes land in later phases, in the order the plan gives.
**Decider:** the project owner / expert. The charter reserves architecture to the human expert, so this page is a
decision request, not a decision record.

Phase 0 of the fix plan says: ratify decisions before building, because three existing decisions conflict with
StackBlitz-style behaviour and everything else sits on top of them. This page is that ratification request. It changes no
code, which is why it is safe to do while the rulings are pending.

## Acceptance record, 2026-11-09

Owner accepted every recommendation in this register on 2026-11-09 ("Accept all recommendations"). Nothing is
re-litigated below; this table exists so that no later reader mistakes it for still-open.

| Ruling | Question | Answer | Effective |
| --- | --- | --- | --- |
| P0-1 | Accept ADR-0018 (process model)? | **Accepted** | Phase 1 onward, incrementally |
| P0-2 | Accept ADR-0009's supersession (real shell)? | **Accepted** | Phase 6, not before |
| P0-3 | Accept ADR-0013's supersession (real timers)? | **Accepted** | Phase 1, with the event loop |
| P0-4 | Accept ADR-0012's supersession (native ESM)? | **Accepted** | Phase 5 |
| P0-5 | Amend ADR-0004 D-3 to `process.platform = "linux"`? | **Accepted** | With the process lane |
| P0-6 | `src/shims/presets.ts`: wire or delete? | **Accepted** | Decided when PR #6 lands |
| P0-7 | Accept ADR-0016's supersession (real install)? | **Accepted** | Phase 7 |
| P0-8 | Accept ADR-0019 (cross-origin runtime)? | **Accepted** | When the runtime origin exists |
| P0-9 | Freeze the 20 fixtures? | **Accepted** | Before the next gate reading |
| P0-10 | Where does persistence live once cross-origin? | **Accepted: OPFS on the runtime origin** | Phase 8 |

Two consequences that are easy to get wrong later:

1. **P0-2 is accepted but sequenced.** ADR-0009 is byte-pinned by `tests/unit/harness.refusal-contract.test.ts`, and it
   stays byte-identical until the shell work begins in Phase 6. Acceptance means "this will be superseded", not "the pin
   may be edited".
2. **P0-9 precedes any new gate number.** The gate denominator is 15 front-end-only slots and currently two are staged,
   so the score is 2/15 = 13.3%. Freezing is what lets the gate count; it does not raise the score by itself.

Accepted rulings do not authorise skipping the charter's other gates: one change at a time, isolated commit verification,
full suite after every milestone, and no redefining the gate after seeing results.

## Supersession table

| ADR | Current decision | Accepted outcome | State |
| --- | --- | --- | --- |
| 0013 | Drain continuations, 1,000 virtual ms budget, interval cap | Superseded by ADR-0018; virtual clock becomes opt-in test mode | Annotated; accepted, effective Phase 1 |
| 0009 | Fixed command language, no shell | Superseded; a real shell is required (Phase 6) | Not annotated: byte-pinned by a test; accepted, effective Phase 6 |
| 0012 | ESM transformed to CommonJS | Superseded; native ESM with live bindings and TLA (Phase 5) | Annotated; accepted, effective Phase 5 |
| 0004 D-3 | `process.platform` is `"browser"` | Amended to `"linux"` | Annotated; accepted, effective with the process lane |
| 0004 D-1 | Hand-written fs/path/buffer instead of unenv/memfs | Kept; `src/shims/presets.ts` wired in or deleted, not left dead | Annotated; accepted: decide when PR #6 lands |
| 0004 D-5 | A `while (true)` loop cannot be stopped | Resolved for the process lane by ADR-0018 | Annotated |
| 0016 | Volatile offline dependency overlay | Superseded by real installs (Phase 7); corpus stays as the test lane | Annotated; accepted, effective Phase 7 |
| 0017 | Origin-separated previews | Kept and extended to the runtime itself by ADR-0019 | Annotated; accepted, effective when the origin exists |
| 0007 | Fixtures frozen before results exist | Kept; actually freeze them (Phase 10 step 7) | Annotated; accepted: freeze before the next gate reading |

Two new ADRs are proposed and both need a named decider and a date to become real:

- **ADR-0018** — real processes, real event loop, one Worker per process, synchronous syscall channel.
- **ADR-0019** — the runtime itself moves to a separate origin, with COOP/COEP and a boot handshake.

## Rulings requested

Each entry states the question, the recommendation, and what changes if the recommendation is rejected. A ruling only
needs the number and a word; the reasoning is in the linked ADR.

**P0-1. Accept ADR-0018 (process model)?** Recommendation: accept. Without it a dev server cannot stay alive, which
blocks Phases 1, 6, 7 and 9. If rejected, the project stays a script runner and the compatibility target should be
restated honestly.

**P0-2. Accept ADR-0009's supersession (real shell)?** Note: ADR-0009 cannot even carry a supersession note until this is
ruled. `tests/unit/harness.refusal-contract.test.ts` asserts the file is byte-identical, because fixture 15's refusal
semantics are pinned to it. The annotation was attempted and the test caught it, which is the guard working. Whoever rules
on P0-2 must also update that hash deliberately. Recommendation: accept at Phase 6, not before. If rejected, `&&`,
pipes and `npx`/`pnpm` refusals remain permanent and the parity claim narrows.

**P0-3. Accept ADR-0013's supersession (real timers)?** Recommendation: accept, keeping `virtualClock: true` for unit
tests. This one has a fixture consequence: fixture 4's timing assertions must be re-validated under real time. If
rejected, keep the virtual clock and give up on live servers.

**P0-4. Accept ADR-0012's supersession (native ESM)?** Recommendation: accept at Phase 5. The acorn transform cannot give
live bindings, and ESM-only packages such as `chalk@5` already fail. (Updated 2026-11-10: top-level await is no longer part of this
argument. It is supported in the entry module and refused elsewhere as `TLA_IN_NON_ENTRY`; see ADR-0012's amendment, which measured the
incidence first.)

**P0-5. Amend ADR-0004 D-3 to `process.platform = "linux"`?** Recommendation: yes. Packages branch on `linux` to pick
code paths that are already the ones we implement; `"browser"` sends them down branches nobody here has heard of. Cost is
honesty about what we are not.

**P0-6. `src/shims/presets.ts`: wire or delete?** Recommendation: do not delete yet — open PR #6 wires it into the shim
layer. Rule when that PR is resolved: either it lands and the file is live, or it closes and the file and the `unenv`
dependency are removed together. Leaving it dead is the worst of the three.

> **Provenance note (2026-11-08).** `src/shims/presets.ts` does **not** exist on this branch's engine base
> (`feat/p1d-worker-supervisor` at `5c15fe2`) or on `docs/audit-response-2` (`af8bf97`); `src/shims/` there holds
> only `fs`, `path`, `process`, `events`, `http`, `stream` and `.gitkeep`. The file arrives with PR #6 (`7205395`)
> and is present on `main` after the merge `e65e087`. Read this ruling against a branch without the file and it
> looks already settled; it is not. The question is what to do *when PR #6 lands*.

**P0-7. Accept ADR-0016's supersession (real install)?** Recommendation: accept at Phase 7. The corpus stays as the
deterministic lane so CI keeps working without a registry.

**P0-8. Accept ADR-0019 (cross-origin runtime)?** Recommendation: accept, and treat it as the gating decision for all
deployment work. It also forces P0-10 (persistence placement) earlier than planned.

**P0-9. Freeze the 20 fixtures?** Recommendation: yes, but not until they run real packages (Phase 10 step 7). Freezing
the current synthetic set would freeze the wrong target.

**P0-10. Where does persistence live once the runtime is cross-origin?** New question raised by ADR-0019, and it changes
Phase 8: OPFS on the runtime origin, or host-origin storage with file traffic over the port. Recommendation: OPFS on the
runtime origin, because it is the only place the filesystem is coherent — and accept that the host editor then talks to it
only through the port.

## What is blocked until these are answered

- **Phase 1** (event loop, process lifecycle) depends on P0-1.
- **Phase 2** (isolation) depends on P0-8, which the plan itself says to hold.
- **Phase 3 step 2** (missing parents throw ENOENT) can proceed, but the fix list assumes the caller changes are acceptable.
- **Any deployment** depends on P0-8 plus a domain decision: the runtime needs `runtime.<domain>` and previews need
  `*.<previewBase>`, and the audited Vercel account currently has no custom domain and a hobby plan.

## What is not blocked

Phase 10 steps 1–3 and 5 need no architectural ruling and are implemented alongside this page: true test counts, split
TypeScript lanes, and CI guards.
