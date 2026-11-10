# Real packages, measured

**Date:** 2026-11-10. **Instrument:** `tools/npm-live-probe.ts`, which drives the real installer
(`src/npm/install.ts` → `installDependencies`) against `registry.npmjs.org`. Manual, never in `verify`: CI has no network, and the
corpus lane exists so that it does not need one.

## What was already implemented, measured rather than assumed

The briefing for this round listed four things as missing. Three of them were already in `src/npm` and are exercised by the numbers
below:

| Claim | Measured |
|---|---|
| "zero decompression" | `src/npm/tarball.ts` gunzips with `DecompressionStream` and reads tar into memory, with a bounded expansion guard |
| "zero integrity verification" | sha512 SRI is verified against the advertised `dist.integrity` before a byte is written; a mismatch writes nothing |
| "no lockfile" | `package-lock.json` at `lockfileVersion: 3`, with `integrity` per package, written by the same code path |
| "no node_modules hoisting" | shallow hoisting exists and is documented as a deviation: a name goes to the top level unless a different version already holds it |
| "no peer dependencies" | **true, and still true**: peer dependencies are not installed; express needs none, vite does not either, but a real plugin ecosystem will |

What was genuinely missing is different: the live client existed but nothing used it, `npm install <spec>` was refused, and no
range like the ones real packages publish had ever been parsed.

## Installations from the real registry

| Package | Packages | Tarball bytes | Files staged | Time |
|---|---|---|---|---|
| `is-odd@3.0.1` | 2 | 6,248 | 9 | 139 ms |
| `react@18.3.1` | 3 | 91,135 | 34 | 372 ms |
| `vite@5.4.11` | 8 | — | — | — |
| `typescript@5.6.3` | 1 | 4,174,590 | 122 | 662 ms |
| `express@4.21.2` | 72 | 743,103 | 667 | 2.2 s |

Every one succeeded, with a lockfile, with integrity verified per tarball, with no warnings.

## Two defects the real bytes found immediately

**1. A range that real packages publish was unsatisfiable.** `safer-buffer` publishes `>= 2.1.2 < 3`, and an express install hits
it twice. The range tokenizer split on whitespace, so the alternative became `[">=", "2.1.2", "<", "3"]`; the token `">="` carries
no version, `comparatorsFor` returned null, and the whole range became unsatisfiable. The installer then reported
`NO_MATCHING_VERSION: no version of safer-buffer satisfies ">= 2.1.2 < 3" (newest is 2.1.2)`, which is a correct message about an
incorrect parse. Fixed in `src/npm/semver-range.ts` by letting a bare operator absorb the token after it, and pinned two ways: a
differential block that compares against npm's own `semver` for five spaced-operator ranges × nine versions, plus the exact
`safer-buffer` case. No synthetic corpus package published that form, which is precisely why nobody had seen it.

**2. The runtime has no `node:zlib`.** With express installed (68 packages, real bytes, through the container), `node server.mjs`
fails at `Cannot find module 'node:zlib' from '/node_modules/body-parser/lib'`. body-parser requires zlib for content-encoding
handling. That is now the single blocker between fixture 8 and a real verdict.

## What this changes

The product path now exists and is reachable: `npm install express` in a project with no manifest installs from
`registry.npmjs.org`, prints `added 68 package(s) from registry.npmjs.org`, and writes a v3 lockfile with integrity. The corpus
path is unchanged and remains the default for tests and CI, and every install line now names its source, because "from the offline
corpus" and "from registry.npmjs.org" are different claims.

Remaining work, in order: a `zlib` shim (inflate/gunzip/deflate, sync and stream forms, since body-parser uses the stream form),
then whatever `node server.mjs` asks for next, with each missing builtin found by running a real package rather than by guessing.

