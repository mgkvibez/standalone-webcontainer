# Prior art abstracts: labor and OpenWebContainer

**Date:** 2026-11-03 · **Method:** read upstream sources at concept level only. No code was copied
into this repository and none of these projects is a dependency.

**Why abstracts:** the project protocol requires reference material to be written as plain-English
summaries in `docs/references/` so the implementation is derived from concepts, not from someone
else's source. These notes are reference only and carry no authority over the ADRs.

**Licence verdicts** (both inside the charter allowlist, so either could legally be depended on,
which is a separate question from whether we should):

| Project | Upstream | Stars | Language | Licence | Last upstream push |
|---|---|---|---|---|---|
| labor | `yisar/labor` | 228 | Go compiled to WASM | Apache-2.0 | 2021-05-27 |
| OpenWebContainer | `thecodacus/OpenWebContainer` | 190 | TypeScript | MIT | 2025-08-20 |

---

## 1. labor — a Go runtime wearing a JavaScript hat

**The idea.** A JavaScript string is evaluated with the host functions injected as parameters:
`new Function('readFile', body)(readFile)`. Those functions are not implemented in JavaScript at
all. They cross into Go, whose standard library does the real work, and Go is compiled to WASM.
The service worker imports a generated glue file, registers a listener that forwards fetch events
into the Go HTTP handler, and lets anything the handler does not claim fall through to the network.

**What it genuinely proves.**
- The injected-parameter technique is enough to make ordinary-looking JavaScript call into a host
  runtime without a module system. This is the same shape as our CommonJS evaluation, where the
  parameter list *is* the shim surface.
- Service-worker routing plus a fall-through to the real network is a workable primitive. Our
  ADR-0003 refinement (early ACK, streamed keepalive, liveness window) exists because this design
  has a hole where liveness should be: labor has no timeout discipline at all, so a dead runtime
  looks like a slow request forever.
- A promise bridge between the JS side and the host side is unavoidable once calls cross the
  boundary, and it needs explicit resolve/reject plumbing on both sides.

**Why its lane is closed to us.** The charter's ratified architecture is JavaScript shims on the
browser's native V8, explicitly *not* a foreign-language runtime compiled to WASM. labor is the
opposite: Go owns the semantics and JavaScript is the surface. It also cannot listen on a port,
has no module resolution, no npm, and no persistence.

**Status risk.** Upstream stopped in 2021. Useful as a pattern, not as a maintained reference.

---

## 2. OpenWebContainer — the closest architectural relative we have

**The idea.** Three layers, and the boundary between the second and third is the interesting part:
a UI layer, a container-manager layer that speaks to a dedicated Web Worker, and the worker, which
owns the file system, a process manager, executors and a shell.

**Structure worth understanding.**
- **Executors are registered by capability, not by name.** Each executor answers whether it can run
  a given executable and then returns a process object. A registry holds them, so "node" and the
  shell are peers rather than special cases.
- **Processes are event-emitting objects with a pid, a parent pid and a lifecycle**, and the manager
  owns creation and bookkeeping.
- **The network is a dependency injected into executors**, and there is a fake `http` module on top
  of it. Applications believe they are doing HTTP; the runtime decides what actually happens.
- **The file system is delegated to a third-party abstraction** rather than owned outright.
- **Shell commands are registry entries** (curl, wget, unzip) rather than a parser with hardcoded
  branches.

**The divergence that matters most.** Its request interception is *not* a service worker. It routes
through an iframe and `postMessage`, correlating each in-flight request with a numeric id and a
handler map, keyed to a server port. That is a legitimate design, and it is not ours: ADR-0002 #5
mandates a service worker intercepting under `/preview/<port>/` and forwarding over
`MessageChannel`. An iframe-based approach works because it controls the document that renders the
app; it cannot intercept requests made by a page it does not own.

**What is worth taking anyway.**
1. **The request-id correlation map.** Any design that forwards requests to a runtime and awaits a
   reply needs a way to match replies to requests and to clean up when one dies. Our ACK/keepalive
   work needs exactly this bookkeeping, and doing it deliberately beats discovering it later.
2. **The capability-based executor seam.** `canExecute()` plus `execute()` is a clean way to keep
   "what can run" separate from "how it runs", and it gives the shell a natural place to plug in.
3. **Network as an injected dependency.** Executors should not reach for globals to talk to the
   outside world; it makes them testable without a browser.
4. **Registry entries for shell commands.** Extensible without editing a dispatch function.

**What we should not take.** The iframe interception model (contradicts a ratified decision), the
delegated file system (we own the VFS by design, and ownership is what lets us satisfy ADR-0002 #1
and #4), and any assumption that a "process" is an OS-level process.

---

## 3. Mapping to our decisions

| Concept | Our position | Verdict |
|---|---|---|
| Inject host APIs as call parameters | Already what our CommonJS evaluation does | adopt (confirmed) |
| Service worker routing with network fall-through | ADR-0002 #5, ADR-0003 | adopt, but with liveness (labor lacks it) |
| Request-id correlation for in-flight requests | Not yet built | adopt when the ACK/keepalive path lands |
| Capability-based executor registry | Phase 2 concern | consider, needs expert view |
| Network injected into executors rather than global | Consistent with our sandboxing instinct | adopt |
| Shell commands as registry entries | Later phase | consider |
| Go/WASM runtime lane | ADR-0001 forbids | reject |
| iframe + postMessage interception | ADR-0002 #5 mandates SW | reject |
| Delegated file system | VFS ownership is the point | reject |

---

## 4. Questions these raise for the expert

1. Should the runtime adopt a capability-based executor seam, or is a single module loader with a
   shell layered above it enough for Phase 1?
2. Both references treat "process" as a bookkeeping record. Ours has no process model at all yet:
   do we want pids and parent pids before the shell exists, or after?
3. labor's missing liveness discipline is the failure our ADR-0003 refinement already anticipates.
   Confirm the ACK/keepalive constants remain implementation tuning rather than a new decision.
