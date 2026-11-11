# `vite build`, end to end: four fixtures and the five defects they found

**Date:** 2026-11-11. **Instrument:** `npm run fixtures:run -- --id <n> --registry=snapshot:fixtures/snapshots/vite`, which drives each
definition through the real `Container`, the real runtime, the real VFS and the real installer, against the frozen vite snapshot (real
tarballs, pinned by integrity, no network). Evidence is written to `.evidence/fixtures/<slug>/`.

## What passes now

| Fixture | What it runs | Assertions |
|---|---|---|
| 11 Vite build | `npm install`, `npm run build` → `vite build`; a five-module app with CSS | exit 0, `dist/index.html` exists |
| 13 Vite dev/preview | serves `index.html` over HTTP on port 3300, twice | two body assertions through the preview gateway |
| 17 large graph | `node gen.mjs && vite build`; 300 generated modules of 40 kB each (12 MB of source), named `bundle.js` output | `dist/bundle.js` exists |
| 18 config file | `node generate.mjs && vite build`; a `vite.config.js` the build must load | exit 0, `dist/index.html` exists, `dist/assets/app.js` contains `generated-marker` |

Eight fixtures now pass in total (01, 04, 07, 08, 11, 13, 17, 18). Four of the eight are the front-end lane, which is the lane the
shippable-isolation gate is written against.

**These four fixtures had no files before this slice.** They were definitions with commands and assertions and nothing to run, so nothing
could be measured through them. Writing the programs is what produced every defect below: each one is visible only when a real project with a
real build script runs against real vite bytes.

## Defect 1: a script's second half did not run, and the first half's exit code was the verdict

`package.json` scripts run under a shell, and the ecosystem writes `tsc && vite build` more often than it writes anything else. The container
took a script body apart by whitespace, found `node` at the front, and handed the WHOLE line to the launcher:

```
scripts.build = "node gen.mjs && vite build"
observed:  exit 0, no dist/, "generated 300 modules" on stdout and nothing else
```

The generator ran, `vite build` never did, and the step reported success. A build that silently skipped half of itself is the exact failure
mode this project exists to make impossible, so it is fixed at the level it belongs: `src/container/script-line.ts` splits on `&&` and `||`,
quote-aware and backslash-aware, and the runner sequences the segments with short-circuit. `--message "a && b"` stays one argument, because
that is one argument.

Pipes, redirection and subshells are deliberately NOT implemented: they change what a program sees, and a container that half-implemented them
would be lying about a shell it does not have. A body using them behaves as a single command, which is at least honest.

## Defect 2: a suspended program with real work pending was declared finished, and reported exit 0

With the sequencing fixed, `vite build` with a `vite.config.js` still produced nothing and still exited 0. The cause was the scheduler, not the
build. `WebAssembly.instantiate` hands back a promise that settles on real work on another thread, and the timer queue holds nothing while it is
pending. The scheduler's rule was "a suspended body with an empty queue has nothing left to offer", so it gave up after one real turn.

Two changes, both measured:

- `src/runtime/async-work.ts` counts work the queue cannot see. In flight means started and not yet settled, and only the four
  WebAssembly promise-returning entry points are counted: a timer, an `fs` callback and a promise continuation are all things the queue already
  knows about, and counting them twice would make the loop wait for work it is about to run. Node keeps a process alive because the operation
  holds a libuv handle; this runtime has no such handle, so the equivalent is an explicit count the scheduler polls.
- A run stopped by the guard while its body is still suspended now reports **exit 124**, not 0. Previously a program that never finished
  reported success with no output, which reads as "the build was empty" rather than "the program did not finish".

The differential lane keeps this honest: 16 of 16 event-loop cases still match real Node (`npm run diff:event-loop -- --strict`).

## Defect 3: our own earlier fix had cut esbuild's message channel

`esbuild-wasm`'s in-thread service is a Go program on a `WebAssembly.Module`, and it talks to its JavaScript side through `fs.read` on fd 0.
Its loader assigns `fs.read` and `fs.writeSync` unconditionally, after the host object exists, and the `read` it assigns is stdin-only: anything
else throws `Bad read`. An earlier slice answered that by making the assignment a no-op for `read`, which is why every build whose entry point
had to be read from disk died with `panic: JavaScript error: Bad read`.

`read` is now an ACCESSOR that COMPOSES the two channels: fd 0 goes to esbuild's own reader, which is the service's message channel, and every
other fd reads this object's files, honouring offset/length and positional or advancing position as Node does. `writeSync` keeps the opposite
treatment on purpose, because there the assigned version is the correct one: it is what carries the Go side's output to the program's stdout.

The rule this slice is recording: when a fix works by discarding what another component installed, the channel it cut has to be named. Here the
consequence was not a local bug but a runtime whose ability to build depended on whether a project had a config file.

## Defect 4: a `file:` URL was resolved as a package name

Vite loads a config it cannot `require` by bundling it with esbuild, writing `/vite.config.js.timestamp-….mjs`, and importing **the URL**:
`await import(pathToFileURL(temp).href)`. The loader treated `file:///….mjs` as a bare specifier and died:

```
Error: Cannot find module 'file:///vite.config.js.timestamp-1794397990976-f104eb8e10d44.mjs' from '/node_modules/vite/dist/node/chunks'
```

`resolve()` now converts a `file:` URL with `fileURLToPath` before the file probe, so the URL form reaches the same file the relative specifier
would. Percent-decoding is part of the test: `file:///app/a%20b.mjs` resolves to the file with a space in its name.
`tests/unit/runtime.esm.test.ts` pins the import, the missing-target message and the decoding.

## Defect 5: `fs` had the sync and promise members but not the callback ones

Immediately after the URL fix, vite died one step later with `TypeError: fs.unlink is not a function`, in a `finally` that deletes the temp file.
The shim had `unlinkSync` and `promises.unlink` and no `unlink`, which Node has had since forever.

Eight members are now derived from the promise forms rather than written twice: `readFile`, `writeFile`, `mkdir`, `unlink`, `rmdir`, `rename`,
`rm`, `access`, plus `promises.rmdir` and `promises.rename`. One implementation per operation is how Node layers them itself, so the path
rewrite and the error map already tested on the promise shape cannot drift from the callback shape.

Two details that the tests pin, because they are the ways a derived form goes wrong: the callback may arrive in either position
(`fs.readFile(p, cb)` and `fs.readFile(p, { encoding }, cb)` are both calls people write), and a missing file must arrive as `ENOENT` in the
callback's error argument rather than as a thrown exception. `tests/unit/shims.fs-callback-forms.test.ts` covers all eight members, the
optional-options positions, the recursive forms and the `this` binding the promise members rely on when they call their siblings.

## What the four fixtures do NOT prove

- **No cache, no dependency optimizer claim.** Each definition installs and builds once. `optimizeDeps` still resolves through `onLoad` and the
  boundary recorded in `front-end-boundary-esbuild.md` is unchanged.
- **The config is a plain object literal.** fixture-18's `vite.config.js` is bundled, imported from a temp URL and read; a config that imports a
  plugin package is not covered.
- **One HTML page, one entry.** Multi-page builds, dynamic imports that split chunks and asset handling beyond CSS are not exercised.
- **Builds are still bounded.** Charter §4.5 gives builds 240 s; a build that exceeds it is TIMEOUT and is not retried into a pass.
