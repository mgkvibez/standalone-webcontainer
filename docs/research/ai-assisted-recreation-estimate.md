# AI-assisted recreation estimate: what collapses, and what does not

**Date:** 2026-11-03
**Status:** Research note. It informs a decision; it does not make one. Nothing here is
ratified, and nothing here authorizes implementation.
**Audience:** the human expert, who owns every decision this note raises.

## 1. Why "hours" is the wrong unit

"How long would an AI pair need to rebuild WebContainers" has no answer until "done" has one.
This repository already defines done: the pre-registered gate, twenty fixtures, at least 90% on
the front-end-only set (1-4, 7-14, 18-20), with the boundary fixtures reported separately. An
estimate that is not measured against that gate is a description of a demo.

So the unit below is **sessions**: one focused block of agent work with tool access, ending in a
verified state. Hours are derived, never the headline. The binding constraint on this kind of work
is not generation, it is verification, and verification costs one cycle per broken package.

## 2. Tier 1 — scaffolding (owner estimate: 2-4 hours)

Three of the five ingredients are allowlisted and cheap, confirmed against the npm registry today:
Monaco MIT, `@xterm/xterm` MIT, `esbuild-wasm` MIT. The VFS the estimate budgets for is already
built and tested (`src/vfs/`, ADR-0002 ratified decisions 1, 4, 6), which removes the only
load-bearing part of this tier.

Two items cannot proceed as written:

- **Pyodide is MPL-2.0.** That is outside the ratified allowlist (MIT, Apache-2.0, BSD, ISC).
  It is not a judgement call the implementer may make. Separately, ADR-0001 puts Python in the
  **server lane** ("server sandbox fallback for native modules, Python, and heavy builds"), and
  reserves the browser lane for JS-shimmed Node on native V8. "Python in the browser in an
  afternoon" is therefore two decisions, not one task.
- **A WebSocket terminal contradicts ADR-0002 decision 5**, which rejects WebSockets in Phase 1
  and routes the service worker to the runtime over `MessageChannel`. xterm.js attaches to the
  PTY bridge, not to a socket.

**Revised:** 1 session to a demo-shaped tier (VFS wiring, Monaco, terminal over `MessageChannel`),
2-3 sessions to the same thing testable. Confidence: high.

## 3. Tier 2 — the Node-shaped layer (owner estimate: 1-2 hours)

The premise is verified rather than assumed: `registry.npmjs.org` serves both package metadata
and `.tgz` tarballs with `access-control-allow-origin: *` (headers captured 2026-11-03), so a
service worker can fetch them directly. Fetching is not where the time goes.

The time goes into **resolution**, and this is where every reimplementation drowns:

- semver graph walking, peer dependencies, deduplication and hoisting into a flat tree
- CommonJS/ESM interop, including packages that ship both with different behaviour
- `exports` maps and conditional exports, which is where a naive resolver loses the majority of
  real packages
- the `browser` field substituting modules, and packages that assume `process.binding`
- tarball extraction (gzip + tar) inside the worker, with the ADR-0002 decision 4 memory cap
  applying to every extracted file

ADR-0003 already routes this onto `unenv` (MIT) presets and a `memfs` (Apache-2.0) shape reference
over our own VFS, which is the right call and does most of the API surface for pure-JS packages.

**Revised:** 2-3 sessions for install + resolution of pure-JS packages, plus 1-2 for the static
server and `/preview/<port>/` routing. Express works for the ordinary middleware path; anything
that upgrades to a raw socket is lane 2 by definition. Confidence: medium. This is the tier where
I expect the estimate to be wrong by a factor rather than a margin.

## 4. Tier 3 — "90% of pure-JS npm via WASI" (owner estimate: 1-2 hours)

Two problems, one of them structural.

- **It contradicts ADR-0001**, which is ratified and explicitly marked do-not-re-litigate:
  browser-native V8 with JS-shimmed Node APIs, "NOT a WASI-compiled Node.js binary". Tier 3 as
  written is therefore an ADR amendment, not a work item. If the expert wants it, it should be
  argued in an ADR, with the original reasoning answered rather than bypassed.
