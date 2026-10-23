# standalone-webcontainer

A production-grade, standalone webcontainer: a browser-native Node.js runtime with its own
virtual file system, service worker network proxy, and terminal bridge. Built from scratch,
MIT-licensed, fully owned. Not a wrapper around any third-party proprietary runtime.

## Status

Pre-scaffold. The architecture is decided (see the charter below and
[ADR-0001](docs/decisions/ADR-0001-runtime-architecture.md)). Implementation of the VFS,
runtime, and service worker starts only after expert review of this scaffold.

## Layout

- `src/vfs/` — in-memory POSIX VFS with IndexedDB persistence (Week 1)
- `src/shims/` — JS-shimmed Node.js APIs on native V8 (Week 2)
- `src/runtime/` — unified `Runtime` interface: browser lane + server-sandbox fallback
- `src/network/` — service worker network proxy (Week 3)
- `src/terminal/` — xterm.js PTY bridge (Week 2)
- `tests/` — vitest unit + playwright browser tests; fresh temp dirs, hard timeouts
- `fixtures/` — compatibility harness fixtures
- `docs/decisions/` — ADRs

## Development

```
npm install        # dev deps only: typescript, vitest, @playwright/test
npm run typecheck
npm test
```

The charter below is the law for this project. Every commit references it.

---

# PROJECT CHARTER — STANDALONE WEBCONTAINER

## 1. MISSION

We are building a production-grade, standalone webcontainer — a browser-native Node.js runtime with its own virtual file system, service worker network proxy, and terminal bridge. This is NOT a wrapper around StackBlitz's WebContainers API. This is NOT a client library that depends on any third-party proprietary runtime. This is our own engine, built from scratch, MIT-licensed, and fully owned.

StackBlitz built theirs from scratch. We are doing the same.

## 2. HARD CONSTRAINTS — VIOLATIONS ARE BLOCKING

These are non-negotiable. If any commit violates these, stop and fix it before proceeding.

### Licensing
- EVERY dependency must be MIT, Apache-2.0, BSD, or ISC.
- NO StackBlitz WebContainers API.
- NO Nodebox.
- NO anything with "Commons Clause", "Sustainable Use License", "Business Source License", or any non-compete clause.
- NO almostnode if it turns out to be a wrapper around a proprietary runtime.
- If in doubt, ask before adding the dependency.

### Architecture (already decided — do not reinvent)
- Runtime: JavaScript-shimmed Node.js APIs running on the browser's native V8 engine. NOT a WASI-compiled Node.js binary. The browser's engine is faster and more memory-efficient than a WASM-compiled JS engine.
- VFS: In-memory POSIX-compliant file system with IndexedDB persistence for session continuity.
- Networking: Service worker that intercepts fetch requests and routes them to the in-browser Node.js server.
- Threading: Requires COOP/COEP headers for SharedArrayBuffer.
- Terminal: xterm.js with a PTY bridge to the runtime's stdin/stdout/stderr.
- Hybrid runtime: Browser lane for zero-compute-cost previews; server sandbox fallback for native modules, Python, and heavy builds. Both behind a unified `Runtime` interface.

### Quality
- No `any` types where avoidable.
- No skipped error handling — browser APIs fail in weird ways; every API call needs it.
- No untested code paths.
- No architectural decisions made by the agent without explicit approval from the human expert.

## 3. ROLES — KNOW YOUR LANE

### The Human Expert (architect)
Makes all architectural decisions. Reviews VFS design, service worker architecture, Node.js shim layer, npm compatibility strategy. Debugs browser-specific quirks. Profiles performance. Owns the "why" and the "how at the boundary".

### The Product Owner (you)
Reviews commits. Makes product decisions. Owns the "what" and the "when".

### The Agent (implementer)
The agent's job is high-volume, high-quality implementation of designs the expert has approved. The agent writes code, tests, fixtures, and documentation. The agent does NOT make architectural decisions. When the agent hits an ambiguous design choice, it STOPS and asks. It does not guess. It does not pick the path of least resistance.

