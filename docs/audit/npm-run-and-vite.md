# `npm run`, and how far Vite actually gets

**Date:** 2026-11-10. Two things came out of aiming at the Vite fixture: a container feature that eight fixtures needed, and a named
engine limit that is now the front-end lane's only blocker.

## Why `npm run` mattered more than Vite

Fixture-01 is the front-end lane's shortest path, and its second step is `npm run dev -- --port 3000`. The container answered
`npm: unsupported command run`. That single refusal gated **eight** definitions (01, 02, 05, 06, 11, 13, 17, 18), every one of which
starts its app with `npm run dev` or `npm run build`. No fixture in the lane could produce a verdict while it stood.

What is implemented is npm's contract for the parts that matter:

- the script body comes from `package.json` and is executed **through the container**, so a script that runs `node server.mjs` behaves
  exactly like typing it;
- a bare `vite` resolves the way npm's `.bin` shim does: the package's `bin` field names the entry file, and that file runs under
  `node`. There are no symlinks, so the resolution is explicit rather than faked on disk;
- arguments are appended **only after `--`**. `npm run dev --port 3000` passes nothing, which is npm's rule; forwarding it would run
  something the fixture never asked for;
- `npm run` alone lists the scripts; a missing script is an error naming it and the available ones;
- recursion is bounded at eight levels, because `npm run a` where `a` is `npm run b` is legal npm and a self-calling script is not.

Three real defects came out while wiring it, each found by a test or a fixture rather than by reading:

1. **`npm run` was gated behind the registry guard.** The install path opens with "offline package corpus is unavailable", and running a
   project's own scripts needs no registry at all. A container without one answered a script request with a corpus error. The eight new
   container tests failed on this before it was reordered.
2. **Bin lookup only consulted the project's files.** Installed packages live apart from project files (they are runtime state,
   re-seeded per run), so `npm run dev` reported "no installed package provides a vite binary" while vite was installed.
3. **The `node` entry check had the same blind spot.** After (2) it printed `node: cannot find module '/node_modules/vite/bin/vite.js'`
   for a file that had just been installed. Both lookups now go through one helper that asks the dependency tree first.

## Vite's actual stopping point, measured

Each step below is the real message from a fixture run against a frozen snapshot of `vite@5.4.21` (8 packages, 1,464 KB, captured by
the snapshot lane so the measurement is reproducible without a network):

| Stage | Message |
|---|---|
| Before | `npm: unsupported command run` |
| After `npm run` | `vite: not a command in this container, and no installed package provides a "vite" binary` |
| After bin lookup | `node: cannot find module '/node_modules/vite/bin/vite.js'` |
| Now | **`EsmSyntaxError: top-level await is not supported by this loader yet (ADR-0012)`** from `src/runtime/esm.ts` |

So Vite installs, its binary resolves, its entry file loads, and the ESM transform stops it: Vite 5's `dist/node/cli.js` is ESM with
**top-level await**. ADR-0012 recorded that limitation deliberately, so this is not a surprise defect, it is the next decision. Making it
work is not a patch to the transform: our loader is synchronous (`require`-shaped), and TLA needs the module graph to become
awaitable, which changes `loadFile`'s contract for every caller.

That is why the verdict for fixture-01 is still `RUNTIME_INCOMPATIBILITY` and not `PASS`, and why the scorecard says so with a named
cause instead of "nothing was installed".

## A warning worth knowing about

Installing vite from the snapshot prints:

```
npm warning: @rollup/rollup-darwin-x64 skipped (optional, required by rollup@4.68.2): SNAPSHOT_MISSING: ...
```

Those are optional platform packages (`os: darwin`, `os: android`) that the snapshot does not hold because a Linux-ish browser runtime
never needs them. The tree is correct; the wording is what misleads, since it suggests a rebuild would help. The right fix is for the
installer to skip a platform-excluded optional dependency *before* asking the registry for it, which is a later, small change.

## State after this slice

- 1071 tests across 79 files (8 new `npm run` tests, and the committed-snapshot check now loops over every snapshot).
- fixture-08 still passes on both the network and the snapshot lane.
- fixture-01 reaches a named ESM limit rather than a command refusal, and the vite snapshot is committed so the claim is checkable.
- Nothing about the corpus decision changed: network is the product lane, snapshot is the gate lane, corpus stays unit-test-only.
