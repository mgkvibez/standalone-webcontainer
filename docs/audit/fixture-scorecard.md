# The twenty fixtures, run for the first time

**Date:** 2026-11-10. **Commit:** `4ded40e` plus this change. **Instrument:** `tools/harness/fixture-executor.ts` driven by
`tools/harness/run-fixture.ts` (`npm run fixtures:run -- --all`), which takes each definition through the real `Container`, the
real runtime, the real VFS and the real preview gateway, and writes evidence to `.evidence/fixtures/<slug>/`.

## Why an executor had to come first

The gate had definitions, scoring, evidence writing and freeze checking. It had no step executor: every test supplied a
hand-written one, so no fixture had ever been executed. That was one of three reasons the gate could score nothing, and it was
independent of "no fixture is frozen".

The adapter is thin on purpose. The command line goes through `Container`, the same dispatcher the workspace uses, so
`npm install`, `npm run <script>` and `node <file>` behave here as they do in the app. stdout, stderr and the exit code come from
the process record rather than from terminal parsing. The corpus is read from the committed bytes, so no network is involved.

Two things that looked like adapter gaps are now closed, and each is proven by a test rather than asserted:

- **A program's writes are readable.** They exist only in the runtime VFS, so `RuntimeSupervisor.readRuntimeFile` reads it and
  `file-exists` / `file-contains` consult the VFS after the project snapshot. Without this, a fixture asserted on files it had not
  itself seeded, which is most of them.
- **HTTP assertions are probed, not skipped.** They go through the same `PreviewGateway` the browser proxy uses, with the
  fixture's `http://localhost:<port>/…` translated to the gateway's `/preview/<port>/…` by `src/harness/preview-target.ts`. A
  remote host is refused as a harness fault instead of being routed to a local port.

`tests/unit/fixture-executor.test.ts` is the proof: one definition whose program writes a file and starts a server, asserting
`exit-code`, `stdout-contains`, `file-exists`, `http-status` and `http-body-contains`, all five passing through the container. If
that test is green, a passing fixture elsewhere means something.

A step that leaves a server listening reports exit code 0, not -1: the container marks a process "running" with ports only when
the runtime reported exit 0 for the program, so 0 is what happened and the server is simply outliving it. Anything with no exit
code that did not become a server is -1, so an exit-code assertion cannot pass on a process that never finished.

## Finding 1: seventeen definitions contain no files

Only `fixture-01`, `fixture-04` and `fixture-07` ship a program. A definition that says `npm install` then `node check.mjs`, with
no `package.json` and no `check.mjs`, cannot pass in this runtime or in Node.

```
fixture-09  step 0  exit 1  npm: only npm install/npm ci and --omit=dev are supported; package arguments and other flags are refused
fixture-09  step 1  exit 1  node: cannot find module '/check.mjs'
fixture-12  step 0  exit 1  npm error: MISSING_PACKAGE_JSON: no package.json at /package.json
```

Eleven also ask for something the approved profiles refuse on purpose (`npm install <package>` with arguments, and `pnpm install`
for fixture-10). Those refusals are correct under D-4 and the pnpm contract; the definitions predate both.

## Finding 2: the offline corpus is synthetic, so no real package can install

This is the deeper blocker, and the second pass made it visible. The committed corpus holds **ten packages, all of them
`@corpus/*` and `@corpus-broken/*`** test fixtures. There is no `vite`, `react`, `next`, `express`, `typescript`, `ws`, `sharp`,
`is-odd`, `cowsay`, `drizzle-orm` or `@libsql/client` in it, so every install in the front-end lane fails at resolution:

```
fixture-01  http-status 503 from http://localhost:3000/   (nothing installed, so no runtime was ever loaded)
fixture-13  body "No project runtime is loaded."
```

Writing the seventeen missing programs would therefore not move a single verdict until either real packages are vendored into the
corpus or the runtime is allowed to reach a real registry. That is a decision about what this project is, not a bug: an offline
corpus is reproducible and a live registry is the product.

