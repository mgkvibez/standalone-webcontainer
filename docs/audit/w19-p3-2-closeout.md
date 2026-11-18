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

The answer is no to all three. This note records why, so the question is not reopened from memory.

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
not own properties of the global.** Own-property deletion, which is what P3-1 does, cannot reach them at all. `onmessage`,
`postMessage` and `close` are own accessor properties on the global (measured `accessor`, `configurable: true`), and
`importScripts` is inherited.

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

- **CORS is not an outbound firewall.** CORS governs whether JavaScript may *read* a cross-origin response. A request can
  still be sent to an endpoint that answers without CORS headers; the response is unreadable, the request is not
  prevented.
- **`connect-src` CSP is the relevant policy control** for restricting where connections may go, and it is a thing to
  investigate, not something this phase configured or tested.
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
shadow this project could apply. The Process Worker remains hardened by P3-1 against own-property ambient capabilities,
and it remains **not a sandbox**: ADR-0019 says so in those words and this phase does not change that.
