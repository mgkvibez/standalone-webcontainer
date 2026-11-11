# Vite's update channel, measured: the preview cannot carry it

Nothing in the corpus ever opened a websocket, and the http shim said so in a comment: it implements request/response and keep-alive, "not
TLS/HTTP2 and not the `upgrade` event, which is why websockets in the browser lane are a later, separate problem". A comment about a whole
editing experience is worth a measurement.

Probe: `tools/probe-vite-hmr.ts`. It starts `vite dev` on the frozen snapshot, fetches the page and `/@vite/client`, then sends the handshake
through the same gateway path the browser uses.

```
dev process: running ports=3302
GET / -> 200, mentions /@vite/client: true
GET /@vite/client -> 200, 137820 bytes
  client hmr config: config injected
UPGRADE / -> 200 (a real dev server answers 101), 235 bytes
  answered like a plain GET: true
```

The comparison, measured on this machine with real Vite 7.3.7 and the identical headers: **`status=101`**. Ours: 200 and the HTML page.

## What that costs, from vite's own client

`dist/client/client.mjs:745` dials `ws://<host>:<port>/?token=…` with subprotocol `vite-hmr`. On failure with a known port the transport logs
`[vite] failed to connect to websocket` and **throws** (`:777`). The "server connection lost. Polling for restart…" path (`:865`) is reached
only by a socket that opened and then closed, which cannot happen when the handshake never opens. So the page renders and then stays exactly as
it was: no hot update, no error overlay, no reload on edit, until someone reloads by hand.

The page itself is fine, which is why every existing fixture passes: `/` is 200 with its script, `/@vite/client` is 200 with its config
injected, and modules transform and serve. Only the push channel is missing.

## Why this is architecture, not a bug to fix

The runtime is a Worker inside the page. The preview reaches it through a **Service Worker** intercepting `fetch` in an iframe on a separate
origin. A service worker's `fetch` event does not cover websocket handshakes by specification, and there is no network endpoint to dial around
it: the server does not exist outside the page. Implementing `upgrade` and WebSocket framing in the shim would let an in-runtime client talk to
an in-runtime server (a real Node-compatibility gap, since a project depending on `ws` cannot work today) but would not give the browser preview
live updates.

ADR-0024 records the decision: server push over the preview is out of scope, and "edit, then see it" is host-driven, because the editor is the
only writer of a project's files and therefore the only party that knows a change happened. `tests/unit/network.preview-gateway.test.ts` pins
the current behaviour so an upgrade implementation later meets the test and the ADR together.
