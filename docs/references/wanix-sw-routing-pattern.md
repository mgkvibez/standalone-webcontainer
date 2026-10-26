# Wanix — Service Worker Routing Pattern (Clean Room Abstract)

**Source:** tractordev/wanix (Go + JS). **License:** MIT — usable, but per protocol treated conceptually.
**Studied:** service worker (`web/sw/wanix-sw.js`), IDBFS design doc (`web/idbfs/DESIGN.txt`), README task/namespace model.
**Informs:** our network lane (ADR-0002 #5: `/preview/<port>/` scope, MessageChannel relay, pull-based streams) and worker isolation (#2, #6). No decisions made here.

## The fetch flow, step by step

1. **Boot.** The kernel boots in the page context (in wanix's case, a
   WASM kernel; in ours, the runtime worker's controller). The kernel
   sends the service worker a registration message; from then on the SW
   holds a reference ("the listener") to the kernel's message port.

2. **Request.** The user's page (preview iframe) issues a normal
   `fetch` for a URL in the SW's scope. The browser dispatches the SW's
   fetch event.

3. **Cache check.** The SW first checks the Cache API; a hit returns
   immediately, kernel untouched. Static app-shell assets never pay
   the IPC round trip.

4. **Relay.** On a miss, the SW converts the request into a *plain
   serializable descriptor*: method, URL, flattened header map, host,
   hostname, pathname, port. It creates a **fresh MessageChannel per
   request** and posts {descriptor, reply-port} to the registered
   listener, *transferring* the reply port (no shared state, no port
   contention; request-scoped reply channel).

5. **Kernel routing.** The kernel inspects the descriptor (in their
   model: the port field selects which task's virtual network stack
   owns the request). The owning task — a user program running in its
   own dedicated worker — receives the request through the task's
   namespace.

6. **Reply.** The task's virtual HTTP server produces a response and
   returns it over the transferred port as a plain object (status,
   headers, body). The SW constructs a real `Response` from it, stores
   a clone in the Cache API, and fulfills `respondWith`.

7. **Bypass semantics — two escape hatches.**
   - The task replies with a sentinel ("not mine", status-100-style) →
     the SW falls through to the *real* network. Same-origin requests
     that no virtual server claims must still load the app itself.
   - The reply does not arrive within a timeout (~1s) → the SW assumes
     the kernel is gone, *deregisters the listener*, and falls through
     to the network. A dead kernel cannot wedge every future request.

## Concepts worth keeping, in concept form

- **The SW is a dumb, stateless relay.** All routing intelligence lives
  in the kernel/worker. SW logic stays reviewable, tiny, and disposable
  (browsers love to kill SWs).
- **Runtime handler registration.** The SW knows nothing at install
  time; the kernel registers at boot. A SW update never needs to know
  about ports or projects.
- **Per-request MessageChannel with transferred port.** No reply
  correlation table in the SW; no interleaving risk; request isolation
  for free.
- **Sentinel + timeout bypass.** Virtual servers *negatively
  acknowledge* unclaimed requests; failures degrade to the network
  instead of hanging the page.

## Worker isolation + namespace model (concept)

Each task (process) is a dedicated worker with **its own view of the
filesystem — a namespace assembled from "binds"**: tar layers, remote
fetches, inline files, union directories, virtual providers, even
remote namespaces imported over a 9P-like protocol. Isolation comes
from *namespace scoping* — two tasks see different trees of the same
kernel — rather than from copying state. Terminals, processes, VMs,
and browser APIs (`#web`) are themselves files in a namespace.

For our Runtime interface this suggests (expert decides): per-spawn
namespace views composed over the single-owner VFS (ADR-0002 #6) give
process-like isolation without VFS copies — a `Runtime` instance hands
each user program a scoped view, not a cloned tree.

## Persistence schema concept (IDBFS v2 — contrast with lifo's snapshots)

Two object stores: **metadata** (keyed by path; parent/type/compound
indexes so `readdir` is an indexed lookup, not a scan) and **data**
(for large files). Hybrid storage: small files (< 4 KB) inline with
metadata — one lookup for the common case; larger files separate so
metadata ops never load big blobs. LRU caches front both stores
(~1000 metadata entries, ~10 data entries). Directory rename updates
all descendants in one batch transaction. Data loads lazily on first
read/write through a file handle, written back on close if dirty.
Schema versions auto-migrate on open.

Contrast with lifo (whole-tree snapshots, see the lifo abstract): the
per-path model is incremental and index-friendly; the snapshot model is
atomic and simple. Our ADR-0003 choice should be made against this
axis with our `node_modules`-excluded tree sizes in mind.

## Relation to our four audited hazards

The per-request relay with bypass timeout is directly relevant to our
hazard #3 (build-tool fetch/import weirdness): requests the runtime
cannot honor must *fail over cleanly*, not hang. Worker-owned routing
with scope-based routing (our `/preview/<port>/`) is the lane the
ADR-0002 #5 decision already chose; this abstract documents how a
proven implementation composes it with Cache API + timeouts.