## Every verdict, with its cause

| Fixture | Verdict | Cause | Runnable today? |
|---|---|---|---|
| 01 Vite dev server | RUNTIME_INCOMPATIBILITY | `vite` not in the corpus, so install fails and nothing listens | no |
| 02 | RUNTIME_INCOMPATIBILITY | no files; no packages | no |
| 03 shadcn CLI | RUNTIME_INCOMPATIBILITY | no files; `npx` is refused by design | no |
| 04 core surface | **PASS, 6/6** | fs, http, streams, timers, EventEmitter | yes |
| 05 | RUNTIME_INCOMPATIBILITY (expected) | no files; no packages | no |
| 06 | RUNTIME_INCOMPATIBILITY (expected) | no files; no packages | no |
| 07 CLI | **PASS, 3/3** | argv, a file read, an exit code | yes |
| 08 express | **PASS** | 68 real packages from registry.npmjs.org, express 5 serves the body on port 3200 through the preview gateway; 3/3 assertions — see `shim-layer.md` | frozen once signed off |
| 09 is-odd | RUNTIME_INCOMPATIBILITY | install with arguments refused; no files | no |
| 10 pnpm | RUNTIME_INCOMPATIBILITY | `pnpm install` restricted by D-4 | no |
| 11 Vite build | RUNTIME_INCOMPATIBILITY | no files; `vite` not in the corpus | no |
| 12 tsc build | RUNTIME_INCOMPATIBILITY | no files; `typescript` not in the corpus | no |
| 13 | RUNTIME_INCOMPATIBILITY (expected) | no files; no runtime loaded | no |
| 14 cowsay | RUNTIME_INCOMPATIBILITY (expected) | no files; `cowsay` not in the corpus | no |
| 15 sharp | RUNTIME_INCOMPATIBILITY | no files; native refusal never reached | no |
| 16 ws | RUNTIME_INCOMPATIBILITY (expected) | no files; `ws` not in the corpus | no |
| 17 | RUNTIME_INCOMPATIBILITY (expected) | no files; no bundler | no |
| 18 | RUNTIME_INCOMPATIBILITY | no files; no bundler | no |
| 19 libsql | RUNTIME_INCOMPATIBILITY (expected) | no files; not in the corpus | no |
| 20 drizzle | RUNTIME_INCOMPATIBILITY (expected) | no files; not in the corpus | no |

Seven verdicts fall inside their own expected set (04, 07, 14, 16, 17, 19, 20). That is not seven passes: five of those accept
`RUNTIME_INCOMPATIBILITY` as a legitimate outcome, so their "expected" is a statement about a refusal, not a success.

**What is actually measured about the runtime.** `fixture-04` exercises `fs`, `http`, streams, timers and `EventEmitter` in one
script and passes all six assertions through the real container; `fixture-07` exercises a CLI with argv, a file read and an exit
code and passes all three. Those are the first verdicts the gate has ever produced through its own path.

## What this means for release

| Blocker | Size | Owner |
|---|---|---|
| The corpus holds no real package | either vendor the packages the fixtures name, or allow a real registry | **product decision**: offline-and-reproducible versus connected-and-real |
| 17 definitions have no program | 17 files to write, each faithful to the intent and assertions already written | implementation, once the corpus question is answered |
| 11 definitions predate the approved npm/pnpm profiles | rewrite as plain `npm install`, or flip expected to the refusal | owner |
| No fixture is frozen | one sign-off per definition, after the items above | owner |

## Limits of this evidence

- Node-side, so it measures the container, the runtime, the VFS and the gateway, not the browser Worker or the proxy's own
  network path. The browser lane covers that separately.
- One engine, one machine, no network.
- Evidence is written to `.evidence/` (git-ignored). Nothing here is a frozen outcome: an outcome is only an outcome once a
  definition is frozen and its assertions are signed off.
