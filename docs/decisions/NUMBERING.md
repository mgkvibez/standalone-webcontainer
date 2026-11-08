# Numbering: four schemes that currently collide

The project is reviewed by an outside auditor, by the owner, and by whoever reads the commit log next. Four separate
numbering schemes are in play, and three of them use the token "6" or "R6" to mean different things. This page is the
disambiguation. It decides nothing about architecture and changes no code.

**Rule of thumb:** the audit's numbering is authoritative for the audit document. The repository's numbering is
authoritative for the repository. Never cite a bare number across the boundary: write `Phase 6` (repo plan), `P0-6`
(ruling), `M6` (milestone), or `PR #6`.

## The four schemes

| Scheme | Where it lives | What "6" means there | Range in use |
| --- | --- | --- | --- |
| **Audit Programmes** | external audit document, not in this repo | unknown; the document was never delivered past Programme 5 | 1 to 8, of which 1 to 5 are known |
| **Plan Phases** | `docs/decisions/` plan phases, quoted in the fix plan | `Phase 6` = a real shell on a PTY, replacing the fixed command list | 0 to 10 |
| **P0 rulings** | `docs/decisions/P0-rulings.md` | `R-6` = wire or delete `src/shims/presets.ts` | R-1 to R-10 |
| **Milestones** | `docs/phase-6/`, ADR-0016, commit messages | `R6` = deterministic offline dependency corpus, with sub-steps R6a to R6e | R1 to R7 within one phase |

Two further namespaces appear in the same sentences and should never be abbreviated: **ADRs** (`ADR-0009`) and **pull
requests** (`PR #6`, `PR #7`). A sentence like "R6 lands after #6" contains a milestone, a pull request, and an implied
phase, and is unreadable without this table.

## The collision matrix for the token 6

| Written | Actually means |
| --- | --- |
| `Phase 6` | a real shell and PTY; the phase that unblocks `npx`, `pnpm`, `yarn`, `sh` and `bash` |
| `R-6` | ruling: is `src/shims/presets.ts` wired in or deleted? |
| `R6` / `R6a` to `R6e` | milestone: deterministic offline dependency corpus, already built (ADR-0016) |
| `docs/phase-6/` | folder holding that milestone's proposal and the pnpm command contract |
| `PR #6` | phase2/envelope-presets, the pull request that wires `presets.ts` in |
| `Phase 0` | decisions to ratify; where `R-1` to `R-10` live |

## A trap worth recording

`R-6` asks whether `src/shims/presets.ts` should be wired in or deleted. **That file does not exist on
`docs/audit-response-2` (`af8bf97`) or its engine base `feat/p1d-worker-supervisor` (`5c15fe2`).** `src/shims/` there
holds `fs`, `path`, `process`, `events`, `http`, `stream` and `.gitkeep`, and nothing else.

The file exists only where `PR #6` (`7205395`) is present, which is `main` after the merge commit `e65e087`. So `R-6` is
not a question about a currently-dead file on the audited branch; it is a question about what to do **when PR #6
lands**. Anyone reading `P0-rulings.md` against a branch that lacks the file will conclude the file was already deleted
and the ruling is moot. It is not.

## Suggested rename, for the owner to accept or reject

Renaming is cheap now and expensive after more documents cite these numbers, but it is a documentation change with
in-flight references, so it needs an owner decision rather than being done unilaterally:

- Rulings `R-1` to `R-10` become `P0-1` to `P0-10`. Distinct from every other scheme, and they already live under a
  Phase 0 heading.
- Milestones keep their historical names in `docs/phase-6/` but future ones are written `M7.1`, `M7.2`, so no milestone
  is ever a bare "R" again.
- ADR decision ids keep `D-n` but always carry their ADR: `ADR-0004 D-1`, never `D-1` alone. Two ADRs use `D-1`, which
  is its own silent collision.

Until a rename is accepted, this page is the reference.
