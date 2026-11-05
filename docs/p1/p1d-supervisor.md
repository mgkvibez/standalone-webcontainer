# P1d foundation: project Worker supervisor

Status: supervisor and generic transport foundation implemented; preview hosting remains deferred.

## What now persists between commands

The runtime Worker owns one active project's `FileSystem`, `InProcessRuntime`, HTTP port registry and preview gateway.
At each command boundary, the page sends the latest project snapshot and identity. The supervisor mirrors changed and
removed page-owned files into its VFS, keeps runtime-created files and installed dependencies for the life of that
project's Worker, and tears the runtime down when the active project changes. The page's `ProjectStore` remains the durable
source for authored project files; a Worker reset rebuilds runtime state from that store plus P1c's volatile dependency
overlay.

The supervisor tracks process IDs, entrypoints, state and the ports created by each entrypoint. A command that binds an
HTTP port remains visible as a running process after bootstrap returns. Killing that process closes its owned servers
without dropping the VFS. Killing a non-server process that is still executing retains the existing hard-stop behavior:
the Worker is discarded, which ends every process and server in it.

## Generic transport

The host can transfer a `MessagePort` to the Worker. It carries typed request/reply messages with an ID, method, path and
query, headers, status, and byte body. The supervisor has no origin, hostname, path-prefix, service-worker, iframe, or
registration assumptions. Its endpoint routes the request through the active runtime's gateway. This contract is intended
to let a future preview-origin adapter connect without baking today's host URL shape into the runtime.

## Not implemented in this slice

- No service-worker registration, preview shell, iframe, wildcard hostname or DNS/TLS configuration.
- No actual host-to-preview `postMessage` bootstrap; the current browser test attaches a `MessagePort` directly.
- No claim that the Worker is a security sandbox. Origin separation is required by [ADR-0017](../decisions/ADR-0017.md)
  before any browser preview is exposed.
- The runtime still has a single serialized execution lane and buffered HTTP responses. WebSockets, streaming responses,
  file watching and multiple Node process scheduling remain separate work.

## Verification

Unit tests prove that a project VFS persists across commands, servers stay routable through the generic transport, process
and port ownership is tracked, server stop preserves the project runtime, and a project switch drops the previous runtime.
A Chromium test runs the same lifecycle through the real Worker and transferred `MessagePort`. The full browser suite
passed 19 tests. Typecheck and production browser build passed. The full unit suite had 668 passing tests and four known
Windows/baseline failures documented in the previous P1c verification.
