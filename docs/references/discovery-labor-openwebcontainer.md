# Discovery pass: labor and OpenWebContainer

**Date:** 2026-11-03. **Method:** shallow clones of both repositories, mechanism-level grep, then
targeted reads of the files that own each mechanism (7,712 lines of TypeScript in
`thecodacus/OpenWebContainer`, 17 files in `yisar/labor`), plus both issue trackers and the
authors' other repositories. **Licences:** MIT and Apache-2.0 respectively, so both sit inside the
charter allowlist. **Status:** reference only. No code was copied, neither project is a dependency,
and nothing here authorises implementation without expert review.

This note records what they solved, what they only appear to have solved, and the two problems
neither of them solved at all.

## 1. Both escaped native V8. We did not.

This is the finding that reframes the other two.

`OpenWebContainer` does not execute user code on the page's JavaScript engine. It runs it inside
**QuickJS compiled to WebAssembly** (`quickjs-emscripten`), driving a hand-written module loader
through host functions. `labor` runs a **Go program compiled to WASM** (`syscall/js`) and evals
user source inside that.

So both reference implementations chose to own their execution engine, and StackBlitz's engine is
WASM-based too. ADR-0001 chose the opposite: JavaScript-shimmed Node APIs on the page's own V8,
explicitly not a WASI or foreign-runtime binary.

That choice is defensible and this pass does not reopen it, but it has a cost worth naming: an
engine you own hands you a synchronous `require`, a private global object, and host functions for
free. On native V8 we must supply all three ourselves, which is precisely what the CommonJS loader
and the sync VFS seam in ADR-0004 already are. The work is not duplicated by our choice; it is
relocated into our own code where it can be tested.

Consequence for estimation: a reference project's line count is not a measure of our remaining
work, because roughly a third of theirs is glue for an engine we are not using.

## 2. How a browser serves an Express-shaped handler

`OpenWebContainer` fakes `net` and `http` inside its engine, then bridges messages. Conceptually:

- A registry keyed `<type>:<port>` refuses a second server on the same port.
- `createServer(handler)` plus `listen(port)` registers the port and fires a callback outward.
- An inbound request arrives as a message carrying method, path, headers, port and body.
- The response is captured out-of-band: the status is set as a property, `writeHead(status,
  headers)` records headers, and `write` events accumulate chunks.
- A status-code-to-reason-phrase table reconstructs what Node would have sent.

What this proves is that the pattern works: a message-shaped request in, a captured response out,
with a port registry providing the routing identity. That is the design our `http` shim will need,
and ADR-0002 #5's `/preview/<port>/` scope is the same idea expressed at the service-worker layer.

Where it is weaker than it looks: **bodies cross the boundary as JavaScript strings**, so a
response is not binary-safe, and the whole body is buffered before it is returned. No streaming, no
backpressure, no keep-alive, no upgrade handling.

## 3. Their module resolution is narrower than ours

Resolution in `tests`-free prose: relative specifiers are resolved by walking segments and
clamping nothing; absolute specifiers are normalised; a bare specifier becomes
`/node_modules/<name>`; then exactly two extensions are tried, `.js` and `.mjs`; anything else
throws "Module not found".

Absent: `package.json` `main`, `exports` and `imports` maps, directory index resolution, `.json`
and `.cjs` extension search, and any upward `node_modules` walk. `phase1`'s loader already covers
main, index, `.json` and `.cjs` with an upward walk, and ADR-0004 D-4 names `exports` maps as the
outstanding gap.

That inverts the intuitive reading of a ten-times-larger project: on CJS semantics our loader is
already ahead. It also predicts their fidelity ceiling more accurately than their README does.

## 4. No package manager exists in either project

Neither repository contains an `npm install`. What exists instead is a set of shell commands:
`curl`, `wget`, and `unzip`, where `unzip` fetches a tarball, inflates it with `fflate`
(`gunzip` with an `inflate` fallback), and then parses tar blocks by hand: a 512-byte header
carrying the name in the first 100 bytes, the mode as octal at offset 100, the size as octal at
offset 124, zero-blocks ending the archive.

So the package story in both projects is "download a URL and unpack it". No semver, no dependency
graph, no peer resolution, no integrity verification against the registry's hash.

This is the strongest external confirmation of the estimate in
`docs/research/ai-assisted-recreation-estimate.md`: tarball handling is routine, and the frontier
is resolution, which nobody in this lane has finished.

## 5. Neither has liveness discipline, and that is the real gap

`OpenWebContainer`'s interceptor keeps a correlation map from request id to a resolver function,
increments an id per request, forwards the request to the worker, and resolves when a matching
reply arrives. There is no deadline on any entry. If the worker is dead, wedged, or simply never
answers, the promise stays pending forever and the preview hangs with no error and no timeout.
Entries are deleted only on success.

`labor` forwards the fetch into the Go runtime and returns whatever response the handler produces,
with nothing measuring whether the runtime is alive.

Two independent projects, the same hole. A runtime that dies silently is indistinguishable from a
slow request, forever.

ADR-0003's early-ACK plus streamed keepalive plus liveness window is therefore not an optional
refinement on top of prior art; it is the difference between a demo and something a user can trust,
and it is the one place where our design is genuinely ahead of both references. Their correlation
map is still the right shape for the bookkeeping, but every entry must carry a deadline and a
reaper, which is the piece both omitted.

## 6. Two smaller findings with direct consequences

`labor` captures the response by reusing Go's `httptest.ResponseRecorder`. Elegant, and it means the
body is fully buffered; the guard on content length also means an empty-body 200 loses its body.

The ecosystem's ambition is visible in `OpenWebContainer` PR #10, "Full Node.js Support including
Native Modules, TCP, UDP, HTTP/2, HTTP/3 and arbitrary node modules": 1,900 files, +159,822 lines,
no description, unmerged. Native modules in the browser remain unsolved, and the attempt arrived as
an unreviewable dump. Our server-lane fallback for native modules is the honest answer, not a
retreat.

## 7. What we take, what we refuse, what we defer

| Concept | Verdict | Note |
|---|---|---|
| Port registry keyed by type and port | **take** | matches ADR-0002 #5 scoping |
| Message-shaped request in, captured response out | **take** | with `Uint8Array` bodies, not strings |
| Correlation map for in-flight requests | **take, extended** | every entry carries a deadline and is reaped |
| Capability-based executor seam (`canExecute`) | **take** | already planned for the process model |
| Shell command registry | **take, later** | needs the command surface first |
| Owning a WASM JS engine (QuickJS) | **refuse** | ADR-0001 ratified native V8 |
| iframe plus `postMessage` interception | **refuse** | ADR-0002 #5 ratified service worker |
| Delegating the VFS to a third-party FS | **refuse** | we own the VFS; ADR-0002 #1 |
| String-transported bodies | **refuse** | loses binary safety for free |
| Streaming and backpressure | **defer** | neither reference has it; state the limit |
| `npm install` proper | **defer** | nobody solved it; own milestone, not a side effect |

## 8. Questions this pass leaves for the expert

1. Given both references and the market leader use WASM engines, is native V8 still the intended
   bet, knowing we pay for the loader and the sync seam ourselves? ADR-0001 says yes; I am not
   reopening it, only recording that the cost is now measured rather than assumed.
2. Should the `http` shim be specified before the service worker, since the port registry is the
   contract between them?
3. Do we want streaming in Phase 1 at all, or is a documented full-buffer limit acceptable for the
   gate, given both references ship the limit?
4. Is `npm install` in the gate at all, or is it a post-gate milestone? Neither reference has it,
   and the estimate says it is the largest single unknown.