- **"90% of packages people demo with" is not a measurable quantity.** It is a feeling about a
  fixture set that has not been chosen. The gate already pre-registers twenty fixtures precisely
  so that this number cannot float.

For completeness rather than advocacy: if WASI were ever approved, `@bjorn3/browser_wasi_shim` is
`MIT OR Apache-2.0` and would run a `wasm32-wasi` Node build. That reintroduces a prebuilt binary
whose provenance must be audited, which is plausibly what the original "not a WASI binary"
decision existed to prevent.

**Revised:** not estimateable until the decision exists. If approved: 4-8 sessions. Confidence: n/a.

## 5. The three ceilings, sharpened

The owner's ceilings are right in substance and slightly off in phrasing. The distinction matters
because it decides which of them is a lane-2 feature and which is a permanent no.

1. **Native modules.** Agreed, permanent. A `.node` addon needs its C++ compiled for a different
   ABI per package. Generation speed changes nothing about that. Server lane, per charter.
2. **Raw sockets.** Agreed for arbitrary hosts. Nuance: a cooperating server can proxy TCP over
   WebTransport or WebRTC data channels, but that is the server lane with extra steps, and it
   cannot reach a host that has not opted in. "Permanently unsupported" is correct for the browser
   lane; "unsupported without cooperation" is the accurate general statement.
3. **`child_process`.** The ceiling holds, the phrasing needs care. You cannot spawn an OS process
   or see host PIDs. You *can* emulate spawn inside the sandbox by instantiating a second WASI
   instance, or a nested Worker, with its own stdio pipes. So: emulated in-sandbox, stubbed
   outside it, consistent with ADR-0002 decision 7 (`child_process` stub).
4. **Threading and memory.** `worker_threads` can be emulated with nested Workers; `SharedArrayBuffer`
   needs COOP/COEP, which ADR-0001 already requires; the tab's memory ceiling is real and
   unsolvable. Agreed on all three.

## 6. The number

| Tier | Demo | Testable | Gate-bearing | Sessions | Confidence |
|---|---|---|---|---|---|
| 1 — scaffolding | 1 | 2-3 | partly | 2-3 | high |
| 2 — Node-shaped layer | 3-4 | 5-7 | **yes** | 5-7 | medium |
| 3 — WASI Node subset | blocked | blocked | no | n/a | n/a |

**Gate-bearing total: roughly 7-10 sessions**, with the fidelity grind concentrated in tier 2 at
an estimated 150-400 fixture cycles of 2-6 minutes each. That grind is the estimate, not the
typing: the scripts, the shims and the UI are a day; the two hundredth "package X breaks on call Y"
is what a human team paid years for.

What would falsify this: if fixtures 1-4 come back under 50% after tier 2, the resolution layer is
wrong and the remainder roughly doubles. That measurement is worth more than any estimate here.

## 7. Decisions this note creates

Not taken, and not takeable by the implementer:

- **D1.** Pyodide: forbid it (Python stays server-lane), or amend the allowlist for MPL-2.0?
- **D2.** WASI Node: keep ADR-0001's ratified "not a WASI binary", or amend it?
- **D3.** Terminal transport: keep `MessageChannel` only, or amend ADR-0002 decision 5 for WebSockets?
- **D4.** Fixtures: is the pre-registered twenty final as the tier-2 scoring set?

## 8. Evidence behind the claims

- Licenses read from the npm registry on 2026-11-03: `pyodide` MPL-2.0, `@xterm/xterm` MIT,
  `monaco-editor` MIT, `esbuild-wasm` MIT, `quickjs-emscripten` MIT,
  `@bjorn3/browser_wasi_shim` MIT OR Apache-2.0, `unenv` MIT, `memfs` Apache-2.0, `comlink`
  Apache-2.0.
- CORS: `registry.npmjs.org/react` and `registry.npmjs.org/react/-/react-18.3.1.tgz` both returned
  `HTTP/2 200` with `access-control-allow-origin: *` when requested with an `Origin` header.
- Constraint text quoted from `docs/decisions/ADR-0001.md` and `ADR-0002.md` in this repository.
