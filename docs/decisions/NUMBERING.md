# Numbering: what every number in this repository means

Four numbering schemes are in play, and three of them used the token "6" or "R6" for different things. On 2026-11-08 the
rulings were renamed to end the worst of the collision. This page is the reference.

**Rule:** the audit's numbering is authoritative for the audit document. The repository's numbering is authoritative for
the repository. Never cite a bare number across that boundary. Write `Phase 6` (plan phase), `P0-6` (ruling), `R6`
(historical milestone), `PR #6` (pull request), `ADR-0009` (decision record).

## Current names

| Scheme | Lives in | Range | Example |
| --- | --- | --- | --- |
| **Audit Programmes** | external audit document, not in this repo | 1 to 8, of which only 1 to 5 were ever delivered | "Programme 6" |
| **Plan Phases** | the fix plan; phase headings throughout `docs/` | 0 to 10 | `Phase 6` = a real shell on a PTY |
| **P0 rulings** | `docs/decisions/P0-rulings.md` | `P0-1` to `P0-10` | `P0-6` = wire or delete `src/shims/presets.ts` |
| **Milestones** | `docs/phase-6/`, ADR-0016, commit messages | `R1` to `R7`, with sub-steps `R6a` to `R6e` | `R6` = deterministic offline dependency corpus |
| **ADRs** | `docs/decisions/ADR-*.md` | `ADR-0001` to `ADR-0021` | `ADR-0021` = frame binary bodies only |
| **Pull requests** | GitHub | `#1` upward | `PR #6` = phase2/envelope-presets |

## What was renamed, and why

The rulings were `R-1` to `R-10` and collided with the milestone series `R1` to `R7`, which is a one-character
distinction (`R-6` ruling versus `R6` milestone) that survived review three separate times. They are now `P0-1` to
`P0-10`, which also matches where they live: under the Phase 0 heading.

References updated in: `docs/decisions/P0-rulings.md`, `docs/audit/response-nov-08.md`,
`docs/references/discovery-stackblitz-public.md`, `ADR-0005`, `ADR-0007`, `ADR-0012`, `ADR-0013`, `ADR-0016`,
`ADR-0017`, `ADR-0019`, and one code comment in `src/network/preview-gateway.ts`.

Deliberately **not** renamed:

- **Milestone names** `R6`, `R6a` to `R6e`, `R2`. They appear in commit messages, ADRs and the milestone docs, and
  rewriting history would break more than it fixes. The two live milestone docs now carry a header stating they are
  milestones and not rulings.
- **ADR decision ids** `D-1` upward. Two different ADRs both define a `D-1`, so a bare `D-1` is ambiguous: always write
  it with its ADR, as `ADR-0004 D-1`.

`ADR-0009` is hash-pinned by `tests/unit/harness.refusal-contract.test.ts`, which is why the annotation pass leaves it
alone and why any future edit to it must update that hash deliberately.

## The trap this file exists to prevent

`P0-6` asks whether `src/shims/presets.ts` should be wired in or deleted. **That file does not exist on
`docs/audit-response-2` (`af8bf97`) or its engine base `feat/p1d-worker-supervisor` (`5c15fe2`).** `src/shims/` there
holds `fs`, `path`, `process`, `events`, `http`, `stream` and `.gitkeep`, and nothing else.

The file exists only where `PR #6` (`7205395`) is present, which is `main` after the merge `e65e087`. So `P0-6` is not a
question about a currently-dead file; it is a question about what to do **when PR #6 lands**. A reviewer reading
`P0-rulings.md` against a branch without the file will conclude the transfer already happened and the ruling is moot.
It is not. The ruling now carries this note inline.

## The same trap, generalised

Every audit of this project so far reviewed a snapshot whose commit was unnamed, which is how three audits in a row
reported a service-worker registration that both audits were right to miss and wrong to generalise. Before auditing,
name the commit: `git archive <sha>` or a `PROVENANCE.md` inside the archive. See `docs/decisions/P0-rulings.md` and the
archive shipped on 2026-11-08 (`af8bf97`).