### What the agent must NOT do
- Decide the VFS data structure without expert approval.
- Decide the service worker routing strategy without expert approval.
- Decide which Node.js APIs to shim first without expert approval.
- Skip tests because "it's just a prototype".
- Skip error handling because "it's an edge case".
- Add a dependency without verifying its license.
- Summarize away failures in reports.

## 4. WORKING RULES

1. **Commit small and often.** Each commit should be reviewable in under 5 minutes.
2. **Write the test before the implementation when possible.** When not possible, write the test in the same commit.
3. **Document decisions.** Every non-obvious choice gets a comment explaining WHY, not just WHAT.
4. **Isolate runs.** Every test fixture runs in a fresh temp directory. Never share state between fixtures.
5. **Hard timeouts everywhere.** Install: 180s. Build: 240s. Run/preview: 60s. Hanging processes produce TIMEOUT, not infinite waits.
6. **Normalize comparisons.** Strip temp-dir prefixes, sort, ignore lockfile timestamps and sourcemap hash noise.
7. **Classify failures honestly.** PASS | RUNTIME_INCOMPATIBILITY | HARNESS_BUG | NETWORK | TIMEOUT | INVALID_BASELINE | UNSUPPORTED_BY_DESIGN. A wrong API call in the harness is HARNESS_BUG, not a runtime failure. Fix it and re-run.
8. **Report raw evidence.** Every scored run produces logs, console output, error traces, and file manifests on disk. No summary without evidence.
9. **Ask before assuming.** If the spec is ambiguous, ask. A wrong assumption costs more than a question.
10. **Never redefine the gate after seeing bad results.** The 80-90% threshold is set before the run.

## 5. THE GATE (pre-registered, not adjustable)

### Lane gate
>=90% full pass on front-end-only fixtures (roughly 1-4, 7-14, 18-20) running in a shippable isolation mode (NOT dangerouslyAllowSameOrigin).

### Boundary map
Fixtures 5, 6, 15, 16, 17 (Next.js, SvelteKit, monorepo, large bundles, concurrent HMR) reported separately as server-lane candidates. Pass or fail is not the question — the question is whether they belong in the browser lane at all.

### Overall rate
Reported for reference, but not the sole kill criterion.

### Isolation vs. trusted mode
Report BOTH pass rates. Only the isolation-mode number can justify shipping user code in the browser. If isolation mode is not viable, say so plainly even if trusted mode scores 100%.

## 6. THE 4-WEEK PLAN (reference, not gospel)

**Week 1 — Foundation**
- VFS (in-memory, POSIX-compliant, sync + async, large-file safe)
- Service worker skeleton
- Test harness infrastructure
- Deliverable: Can write files to VFS and read them back

**Week 2 — Runtime Integration**
- Core Node.js API shims (fs, path, crypto, buffer, events, stream)
- VFS integration with runtime
- Terminal / PTY bridge
- Deliverable: Can run a simple Node.js script that reads/writes files

**Week 3 — Networking & Packages**
- Service worker network proxy (HTTP, ideally WebSockets)
- Basic npm install flow (registry fetch, extract to VFS, dependency resolution)
- Runtime integration
- Deliverable: Can run `npm install` and serve an HTTP response

**Week 4 — Testing & Hardening**
- 50+ test fixtures (simple to complex)
- Expert review of compatibility issues
- Bug fixes identified by expert
- Documentation
- Deliverable: Working prototype with known limitations documented

## 7. REALISTIC EXPECTATIONS AFTER 4 WEEKS

### Will work
- Simple Node.js scripts
- Basic Express servers
- Vite dev servers for simple apps
- Pure-JS npm packages

### Will not work (documented, not hidden)
- Native modules (no C++ compilation)
- Complex build tools (Webpack, complex Next.js configs)
- Large bundles hitting memory limits
- Edge cases in npm dependency resolution

This is a foundation, not a finished product. 60-70% of common use cases is the realistic target. The remaining 30-40% is another 3-6 months of work.

## 8. WHAT SUCCESS LOOKS LIKE

After 4 weeks, we should have delivered:
- A working prototype that handles simple cases
- A clear list of what works and what doesn't, with evidence
- A roadmap for the next 2-3 months of development
- Data to decide whether to invest in the remaining 30-40% OR pivot to server-first

Either outcome is valuable. The goal is data, not a finished product.
