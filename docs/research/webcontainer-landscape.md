# WebContainer Runtime Landscape — Research Report

**Date:** 2026-10-25/26 · **Method:** GitHub Search API (35 queries, ~470 raw results), license verification via REST API, plus two parallel web-research passes (articles, HN threads, project histories).
**Purpose:** map every significant "browser-native Node.js runtime" and adjacent component, so the expert has the full reference board for the shims, npm flow, and network layers — with charter license verdicts (MIT/Apache-2.0/BSD/ISC only).
**Status legend:** ✅ usable as reference/dependency · ❌ charter-forbidden (do not copy or depend) · ⚠️ partial.

## 1. Direct WebContainer-style runtimes

| Project | Stars | License (API-verified) | Verdict | Notes |
|---|---|---|---|---|
| StackBlitz WebContainers (`stackblitz/webcontainer-core`) | 4.6k | Repo MIT; **engine proprietary** | ❌ engine / ✅ docs | Repo contains only docs + issue tracker (verified: no source). `@webcontainer/api` SDK is MIT but is the forbidden wrapper path. |
| CodeSandbox Nodebox (`Sandpack/nodebox-runtime`) | 894 | **Sustainable Use License v1.0** (read from LICENSE) | ❌ | Exactly the license family the charter bans. Stale since 2023. Architecture concepts discussable; code off-limits. |
| Nodepod (`R1ck404/Nodepod`) | 194 | **MIT + Commons Clause** (read from LICENSE) | ❌ | Most complete open clone (VFS, shell, npm, worker processes, HTTP) — but Commons Clause bans commercial use; charter-forbidden. |
| OpenWebContainer (`thecodacus/OpenWebContainer`) | 188 | MIT | ✅ | Smaller TS monorepo: worker-isolated container, VFS, process mgmt, shell. Cleanest legally-studiable direct reference. |
| yangshun/nodepack | small | MIT | ✅ | Early Node-in-browser packaging experiment; clean reference. |
| almostnode (`macaly/almostnode`) | 1.2k | MIT | ✅ reference-only | Per project decision: no dependency, no fork. Our audit's four hazards (below) came from it. |
| iceddev/node-chromify | small | MIT | ✅ | 2013-era Node-builtins-to-browser shims; historically interesting for the shim-layer approach. |
| naruaway/npm-in-browser | small | MIT | ✅ | Runs `npm install` fully in-browser via CORS fetch to registry.npmjs.org. Prime reference for Week 3. |
| Leaning Tech BrowserPod (`leaningtech/browserpod-meta`) | 228 | Proprietary (All Rights Reserved) | ❌ | Node/Rust/C++/Python in browser via CheerpX; closed. |
| lifo (`lifo-sh/lifo`) | 542 | **none** | ❌ | Browser-native OS concept; no license = all rights reserved. |
| open-gitagent/clawless | 541 | MIT | ⚠️ | Consumer of the WebContainers API — evidence of demand, not a reference for our engine. |

**Limbo note:** the "Iced Dev Limbo" WebContainer-like project is not publicly released; Iced Dev's actual public work is `node-chromify`. "limbo" today = Turso's SQLite engine. Nothing usable there.

## 2. Heavy lane — VM/emulator approaches (ADR-0002's server-sandbox cousins)

| Project | Stars | License | Verdict | Notes |
|---|---|---|---|---|
| v86 (`copy/v86`) | 23.6k | BSD-2-Clause | ✅ | x86 emulator + x86→WASM JIT in browser. Can boot real Linux + Node. 10–50x CPU overhead; the "heavy builds" lane, not the browser lane. |
| WebVM (`leaningtech/webvm`) | 17.4k | Apache-2.0 (repo metadata) | ⚠️ | Full Debian in browser. **Caveat: the underlying CheerpX engine is proprietary** — Apache-2.0 covers the frontend only. Reference for UX/architecture; never the engine. |
| WASI-compiled Node (`node-wasi` et al.) | various | MIT mostly | ⚠️ | ADR-0002 ratifies JS-shimmed native-V8 instead; WASM Node is 10–50x slower + 30–50MB binary. Documented as the rejected alternative. |

