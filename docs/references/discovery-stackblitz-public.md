# Discovery: what StackBlitz's public surface tells us

**Date:** 2026-11-03 · **Status:** reference material, nothing here authorises implementation. Engine
internals are proprietary and were NOT read; everything below comes from their public docs, roadmap,
changelog, blog, issue tracker, and staff's own public repositories.

**Method.** Cloned `stackblitz/docs` and `stackblitz/webcontainer-core` (docs and issue templates
only, no engine), pulled `webcontainers.io` guides and API reference, read the two engineering
announcements (WASI, native package managers), and pulled all 1,958 issues from their tracker.
Licence posture for staff repos: `kirjavascript/git.wasm` has NO licence, so its contents were not
read (name and existence recorded only), per the clean-room protocol.

## 1. What is knowable, and what is not

Knowable: the contract users depend on, the browser requirements, the documented limitations, the
shape of real failures, and the order in which they solved hard problems.
Not knowable: how the engine executes Node, its syscall layer, its memory model. No amount of repo
reading changes that, and guessing at it would be worse than admitting it.

## 2. Architecture as their docs describe it

- **User code runs on a different origin.** Every browser-configuration page is about third-party
  cookies, third-party storage partitioning, popups and Service Workers being blocked because they
  are third-party (`local.webcontainer.io`, `*.webcontainer.io`). That is only possible if the
  runtime lives in a cross-origin iframe, not on the host page's origin.
- **Cross-origin isolation is mandatory.** `Cross-Origin-Embedder-Policy: require-corp` (or
  `credentialless` plus a matching `coep` boot option) and `Cross-Origin-Opener-Policy: same-origin`,
  because `SharedArrayBuffer` is required. Same as ADR-0001's COOP/COEP decision.
- **One instance at a time.** `WebContainer.boot()` yields a single instance per page; you must
  `teardown()` before booting again.
