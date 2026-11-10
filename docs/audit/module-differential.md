# Module resolution and error shapes, measured against Node

**Date:** 2026-11-10. **Instrument:** `tools/differential/modules.ts`, cases in `tools/differential/module-cases.ts`.
**Result:** 14 of 14 cases match Node 20, after two defects the measurement found.

## Why this exists

Fix-order item 7 in `docs/audit/response-nov-08.md` names module resolution and error shapes as the half of "does my program run"
that a unit suite cannot settle. A green suite proves the resolver produces *a* resolution, not Node's. The event-loop differential
(`docs/audit/event-loop-differential.md`) settled ordering the same way; this settles which file a `require` picks and what a
program sees when it fails.

## Method

Every case is one description: a small file tree plus an entry. It is staged twice from that single description, once into a temp
directory for real Node and once into the VFS for this runtime, then both are run and their stdout compared.

Three deliberate choices:

- **Error cases print fields, not stacks.** A case prints `name` and `code`, never the stack. A stack carries staging paths and
  Node's internal frames, so comparing it would report differences no program can observe while hiding the ones that matter.
- **Staged from one truth.** Two hand-kept fixtures would drift, and a difference would then be unattributable.
- **A case that prints nothing counts as a failure**, not as agreement: "no output" is reported with its exit code, because an
  empty stdout comparing equal to an empty stdout is the failure mode this whole instrument exists to avoid.

## What it found

| Case | Node | This runtime, before |
|---|---|---|
| `missing-module-shape` | `name=Error code=MODULE_NOT_FOUND` | `name=ModuleNotFoundError code=MODULE_NOT_FOUND` |
| `missing-directory-index-shape` | `name=Error code=MODULE_NOT_FOUND` | `name=ModuleNotFoundError code=MODULE_NOT_FOUND` |
| `require-main-fields` | `mainIsSelf=true childSawMain=false` | `mainIsSelf=false childSawMain=false` |

Both are real and neither was reachable from the existing suite.

1. **The error's visible name was our class name.** Programs log `error.name`, and framework code compares it against `"Error"`.
   The class stays for debugging; its `name` is now `"Error"`, which is what Node reports. The `code` was already correct, which is
   why nothing had noticed.
2. **`require.main` did not exist.** The `require.main === module` test is the standard way a CommonJS program asks "am I the
   entry?", and here it answered `false` in the entry itself. The loader now records the first module it evaluates and exposes it as
   `require.main` on every require function, read at call time.

Eleven of fourteen cases matched before these fixes. All fourteen match after them.

## What already matched, so it stays matched

File-before-directory preference, the trailing-slash directory form, `package.json` `main`, the fallback to `index.js` when `main`
points at nothing, `.json` parsing, `require("path") === require("node:path")`, module cache identity with one evaluation, circular
requires seeing partial exports, ancestor `node_modules` lookup, a throwing module surfacing to its caller, and a malformed
`.json` failing as a parse error.

## This is now a gate

`npm run diff:modules` reports and exits 0. `npm run diff:modules:strict` fails on any deviation, and `npm run verify` runs it.
That is a deliberate reversal of the event-loop differential's reporting-only stance: it is justified only because the comparison
is deterministic and currently exact. If a future case turns out to depend on a Node patch version, the honest response is to fix
the case, not to soften the gate.

## Limits

- CommonJS only. ESM resolution (`exports` maps, conditions, self-reference) is out of scope under ADR-0012, and a case that
  measured it would be measuring something the runtime does not claim.
- `node_modules` cases use a tree staged by the harness, not a package installed from a registry; installation is covered by the
  corpus checks instead.
- The oracle is whatever `node` the gate runs on. The suite pins Node 20 in CI, and a local run on another major version is a
  local result.