## 3. Component ecosystem by lane (all allowlist-verified via API)

**VFS / storage (Week 1–2):**
- `streamich/memfs` — Apache-2.0, 2.1k★, 13M weekly downloads. In-memory POSIX `fs`; the single most important VFS reference.
- `zen-fs/core` — MIT. Pluggable POSIX `fs` in TS with in-memory, OPFS (`@zenfs/dom`), and IndexedDB backends — maps 1:1 onto our Phase 2 persistence plan.
- `isomorphic-git/lightning-fs` — MIT. IndexedDB-backed POSIX-like `fs.promises`.
- `filerjs/filer` — BSD-2-Clause. Node `fs` over IndexedDB (stale since 2023).
- `rxliuli/opfs-tools` / `hughfenghen/opfs-tools` — MIT. OPFS wrappers for Phase 2.

**npm flow (Week 3) — directly targets our known hazards:**
- `npm/node-semver` — ISC. The full semver grammar parser (`>= 2.1.2 < 3`, `=x.y.z` pins — hazard #1). `semver-es` bundles it for browsers; pure JS, no native deps.
- `npm/pacote` + `npm/npm-registry-fetch` — ISC. Official registry client + package fetcher.
- `mafintosh/tar-stream` — MIT. Streaming tar parser.
- `101arrowz/fflate` — MIT. ~8KB gzip/tar extraction in browser.
- `DecompressionStream` — web standard, zero bytes: native gzip/gunzip streaming.
- Anti-reference: `lukeed/semiver` (MIT, 153 bytes) lacks range grammar — exactly the class of shortcut that produced hazard #1. Use node-semver semantics, not a toy comparator.

**Engines (context; we use native V8 per ADR-0002):**
- `justjake/quickjs-emscripten` (MIT), `quickjs-ng` (MIT), `bytecodealliance/javy` (Apache-2.0), `ArtifexSoftware/mujs` (ISC), `boa-dev/boa` (MIT), `jerryscript` (Apache-2.0), Moddable XS (Apache-2.0). All allowlisted if the expert ever revisits the engine decision; ADR-0002 currently rejects WASM engines on perf grounds.

**Network / terminal:**
- `mswjs/msw` — MIT, 18.3k★. Service-worker request interception; the reference for ADR-0002 #5's `/preview/<port>/` routing.
- `xtermjs/xterm.js` — MIT, 21.3k★. PTY bridge frontend.

## 4. Our four audited hazards → reference answers

1. **Semver range grammar** (`>= 2.1.2 < 3`, `=x.y.z`) → `npm/node-semver` (ISC) is the normative implementation; test our resolver against its range grammar.
2. **npm lifecycle scripts never run** → decision needed from expert: which lifecycle scripts to support and in what sandbox (none in Phase 1 — document as UNSUPPORTED_BY_DESIGN).
3. **Vite's URL-protocol dynamic imports** (`Unsupported URL protocol: http:`) → module resolution must treat `http:`/`https:` URLs in `import` as a first-class case (Node 20 semantics), not error out.
4. **Worker VFS one-way sync** → structurally solved by ADR-0002 #6 (single-owner VFS in the worker; main thread never touches it).

## 5. Sources

- GitHub REST API queries (35), license fields fetched per-repo; LICENSE files read directly for Nodebox (Sustainable Use), Nodepod (Commons Clause), BrowserPod (proprietary).
- StackBlitz engineering blog (WebContainers intro, 2021; API, 2023); Together AI × CodeSandbox acquisition post (Dec 2024); Scelar Nodepod blog + HN threads (WebContainers, NodePod, WebVM).
- Agent A report: `research/agent-a-web-landscape.md` · Agent B report: `research/agent-b-components.md` · GitHub mining: `research/webcontainer-landscape-github.md`.