- **Node 18** shipped; Node 20 has been "in development" and multiple Node versions sit in "future"
  (issue #560). This is a product that runs ONE Node line at a time.
- **WASI shipped October 2023** (Dominic Elm, Founding Engineer and Team Lead). Native *languages*
  became possible; native *addons* did not.
- **Native addons are disabled by default** with `--no-addons`, producing
  `Cannot load native addon because loading addons is disabled`. They chose an explicit, documented
  refusal over a crash. We should copy the refusal, not the flag name.
- **They built their own package manager, then deleted it.** Turbo, their custom npm client, was the
  default until native npm/pnpm/yarn arrived (announced June 2023 after "the past year" of work) and
  Turbo was removed April 2024. Their trajectory is: custom resolver first, real package manager
  second, custom resolver dead.
- **`jsh` exists**, evidenced by an issue titled `jsh: spawn ... ENOENT` while running an npm binary.
  Executing `node_modules/.bin` shebang scripts is a distinct subsystem with its own interpreter.
- **Open, unresolved at their scale:** memory pressure (issue #1120, still open) and a CORS proxy
  (still "in development" on their roadmap). Even the incumbent does not cleanly solve CORS inside
  the preview.

## 3. The contract users actually depend on

From the API reference and changelog: `boot(Options)`, `teardown()`, `mount(tree)`, `spawn(cmd,
SpawnOptions{cwd, env, output})`, `fs` (FileSystemAPI), `path`, `workdir`, and events
`server-ready`, `port`, `preview-message`, `error`. Boot options include `coep` and
`forwardPreviewErrors`; utilities include `reloadPreview` and `setPreviewScript`; `export` of the
file system arrived in 1.4.0.

Feature arrival order is instructive: `fs.rename` only in 1.1.6, `fs.watch` in 1.1.8, file-system
`export` in 1.4.0. Watching the filesystem is a late, hard feature, not an early one.

## 4. Failure taxonomy from 1,958 real issues

Counted from titles (all issues, 2021-05-20 to 2026-10-27; 823 open, 1,135 closed). Title matching
undercounts, so treat these as minimums and as relative weights, not absolutes.

| Class | Issues | Open | Share |
|---|---|---|---|
| Frameworks and tooling (vite, next, nuxt, astro, webpack, CLIs) | 276 | 92 | 14.1% |
| Install and resolution (npm, yarn, pnpm, ERESOLVE, peers, lockfile) | 190 | 75 | 9.7% |
| Ports, server-ready, preview, websockets | 86 | 39 | 4.4% |
| Cross-origin, COOP/COEP/CORS/SAB | 28 | 14 | 1.4% |
| fs semantics (ENOENT, symlink, watch, chmod) | 28 | 13 | 1.4% |
| Native or binary dependency (gyp, prebuild, .node) | 26 | 12 | 1.3% |
| Python/WASI/WASM | 26 | 15 | 1.3% |
| Toolchain binaries (esbuild, swc, rollup, lightningcss) | 21 | 2 | 1.1% |
| Memory / OOM / stack | 19 | 12 | 1.0% |
| Process, spawn, signals, argv | 13 | 9 | 0.7% |
| Service worker, DevTools | 8 | 4 | 0.4% |

**Read this carefully before drawing conclusions.** Native modules look almost absent (1.3%), yet
they are the single most commonly cited limitation. They are under-filed because the answer is
documented: addons are off. Issue counts measure confusion, not importance. The classes that are
both frequent AND fixable by us are install/resolution and ports/preview, which is the opposite
emphasis to the one a casual reading would produce.

Concrete fidelity gaps visible in titles, each a candidate test for us: `fs` callback and
`fs/promises` error typing, `Buffer` encoding union coverage, deleting a binary file, spawning a
package binary, and `RangeError: WebAssembly.instantiate(): Out of memory` needing to be catchable.

## 5. Their conformance suite, which we should adopt as our fixture basis

They publish a "Runtime Test Cases for AI Agents" suite explicitly intended to evaluate ANY runtime,
so it is fair game as a public benchmark: NodeJS (multiple processes, async promises, fs operations,
built-ins, http server, streams, child processes, IPC, timers, EventEmitter), package managers (npm,
yarn, pnpm), CLI tooling, Vite, Next.js, shadcn-ui, React Router, Nuxt, LibSQL, Drizzle ORM.

Proposed mapping onto our pre-registered 20 slots (PROPOSED, needs owner sign-off; the numbering and
lane split are the charter's, the contents are mine):

- **Front-end-only (1-4, 7-14, 18-20):** 1 Vite dev server boots and serves; 2 React Router app; 3
  shadcn-ui CLI adds a component; 4 NodeJS core (fs, http server, streams, timers, EventEmitter);
  7 CLI tool (commander-style, argv/exit codes); 8 Express static server; 9 `npm install` of a
  pure-JS dependency; 10 yarn and pnpm equivalents; 11 Vite production build; 12 TypeScript compile;
  13 file edit triggers dev-server HMR (exercises fs.watch); 14 spawn a `node_modules/.bin` script;
  18 shadcn-ui build; 19 LibSQL WASM query; 20 Drizzle ORM schema plus migration.
- **Boundary / server-lane candidates (5, 6, 15, 16, 17):** 5 Next.js; 6 Nuxt SSR; 15 a native addon
  (sharp) to prove the honest refusal; 16 real sockets and websockets; 17 a large bundle at the
  memory ceiling.

Note 15 is deliberately a fixture that must FAIL cleanly, with a typed refusal rather than a crash.
A gate that cannot express "refused on purpose" cannot distinguish a limitation from a bug.

## 6. The finding that should worry us most

**User-code origin isolation.** StackBlitz runs user code on a separate origin and pays for it in
documentation pain (cookies, storage partitioning, popups, blocked Service Workers) because the
alternative is worse: on our plan, the service worker sits on the host origin and previews live under
`/preview/<port>/`, which means user code shares an origin with the host application. Same-origin user
code can read the host's cookies, token storage and DOM.

This is not a detail. ADR-0002 #5 chose the simple routing model and does not address origin
separation; the charter says only the isolation rate justifies shipping user code, so this belongs in
front of the expert before any preview is offered to a third party. Recorded as risk **R-1**, not
acted on.

## 7. Take / refuse / defer

- **Take:** the conformance suite as fixture basis; typed refusal for native addons; the
  `jsh`-shaped insight that package binaries need an interpreter; the documented header pair; late
  and honest deferral of `fs.watch`; contract vocabulary (`server-ready`, `preview-message`) so our
  `Runtime` interface can converge.
- **Refuse:** cross-origin iframe as our first model (it buys isolation at a heavy documentation and
  UX cost, and it is a decision, not a default), proprietary engine assumptions, and copying the
  resolver-then-abandon-it arc by writing our own package manager.
- **Defer:** streaming bodies, memory-pressure work, multiple Node versions, CORS proxy.

## 8. Staff repositories, honestly

Most public member repos are empty forks (`node`, `tsx`, `typeorm`, `koa`, `ava`). Real signal:
`kirjavascript` is the emulation/WASM specialist (CHIP-8, Mega Drive, `mdcomp-wasm`, and `git.wasm` —
no licence, contents not read; its existence tells us git-in-browser is a WASM compile problem, not a
JavaScript one); `Nemikolh` published `devsandboxes` (Oct 2026, agent containers on docker/podman, i.e.
their server lane) and `rust-wasm-drop-not-called`, a probe repo whose name alone documents a real
hazard class: WASM resource cleanup that silently never runs. Dominic Elm wrote the WASI announcement
and is not in the public member list.

## 9. Questions this raises for the expert

- **Q1 (R-1):** Do we adopt origin separation for user code now, or ship the same-origin preview and
  document the risk? This decides whether ADR-0002 #5 needs revision before any preview ships.
- **Q2:** Do we adopt StackBlitz's published conformance suite as the literal content of our 20
  slots, or keep slots open for our own cases?
- **Q3:** Is "run real npm" our package-manager strategy (their eventual answer), accepting that it
  requires enough Node fidelity to execute npm itself?
- **Q4:** Does fixture 15 exist as a must-fail-cleanly case, and does the gate need a fourth
  classification (`UNSUPPORTED_BY_DESIGN` already exists — is it excluded from the denominator)?
- **Q5:** `fs.watch` arrived late even for them: confirm it is out of Phase 1 scope.
