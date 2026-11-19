# W-19 P3-2 closeout: prototype-owned capabilities

**Status:** closed 2026-11-18, no production implementation. **Predecessors:** P3-0 (`src/process/quarantine.ts`, PR #108),
P3-1 (ambient own-property removal, PR #109, `52cef28`). **Relates to:** ADR-0019 (the runtime origin), ADR-0033 (preview
sockets), register item W-19.

**Evidence scope.** Every browser measurement below was taken in **Chromium**, in this repository's browser lane, inside a
real Process Worker (module Worker, `src/process/process-host.ts:123`). No Firefox or WebKit measurement was made for this
note, and nothing here should be read as three-engine verification.

## What P3-2 asked

P3-1 deleted own, configurable properties from the Process Worker global. P3-2 asked whether the properties that remained
inherited from the prototype chain expose ambient capabilities, and whether shadowing them is safe, necessary or useful.

The three questions have different answers, and collapsing them is how a note starts lying:

- **Do inherited properties expose ambient capabilities? Yes.** `fetch`, `indexedDB`, `caches` and `crypto` are reachable
  and usable from this realm, measured below.
- **Is shadowing them a safe, necessary or effective security boundary? No.** A shadow is recovered by prototype
  traversal, and the recovered reference still works.
- **Is a production implementation recommended? No.** The reasoning and the measurement are recorded here so the question
  is not reopened from memory.

## The prototype chain, measured

| level | object | own props | capability-relevant |
| --- | --- | --- | --- |
| 0 | `DedicatedWorkerGlobalScope` (the global) | 347 | `postMessage`, `onmessage`, `onmessageerror`, `close`, `WebSocket`, `MessagePort`, `WebAssembly`, `Atomics`, `SharedArrayBuffer` |
| 1 | `DedicatedWorkerGlobalScope.prototype` | 3 | none of the probed set |
| 2 | `WorkerGlobalScope.prototype` | 30 | **`fetch`, `importScripts`, `indexedDB`, `caches`, `crypto`, `setTimeout`, `setInterval`, `queueMicrotask`, `location`, `navigator`, `origin`, `structuredClone`, `reportError`, `performance`** |
| 3 | `EventTarget.prototype` | 5 | `addEventListener`, `removeEventListener`, `dispatchEvent` |
| 4 | `Object.prototype` | 12 | none |
| 5 | `null` | - | terminal |

The distinction that decides the phase: **`fetch`, `indexedDB` and `caches` are inherited from `WorkerGlobalScope.prototype`,
not own properties of the global.** Own-property deletion, which is what P3-1 does, cannot reach them at all.

The Worker-scope members are the opposite case, and their measured shape matters for the reason each is preserved:
`onmessage` and `onmessageerror` are own **accessor** properties on the global with a setter, `postMessage` and `close` are
own **data** properties, and all four are `configurable: true`. None of them lives on `DedicatedWorkerGlobalScope.prototype`.
So P3-1 could have deleted them. It did not, and the reason is per property rather than one blanket claim:

- **`postMessage`**: the ordinary channel is untrusted by construction. The host ignores everything except the first
  `start`, so a program posting here reaches a listener that discards it. Deleting the property would remove a channel
  that already carries nothing the kernel believes.
- **`onmessage`**: the bootstrap consumed its `start`, and inside that handler the setter was invoked with `null`, before
  the control port was installed and before user code ran. After that point the property is inert: a program that
  reassigns it hears nothing, because the host sends nothing further on this channel. The disable is already complete by
  the time P3-1 runs, so deleting the property neither preserves nor destroys it.
- **`onmessageerror`**: it fires for a deserialisation failure on a `message` event from this channel, and no such event
  arrives after bootstrap, so no consumer remains that the kernel trusts. This one is reasoning from the channel's
  post-bootstrap state rather than a measured firing, and it is the weakest of the four.
- **`close`**: not a harmless no-op. Three parts, kept apart.

  **Operation.** `close()` terminates the calling program's own Worker. It is not a route into another process, and
  deleting the property would stop a program terminating itself.

  **Consequence.** The consequence is not confined to that Worker. The current host/kernel lifecycle does not observe or
  settle the termination, and nothing else reports it. `close()` sends no trusted `exit`; `ProcessHost` reacts to
  `worker.onerror` and to trusted control messages, and `DedicatedWorkerGlobalScope.close()` fires neither;
  `ProcessKernel.#serve`'s `catch`/`finally` closes the channel but does not transition the process table; and the default
  process timeout is `0`, so nothing bounds the wait. Measured in Chromium: a program that prints, calls `close()`, then
  queues a timer prints nothing further (the Worker really is gone) while `isAlive(pid)` still returns `true` 8.8 s later
  and `settled(pid)` is still pending. So the process stays counted as live, its caller stays pending indefinitely, and
  it keeps occupying a slot in a process table whose limit counts live processes (`process-table.ts`, `maxProcesses`,
  default 8), capacity unavailable to later runs until the stranded process is explicitly killed or the owning kernel is
  restarted. `kill()` can release the slot because the process is still `running`; what no later run can do is reclaim it
  automatically.

  **Decision.** P3-2 does not implement a lifecycle fix, and does not make a product-policy decision about whether
  programs should keep this operation. What it records is the unresolved consequence. Closing it means observing Worker
  termination and settling the process on it, which is a lifecycle decision outside this phase and is not implemented
  here. Preservation is not justified here by any claim that the effects stay inside the program, because the measurement
  shows they do not.

`importScripts` is the genuinely inherited one.

## Inherited capabilities, and whether they are usable

Reachability is not usability. Both columns below were measured; the expressions are the reproducible form.

| property | usable | expression | note |
| --- | --- | --- | --- |
| `fetch` | **yes, 200** | `globalThis.fetch(location.origin + '/')` | the browser's own fetch (`toString` shows `[native code]`) |
| `crypto.subtle` | yes | `crypto.subtle.digest('SHA-256', new Uint8Array([1,2,3]))` returns 32 bytes | runtime dependency |
| `indexedDB` | yes | `indexedDB.open('probe', 1)` succeeds | storage |
| `caches` | yes | `caches.open('probe')` returns a `Cache` | storage |
| `importScripts` | **no** | throws "Module scripts don't support importScripts()" | reachable, unusable here |
| `setTimeout` / `setInterval` / `queueMicrotask` | yes | - | runtime dependency (scheduler) |
| `addEventListener` | yes | - | ordinary channel only, blinded by P2 |
| `postMessage` / `onmessage` | channel untrusted | - | P2 clears `scope.onmessage` at bootstrap |
| `WebAssembly` | yes | `new WebAssembly.Module(...)` | own property, preserved by P3-1 |

## Why shadowing is not a mitigation

A shadow was applied to a probe program only (no product change): an own, non-configurable, non-writable `fetch:
undefined` on the global.

- `typeof globalThis.fetch` and the bare `typeof fetch` both became `"undefined"`.
- `Object.getPrototypeOf(globalThis).fetch`, `globalThis.__proto__.fetch` and `Reflect.getPrototypeOf(globalThis).fetch`
  all still returned the function.
- Calling the recovered reference returned **200**.

Shadowing obstructs an ordinary lookup. It does not remove the capability, and the recovered reference is fully
functional. The same shape applies to the accessor-owned names (`indexedDB`, `caches`), where reading off the prototype
throws `Illegal invocation` because the getter requires the global as receiver, which is a speed bump rather than a
boundary.

Modifying `WorkerGlobalScope.prototype` itself is rejected: it is a browser-owned prototype, it changes platform
semantics, and it is engine-fragile.

## Network: what removing XHR did and did not do

P3-1 removed `XMLHttpRequest`. It did not remove native `fetch`, and it did not create network isolation. A program in
this realm has the browser's own `fetch`, subject to the browser's own rules.

Two corrections worth keeping:

- **CORS is not an outbound firewall.** CORS governs whether JavaScript may *read* a cross-origin response. What happens
  to the request itself depends on its shape. A simple request can reach the server even when the response is unreadable
  to JavaScript, because CORS withholds the response rather than the request. A request that triggers a preflight can be
  stopped before it is ever sent, because a failed preflight fails the fetch. Neither behaviour is a general outbound
  network firewall: requests the browser considers simple are not gated on the target agreeing to anything.
- **`connect-src` CSP is the relevant policy control** for restricting where connections may go, from the Worker
  execution context that actually runs the code. It is a thing to investigate, not something this phase configured or
  tested.
- **A parent page's CSP does not automatically govern a Worker.** Whether a policy applies to a given Worker depends on
  the Worker's own response headers and the deployment arrangement, and the effective policy must be verified for the
  actual execution context. That verification has not been done.

The intended boundary remains ADR-0019: a dedicated execution origin plus an appropriately enforced egress policy. This
phase did not design, configure, test or deploy any of that.

## Storage: an open architectural question, not a bug

`indexedDB` and Cache Storage (`caches`) remain usable in the Process Worker. They are inherited, so P3-1 could not have
removed them, and P3-2 does not remove, wrap or shadow them.

- A dedicated execution origin (ADR-0019) separates these stores from the application origin.
- Projects that share the same execution origin may therefore share that origin's storage boundary.
- Whether **project-level** storage isolation is required is a separate architectural decision, and it is not answered
  here.

## What must not change

The private kernel-control `MessagePort`, P2's ordinary-channel blinding, `WebSocket` reachability through the curated
facade (ADR-0033), `postMessage`/`onmessage` handling, the P3-0 capture set in `src/process/quarantine.ts`, and the P3-1
removals. None of them is affected by this note, and none of them should be revisited to "fix" what is described above.

## Verdict

**No production implementation. P3-2 is closed with documented limitations.** Nothing prototype-owned is both safely
removable and materially harmful, and the one significant capability (native `fetch`) is measurably recoverable after any
shadow this project could apply. One finding is left open on purpose: `close()` terminates the calling program's Worker
without a trusted `exit`, and the kernel is measured to keep that process counted as live, its caller pending, and its
process-table slot occupied. That is a lifecycle gap to decide separately, and this note does not use it to justify
preservation. The Process Worker remains hardened by P3-1 against own-property ambient capabilities,
and it remains **not a sandbox**: ADR-0019 says so in those words and this phase does not change that.
