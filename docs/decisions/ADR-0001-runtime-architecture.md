# ADR-0001: Runtime architecture baseline

**Status:** Accepted (decided by the human expert in the project charter, 2026-10-23)
**Deciders:** Human expert (architect) via charter; recorded by the implementer.

## Context

This project builds a standalone, browser-native Node.js runtime from scratch.
The architecture below was decided by the human expert before any code was written.
It is recorded here so future contributors do not re-litigate it.

## Decision

- **Runtime:** JavaScript-shimmed Node.js APIs running on the browser's native V8.
  NOT a WASI-compiled Node.js binary — the browser's engine is faster and more
  memory-efficient than a WASM-compiled JS engine.
- **VFS:** In-memory POSIX-compliant file system with IndexedDB persistence for
  session continuity.
- **Networking:** Service worker intercepting fetch requests and routing them to
  the in-browser Node.js server.
- **Threading:** COOP/COEP headers required for SharedArrayBuffer.
- **Terminal:** xterm.js with a PTY bridge to the runtime's stdin/stdout/stderr.
- **Hybrid runtime:** Browser lane for zero-compute-cost previews; server sandbox
  fallback for native modules, Python, and heavy builds. Both behind a unified
  `Runtime` interface.

## Known hard problems ahead (from the almostnode reference audit, 2026-10-23)

almostnode is used as a reference only (no dependency, no fork). Its observed
failure modes are expected in any browser-native npm/Node implementation and are
kept as a pre-registered bug list:

1. Semver range resolution: fails on non-tilde ranges (`>= 2.1.2 < 3`) and exact
   pins (`=0.155.0`).
2. npm lifecycle scripts (postinstall) never execute.
3. Vite builds blocked by URL-protocol dynamic imports
   ("Unsupported URL protocol: http:").
4. Worker VFS sync is one-way (main -> worker); worker writes are invisible to
   the main thread.

## Consequences

- All remaining structural decisions (VFS data structure, service worker
  routing strategy, shim priority order) are open and require explicit expert
  approval before implementation.
- Every dependency must be MIT, Apache-2.0, BSD, or ISC.
