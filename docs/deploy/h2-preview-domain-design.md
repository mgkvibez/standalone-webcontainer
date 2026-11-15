# Preview domain topology: one registrable domain or two

Status: **H2 design investigation. No implementation.** Nothing was bought, configured or deployed. The preview tier is
**not** claimed to be sandboxed here, and this document does not say so anywhere: the isolation described is what browsers
enforce between origins and sites, plus what ADR-0019 specifies and W-19 still owes.

Scope: compare the two approved candidate topologies for the preview tier and recommend one. The Worker itself is H2's
next step and is not written yet.

**Revision, 2026-11-15, third pass (manager review).** The cookie boundary is now split into its two real mechanisms and
its two non-capabilities: the edge Worker *removes* headers (`Cookie` in, `Set-Cookie` out), the preview Service Worker
cannot (measured: the header is not exposed, deleting it still sends the cookie) and instead uses `credentials: "omit"` on
the fetches it performs, with contract tests proving the observable behaviour; neither protects navigations or requests that
bypass the service worker; the jar absolute is replaced by the enforceable rule that no engine-owned endpoint may issue,
consume or trust a cookie; and the shared parent-domain cookie channel stays on the page as an explicit residual risk.
Nothing implemented.

**Revision, 2026-11-15, second pass (manager review).** §8 extended with a measured cookie-scope investigation: separate
origins do **not** isolate cookies, a preview can write a parent-domain cookie for the engine site and every other project
reads it, and the Worker plus the preview service worker must strip `Cookie` inbound and `Set-Cookie` outbound while the
design still never trusts a cookie. The engine-site rule gains the cookie clause. Nothing implemented.

**Revision, 2026-11-15 (manager review).** Three documentation corrections: the runtime placement contradiction is gone
(the runtime and previews are on the engine site, each on its own origin, recorded as decided rather than open, with the
engine-site rule stated); the `SameSite=None` note now says such a cookie is *eligible* for cross-site requests subject to
the browser's third-party-cookie policy and that policy is explicitly not a security control; nothing else changed. W-15,
W-19 and W-20 remain open and no runtime behaviour is claimed or changed.

**Revision, 2026-11-14 (owner review).** Topology B is accepted. Two corrections applied to this document, both of which
tighter wording would have avoided the first time: the `*.localhost` Chromium lane is no longer described as evidence of
third-party service-worker behaviour (§3 now separates what that lane proves from what it does not), and §2 now states
exactly which attacks B removes and which it leaves in place.

## The two designs

Both designs keep the shapes the code already requires: the editor is one origin, the runtime is another (ADR-0019), and
every project's preview is its own origin at `<previewId>.<previewBase>` where the id is 128 bits of lowercase hex
(`src/browser/preview-origin.ts:1`, `:33`).

**A — one registrable domain.**

```text
app.example.com                  editor            (Cloudflare Pages)
runtime.example.com              runtime frame     (ADR-0019)
{id}.preview.example.com         project preview   (Worker route *.preview.example.com/*)
```

**B — two registrable domains.**

```text
app.example.com                  editor            (Cloudflare Pages)
{id}.example-preview.com         project preview   (Worker route *.example-preview.com/*)
runtime.example-preview.com      runtime frame     (ADR-0019)
```

B is the shape ADR-0019's consequences already gesture at ("three origin families … a wildcard DNS requirement and a
wildcard TLS requirement"), with the runtime and previews moving to the engine domain because both execute user code and
neither holds the editor's credentials.

## Recommendation

**Adopt B, and adopt it now as the hostname topology even though nothing is purchased yet.** Buy one second registrable
domain when H2 reaches staging; do not buy two new domains, and do not start with A.

The reason is not that A is insecure today. Today there are no cookies (`grep` for `document.cookie` and `Set-Cookie`
across `src/` and `public/` returns nothing) and the editor's state is `localStorage` keyed by project
(`src/browser/projects.ts:8`), which is origin-scoped and therefore already separate from every preview origin in both
designs. The reason is that **the moment the editor gains a session, A's boundary stops being a boundary**: a cookie on
`app.example.com` is same-site with `{id}.preview.example.com`, and browsers attach same-site cookies to requests that
previewed user code initiates. B moves that decision out of our code and into the browser, and it is cheap to do now and
expensive to retrofit later (a hostname change after launch means every stored project, every shared preview URL and every
deployment target moves).

**Decided with this revision (owner, 2026-11-15): the runtime and the previews both live on the engine site, each on its own
origin.** `runtime.example-preview.com` serves the runtime frame and `{id}.example-preview.com` serves one preview each; both
execute user code, so both belong on the engine site, and being same-site with each other is acceptable only because
neither holds anything the editor owns. The engine site **must contain no editor credentials, no editor cookies and no
editor storage**; the editor's session, its `localStorage` project store and anything it ever gains stay on the app
registrable domain. "Decisions" below records it with the reasoning.

What is still *not* decided: the second domain's name, and the ACM-versus-flat-naming trade in A. Those are the owner's.

## What the preview architecture actually rests on

Before comparing designs it is worth stating what is load-bearing, because both designs must keep all of it.

- **One origin per project.** The preview id is validated as 32 hex characters and the resolved origin is rejected if it
  equals the editor origin (`src/browser/preview-origin.ts:33`, and `src/browser/preview-handshake.ts:24` refuses the same case from the caller's side). HTTP is refused outside `localhost` (`src/browser/preview-origin.ts:28`, so production previews are `https` only).
- **The editor embeds that origin in an iframe and speaks to it over a `MessageChannel`.** The handshake mints a fresh
  `crypto.randomUUID()` nonce per connection, sets it on the iframe URL along with the expected port and the editor's own
  origin, and accepts a reply only when `event.origin`, `event.source === frame.contentWindow` and the nonce all match
  (`src/browser/preview-handshake.ts:27-55`).
- **The preview shell owns a service worker with scope `/` on the preview origin**
  (`src/browser/preview-shell.ts:37`), and that worker is the only thing that can answer `/preview/<port>/…`, because the
  dev server lives inside the reader's browser, not at the edge (`public/preview-sw.js:38-59`).
- **Isolation headers on the preview origin**, COOP `same-origin` + COEP `require-corp` on documents, CORP `cross-origin`
  on every synthesised response. That is what makes the nested frame survive inside an isolated editor, and it was found
  the hard way: without it the frame is `net::ERR_BLOCKED_BY_RESPONSE` with an empty body and nothing naming the cause.

Three of those four are origin properties. The fourth, the nonce, is a session capability that assumes the origin
boundary already holds (below).

## 1. Same-origin, same-site and cookie isolation

A *site* is a registrable domain: an entry in the Public Suffix List plus one label. `mozilla.org` is a site, so
`support.mozilla.org` and `developer.mozilla.org` are the same site. Same-origin is stricter: scheme, host and port must
all match.

| | A | B |
| --- | --- | --- |
| Editor → preview | cross-origin, **same-site** | cross-origin, **cross-site** |
| Editor → runtime | cross-origin, same-site | cross-origin, cross-site |
| Preview ↔ preview (different projects) | cross-origin, same-site | cross-origin, cross-site |
| `crossOriginIsolated` | origin-scoped, unaffected by site | same |

`crossOriginIsolated`, `SharedArrayBuffer`, `Atomics` and the syscall channel are **origin** properties, so both designs
are equally able to boot the runtime. Nothing in the isolation work of ADR-0018/0019 changes with this decision. That is
the single most important thing to state plainly, because it is the natural worry and it is not the risk.

The site boundary governs cookies, `document.domain`-era assumptions, and third-party storage partitioning. It does not
govern the isolation headers.

## 2. Domain-scoped cookies and credential leakage

This is the reason to prefer B, and the reasoning has one non-obvious step that is worth spelling out because the obvious
defence does not work.

Consider a future editor session cookie on `app.example.com` and user code running at `{id}.preview.example.com` (A).

- A cookie set with `Domain=.example.com` is sent to every subdomain. In A that includes every preview origin.
- A host-only cookie (no `Domain` attribute) is sent only to `app.example.com`. It is **still sent** when a request
  *from* a preview origin *to* `app.example.com` is made, because `SameSite` compares the request's site with the
  cookie's site, and in A both are `example.com`. An iframe from the same site as its top-level document is not a
  third-party context, so `SameSite=Strict` does not stop it and no third-party-cookie policy applies.
- `__Host-` prefixes do not help. `__Host-` guarantees the cookie is host-only, `Secure`, `Path=/` — it prevents a
  *subdomain from overwriting or shadowing* the editor's cookie. It does not prevent `app.example.com` from receiving it
  on a request initiated by same-site preview code.
- So previewed user code could make credentialed calls to the editor's API and read nothing, but *do* things: a
  same-site POST with the session cookie attached is a CSRF primitive that no `SameSite` setting removes, because the
  attacker is already inside the site. `HttpOnly` protects the token from `document.cookie`; it does not protect the
  endpoints.

Under B the same request is cross-site. `SameSite=Lax` cookies are not attached to cross-site subresource requests, and
`SameSite=Strict` cookies are not attached at all. Chrome's third-party cookie work and Firefox's Total Cookie Protection
add a second wall. The browser drops the ambient credential before the request leaves, so the familiar CSRF primitive
above does not exist, and that holds without us having to enumerate every endpoint.

**What B does, stated exactly:** it puts the editor on a different *site* from the engine (runtime and previews), so the
editor's session cookie stops being an ambient credential that a same-site preview can borrow. That is the whole of the
guarantee, and it is worth having because it is enforced by the browser rather than by our code.

**What B does not do:**

- **It does not block cross-site requests.** Preview code can still send requests anywhere; the browser only refuses to
  attach credentials the cookie policy does not allow. Every request still arrives at whatever it addresses.
- **It does not defeat a deliberately cross-site cookie.** A cookie set with `SameSite=None; Secure` is **eligible** to be
  sent on cross-site subresource requests; whether it actually is depends on the browser's third-party-cookie policy, the
  user's settings and the current state of each engine's phase-out, all of which differ and all of which change. So if the
  editor ever sets one (an embed-friendly analytics or SSO cookie, say), it may be exposed to preview code in B much as it
  would be in A. **Third-party-cookie policy is a mitigation, not a security control**: it is user- and browser-controlled,
  uneven across engines, and not something to rely on for an authenticated cookie. The rule that keeps B's guarantee is
  "the editor sets no `SameSite=None` cookie for any authenticated purpose", and it needs to be written where cookies are
  introduced.
- **It does not cover unauthenticated actions.** An endpoint that accepts a write without a credential is equally
  writable from a preview in either design.
- **It does not stop a request being sent to an authenticated endpoint either.** CORS is a response-side control: it
  decides whether the caller may *read* the response, not whether the request is made. A credentialed request the browser
  does attach in some future configuration has still happened.
- **It says nothing about cookies *inside* the engine site.** Previews share a registrable domain, so previewed code can
  write a parent-domain cookie that every other preview origin reads (§8, measured). B separates the editor from that
  namespace; it does not make the namespace private.
- **It is not a sandbox.** Nothing in this document should be read as one.

So endpoint authorisation, server-side CSRF protection (a token bound to the session, and `Origin` / `Sec-Fetch-Site`
checks on state-changing requests) and a review of every cookie's `SameSite` value are required in both designs, and are
strictly more important than the topology. B removes one class of ambient-credential attack; it does not remove the
need for the controls.

One further qualifier on timing: **this is a future risk, not a present one.** There is no session cookie today, so A is
not currently exploitable through this path. The cost of A is paid the day authentication is added, at which point the
hostname is already public.

## 3. localStorage, IndexedDB and service-worker isolation

Both designs already put each project on its own origin, and storage is origin-keyed, so **the two designs are equal for
project isolation**. The site dimension changes something else: partitioning in a third-party context.

| Storage | A (same-site iframe) | B (cross-site iframe) |
| --- | --- | --- |
| `localStorage` / `IndexedDB` | unpartitioned; same store as a direct visit to the preview origin | partitioned by top-level site (Chrome 115+, Firefox TCP, Safari ITP) |
| Cache storage | same | partitioned with the same key |
| Service worker registration | not a third-party context; unaffected | a third-party registration, partitioned, subject to the browser's third-party storage rules |
| Editor's project store | separate origin in both designs | separate origin in both designs |

Consequences worth knowing:

- In B, a previewed app that uses `localStorage` sees a *different* store when embedded in the editor than when the same
  preview host is opened directly. Previews are ephemeral, so this is a curiosity rather than a defect, but a fixture that
  asserts persistence across a reload must not assume the two contexts share state.
- Safari caps script-writable storage, service-worker registrations included, at seven days of Safari use without
  interaction with the site as a first party (WebKit's full third-party cookie blocking announcement). Again: previews are
  ephemeral.
- **The service worker is the one place where B carries genuine technical risk, not just a nuance.** The preview shell
  registers a worker *from inside a third-party frame*. In A that frame is same-site, so it is not a third-party context
  and the registration is ordinary. In B it is third-party, and browsers treat third-party registrations differently:
  Chrome partitions them (documented, and the Service Worker API is listed among the partitioned APIs), while Safari's
  handling is the strictest in the market. If a browser refuses the registration, the preview shell has no router at all
  and previews do not work there.

  The existing browser lane is often described as if it settled this. It does not, and the distinction matters:

  - **What the lane proves.** In Chromium, over `http://` on `*.localhost`, against the Vite dev server: a preview shell
    on a host that is a **distinct origin** from the editor registers `/preview-sw.js`, that worker takes control of its
    scope, serves `/preview/<port>/…` through the runtime transport, and the resulting document renders in an iframe
    embedded from the editor origin with `crossOriginIsolated === true` and `SharedArrayBuffer` present. It also proves
    the nested-COEP lesson: a document served into a cross-origin-isolated embedder must carry COOP and COEP itself, or
    the frame renders empty with `net::ERR_BLOCKED_BY_RESPONSE`.
  - **What the lane does not prove.** That the registration is a **third-party** one. Whether Chromium classifies
    `<id>.preview.localhost` as a different *site* from `localhost` was never established and cannot be read off the
    suite: `localhost` appears nowhere in the Public Suffix List (checked against today's list), browsers special-case
    loopback names in their cookie and storage code, and what the suite asserts is an **origin** check (`event.origin`,
    `crossOriginIsolated`, the document that was served), not which site the browser believes the frame belongs to. Nor
    does the lane prove anything in Firefox or WebKit, a Worker-served response rather than a Vite one, real TLS,
    partitioning of the preview's storage, or wildcard routing.

  So the lane is evidence that the **architecture** works in one browser in a development topology. It is not evidence
  for the cross-site claim, and it must not be cited as if it were. The three-browser, two-registrable-domain matrix in
  "Before B ships" is therefore a gate on B, not a formality.

That makes the browser matrix a **gate on B**, not a formality. See "Before B ships".

## 4. COOP, COEP, CORP and iframe embedding

These are origin and response properties and are identical in both designs:

- The editor sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; the preview
  origin must send the same on documents, plus `Cross-Origin-Resource-Policy: cross-origin` on everything the editor or a
  previewed page loads across origins.
- Being embedded does not require a `frame-ancestors` allowance from the preview origin, and no `X-Frame-Options` may be
  sent by either side. `tests/unit/deployment.contract.test.ts:86,220` already forbids both, and H1's Pages header file
  contains neither.
- COOP `same-origin` on the preview document is required for the preview to be isolated itself; it does not block the
  `postMessage` handshake, because the handshake is `window.parent.postMessage` across origins, not same-origin script
  access.
- `credentialless` remains refused on both sides (Chromium-only; the dev-server test says so), and that choice is
  independent of this decision.

The one site-dependent subtlety is Chrome's **ancestor bit**. In B, a preview document is cross-site relative to its
top-level editor, so its storage partition is keyed with the ancestor bit set even if an intermediate frame were same-site.
In A no ancestor bit is set and the preview's storage is the same as a first-party visit. This is a partitioning
difference, not an isolation difference.

**Neither design needs different headers.** If a future proposal claims A is simpler for isolation, that claim is wrong.

## 5. Preview URL nonce handling and W-15

Read against the code, with the Worker still unwritten:

- The nonce is minted by the editor per connection, minimum 16 characters enforced by the shell
  (`src/browser/preview-shell.ts:13`), carried in the shell URL as `__preview_nonce`, and validated on both the
  `preview-ready` and `preview-connect` messages against `event.origin` and `event.source`.
- The service worker uses the nonce as a **routing gate**: it takes the port from the request path or from the client URL,
  requires a nonce, then requires a *live window client on this origin* with `__preview_shell=1` and the same nonce, and
  answers 503 otherwise (`public/preview-sw.js:39-52`).
- The previewed document's own URL also carries the nonce (`src/browser/preview-shell.ts:138`), so the code being previewed can read
  it. That is the substance of W-15.
- **The nonce does not bind to the port.** A document that knows its nonce can address `/preview/<anyPort>/…` on the same
  origin and be routed, because the lookup matches the nonce to a shell client and takes the port from the request. Within
  one preview origin that reaches only that project's own kernel and its ports, so the blast radius is the project's own
  dev servers — not another project. It is still a rule worth tightening, and it is exactly what W-15 asks for: pin
  "the nonce is accepted only for the shell it was minted for" with a test, and bind it to the port while doing so.
- **None of this changes with A or B**, and that is the point: the nonce is a session capability layered *on top of* an
  origin boundary. Both designs keep it. Neither can substitute for it.

W-15 stays open. This document supplies the rule the test should pin; it does not close the item, and no test was written.

## 6. Worker routing, wildcard DNS and TLS

Verified today against Cloudflare's own documentation, plus the PSL:

| Fact | Consequence |
| --- | --- |
| Worker route patterns support only a wildcard, and no infix wildcards: `https://*.example.com/images/*` is valid, `example.com/*.jpg` is not; the most specific route wins. | Both designs route with `https://*.<previewBase>/*`. A flat naming scheme like `preview-{id}.example.com` would be free of the TLS problem below but has no clean route pattern, because `preview*.example.com/*` is an infix wildcard and therefore invalid. |
| On a **full** Cloudflare setup, Universal SSL covers the apex and **first-level** subdomains only; deeper names "are not covered and will not serve a valid certificate". Fixes: Advanced Certificate Manager plus Total TLS, or a custom certificate with the names as SANs. ACM is listed as a paid add-on on every plan. | **A's `{id}.preview.example.com` is second-level and is not covered by Universal SSL.** A needs the ACM add-on on the only zone it has. This is A's real cost, and it is the fact most likely to be missed when comparing two diagrams that look alike. |
| On a **CNAME (partial)** setup, each proxied subdomain gets its own Universal SSL certificate "regardless of subdomain depth". | A theoretical free escape from A's TLS problem, but partial setup is a higher-plan feature, so it is not the cheap route it looks like. |
| `workers.dev` and `pages.dev` are both entries in the Public Suffix List. | Two platform hostnames are different sites for free. Useful for staging (below) and a warning: a preview on `*.pages.dev` is cross-site from a preview on `*.workers.dev` by accident of the PSL, not by design. |
| Workers Free: 100,000 requests/day, 10 ms CPU, 50 subrequests per request. | Preview traffic is asset-heavy; a single preview load can be dozens of requests. Free is fine for staging, `$5/month` is the realistic floor for real use. |

So:

- **TLS**: B is free on both zones (each wildcard is first-level: `*.example-preview.com` and `example.com`'s
  `app.`). A requires ACM (`Total TLS`) unless the hostname shape changes to something flat and worse. Cloudflare did not
  publish an ACM list price on the pages read today; the historically quoted figure is **$10/month per zone**, so treat
  "about $120/year versus about $11/year" as the order of magnitude and confirm in the dashboard at purchase.
- **DNS**: A is one zone and one wildcard record. B is two zones and one wildcard record each. Cloudflare DNS is free on
  both, so the difference is bookkeeping, not money.
- **Routing**: identical in both. The Worker must resolve `{id}` from the hostname, reject anything that is not 32 hex
  characters, and serve the same `dist/browser` the editor is built from. It must send COOP/COEP/CORP itself, because
  `_headers` is not applied to Workers responses (H1's documented limitation).

## 7. WebSocket and HTTP streaming

Unchanged by this decision. Both designs route through the same Worker and the same service-worker relay, which already
carries HTTP streaming (`src/network` + ADR-0030) and WebSocket upgrades (ADR-0033) across the `MessagePort`. Site
boundaries do not touch either: `WebSocket` handshakes are not cookie-carrying in our design (the page socket is opened by
the injected facade against the preview's own hostname and port), and a streaming response is not affected by COOP/COEP.

The one thing to protect while writing the Worker: **do not buffer**. A Worker that awaits the whole response before
returning it would silently turn the streaming chain into a buffered one and the streaming tests would still pass in the
harness, because they exercise the service worker, not the edge. The Worker must return the upstream `Response` with its
body stream intact and must pass through the `Upgrade` header for WebSocket requests.

## 8. Cross-project isolation

Equal in both designs, and by the strongest mechanism available: a distinct origin per project. Two constraints follow,
and both are easy to violate accidentally in a Worker:

1. **Never collapse projects onto one origin.** Path routing (`preview.example.com/<id>/…`) would put every project's code
   on one origin and make the nonce, not the origin, the only boundary between projects. That is a materially weaker
   design, and it would make W-15's open hole a cross-project one.
2. **Never serve two ids from the same hostname** through a rewrite that hides the difference. The hostname is the
   identity; a Worker that maps several hosts to one project would silently share `localStorage` between them.

Chrome's ancestor bit and per-site partitioning reduce cross-project leaks further in B, but they are not the mechanism.

### Cookies are not isolated by separate origins (measured, 2026-11-15)

Separate origins give separate `localStorage`, `IndexedDB`, `caches` and service-worker scopes. **They do not give separate
cookie scope**, and that has to be said plainly because the rest of this document reads as if they might.

Measured over HTTPS on real registrable domains in **Chromium 158.0.8127.18** and **WebKit 27.2**, with
`a.preview.test`, `b.preview.test`, `runtime.preview.test` as the engine family and `app.test` as the editor (the same
results in both browsers):

| Attempt | Result |
| --- | --- |
| `a.preview.test` sets `poison=from-a; Domain=preview.test` | **accepted** |
| `b.preview.test` reads `document.cookie` | **sees `poison=from-a`** |
| `runtime.preview.test` reads `document.cookie` | **sees `poison=from-a`** |
| `app.test`, the editor, reads `document.cookie` | does **not** see it |
| `a.preview.test` sets `Domain=app.test` | **rejected** |
| `a.preview.test` sets `__Host-poison=x; Domain=preview.test` | **rejected** |
| `b.preview.test` writes `poison=from-b; Domain=preview.test`, then `a` reads | `a` reads `from-b`: last writer wins |
| `b.preview.test` sets `__Host-secret=…` host-only, then `a` tries `__Host-secret=evil; Domain=preview.test` | **rejected**; `b` still reads its own value |

#### 1. Can preview JavaScript create parent-domain cookies, and do other projects see them?

**Yes to both.** A cookie's `Domain` attribute only has to *domain-match* the request host, and `a.preview.test` is a
subdomain of `preview.test`, so the write is legal. The cookie is then attached to every host under `preview.test`, and any
of those origins reads it with plain `document.cookie`. No exploit is required. This is the threat scenario the review
described, and it is real.

#### 2. Can cookies expose data across projects, or cause tossing and service confusion?

All four are possible, and three of them are measured above:

- **Cross-project data exposure**: one project can leave a value that another project reads. It is a channel, not just
  noise.
- **Cookie tossing / name collisions**: writes are last-writer-wins across projects (measured in both directions), so two
  projects using the same cookie name will silently overwrite each other.
- **Service confusion**: a preview can pre-seed a name that *another* project's own logic reads (a session-ish name, a
  theme, a feature flag, a "signed out" marker), so that project behaves as if state it never set were true. It is not a
  privilege escalation on its own, and it becomes one the moment any code on the engine site trusts a cookie for identity.
- **Persistence**: a cookie survives the preview that set it until it expires or the browser session ends, so it can sit
  in the jar waiting for the next project on that namespace.

What is **not** possible, and this is the boundary that matters: a preview cannot set or read a cookie for `app.test`.
`Domain` cannot span registrable domains (measured: rejected), so the editor's cookies are out of reach from the engine
site in both designs.

#### 3. Two boundaries, two mechanisms: the edge Worker and the preview Service Worker

They are not interchangeable, and the difference is measured rather than assumed.

**At the edge, a Cloudflare Worker is an ordinary HTTP proxy.** It can remove the incoming `Cookie` header before the origin
sees it, and remove `Set-Cookie` from the response before the page sees it. That is the only place where header *removal* is
a real capability.

**In the preview Service Worker it is not a capability at all.** `Cookie` is a forbidden request-header name: the worker
cannot read it, and deleting it from a rebuilt request changes nothing, because the browser attaches cookies from its jar
according to the request's credentials mode, not from script-visible headers. Measured over HTTPS in **Chromium
158.0.8127.18** and **WebKit 27.2**, with a `SameSite=None; Secure` cookie in the jar and the worker intercepting the
request:

| What the service worker does | What the origin server received |
| --- | --- |
| reads `new Request(event.request).headers.get("cookie")` | `null` — the header is not exposed |
| deletes `cookie` from the copied headers and refetches the rebuilt request | **`sess=abc`** — deletion is a no-op |
| `fetch(url)` with default credentials | `sess=abc` |
| `fetch(url, { credentials: "omit" })` | **`null`** — no cookie sent |

So inside the service worker the mechanism is **`credentials: "omit"` on every network fetch it performs**, not header
surgery, and the requirement needs contract tests that prove the *observable* behaviour rather than the implementation: the
upstream sees no `Cookie` header, and a response that carries `Set-Cookie` does not leave the jar populated. The failure
mode of a header-delete implementation is silent — it reads correctly and sends the cookie anyway.

#### 4. What neither boundary can protect

- **Navigation requests.** A top-level or iframe navigation to an engine URL is not mediated by these controls; the browser
  attaches whatever the jar and the cookie policy allow.
- **Requests that bypass the service worker.** A different scope, an unregistered or refused worker, a browser that never
  controlled the page, or any origin our worker does not scope: none of them are covered, and whether a browser registers the
  worker at all is a measured question (Firefox, WebKit and Safari each behave differently; §3 and the H2 gates).
- **The cookie jar itself.** Preview JavaScript can write a parent-domain cookie with `document.cookie`, and nothing above
  prevents that storage or another origin's read of it.

#### 5. The enforceable rule for engine-owned endpoints

An absolute claim that the engine cookie jar holds no cookies would be false, and it is measured to be false: previewed
code can populate that jar, and this document says so above. What *is* enforceable, and what a review can test, is not a
property of the jar at all:

**No engine-owned endpoint may issue, consume or trust a cookie.** Not for identity, not for authorisation, not for a
"remembering" preference that changes behaviour. Identity on the engine site stays the per-connection nonce in the URL (§5);
the runtime origin holds no storage of its own (ADR-0019); and no engine-owned handler may branch on a cookie.

What that buys: a planted cookie cannot be *used* for anything, even though it can exist and be read by every project. What
it costs: one line of discipline per endpoint instead of an assumption about the jar. It is also testable in a way "the jar
is empty" never was: send each engine-owned endpoint a request with a forged `Cookie` header and assert the response is
byte-identical to the same request without one.

#### 6. Host-only and `__Host-` cookies: what they give, and what they do not

- `__Host-` requires `Secure`, `Path=/` and **no `Domain` attribute**, so the cookie is host-only by construction. Measured:
  a sibling origin cannot set a `__Host-` cookie with a `Domain`, and cannot overwrite one already set on another host.
- Host-only cookies without the prefix are also safe from *sibling writes*: there is no API to set a cookie for another
  host. They are **not** safe from a sibling *reading a parent-domain cookie of the same name*, and they do not stop the
  parent-domain cookie from existing alongside them.
- The prefix protects only cookies that use it. It does not remove cookies already in the jar, does not stop
  non-prefixed parent-domain cookies, and gives nothing if the value is set by code on the *same* host (the case that does
  not arise here, since each project has its own host).

#### 7. Is any additional origin or site separation necessary?

- **Editor versus engine: no further separation is needed.** It is already a site boundary, and both directions are
  measured: a preview cannot set a cookie for `app.test`, and the editor does not see engine cookies.
- **Preview versus preview, and preview versus runtime: no further separation is *achievable* within one registrable
  domain.** Cookie scope is host-and-site based, so per-project cookie isolation would require one registrable domain per
  project, which is not viable. The design must therefore not *depend* on cookie isolation there — which is why the rule
  is "no cookies on the engine site" rather than "careful cookies".
- **The tripwire to record:** if the runtime origin ever needs a cookie for any reason, that is the moment it needs its own
  registrable domain, because it would otherwise share the cookie namespace with every project's preview. Written here so
  the decision cannot be made accidentally by adding one `Set-Cookie`.

#### What is guaranteed, what is mitigated, what remains possible

**Guaranteed (measured in two browsers, browser-enforced):**

- A preview cannot set or read a cookie for the editor's registrable domain.
- A `__Host-` cookie cannot be created with a `Domain` attribute, and cannot be overwritten by a sibling origin.
- The editor is a different site, so the same-site ambient-cookie scenario in §2 does not apply to it.

**Mitigated (enforced by our code, and only on paths that cross it):**

- **At the edge**, the Worker removes the incoming `Cookie` header and outgoing `Set-Cookie` headers.
- **Inside the preview service worker**, every network fetch it performs uses `credentials: "omit"` — measured above: the
  upstream receives no `Cookie`, and header deletion does not achieve this.
- No engine-owned endpoint issues, consumes or trusts a cookie, so a planted cookie has nothing to be trusted for.
- Neither of those covers navigations, or requests that bypass the service worker.

**Residual risk, kept explicit rather than engineered away: the shared parent-domain cookie jar remains a working channel
between projects on the engine site.** Measured in both browsers above: project A writes a cookie that project B and the
`runtime.` origin read; values collide last-writer-wins; a preview can pre-seed state that another project's own client logic
reads; and a planted cookie outlives the preview that set it. No mitigation in this section removes that channel — the
mitigations only stop it being forwarded or trusted.

**Also still possible, and accepted:**

- Preview code can set a parent-domain cookie for the engine site and every other project can read it.
- Cross-project last-writer-wins collisions on any cookie name.
- A preview can pre-seed state that another project's own client logic reads.
- A planted cookie can persist past the preview that set it.
- A request that bypasses our boundary (navigation, beacon, sibling-host subresource) still carries the cookie.

**Not implemented.** This section is documentation. The strips in "Mitigated" are requirements for the Worker (H2) and
the preview service worker (H3), each with a contract test, and neither exists yet. Nothing here claims the preview tier
is sandboxed: it is not.

## 9. Cost and operational complexity

| | A | B |
| --- | --- | --- |
| Domains | 1 | 2 (second one ≈ $11/year at cost) |
| Wildcard TLS | ACM paid add-on on the zone (≈ $10/month, to confirm) | free Universal SSL on both zones |
| Zones to manage | 1 | 2 |
| Worker | 1 route in the app zone | 1 route in the engine zone |
| Pages site | 1 | 1 (editor stays put) |
| Failure to reason about | a preview certificate failure is an app-zone incident | a preview certificate failure is isolated to the engine zone |
| Migration cost later | changing hostname after launch moves every stored project and shared URL | n/a |

The only column where A wins is "one zone". Everything else is a wash or favours B, and the annual cost of B is about the
price of a sandwich.

## 10. Implications for W-19 and ADR-0019

**W-19 stays open and is not made redundant by B.** Process-Worker hardening (capture what the shims need in closures,
replace `fetch` with a virtual network, delete `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `caches`,
`postMessage` from the process global) is specified in ADR-0019 and unimplemented. B reduces the *value* of two of those
deletions (a preview origin cannot reach the editor's cookies either way) and does nothing about the rest: user code that
keeps a raw `fetch` can still reach the network, still probe, still consume. Hardening is about what a program can do from
where it runs, not about what it can reach across a site boundary. ADR-0019's own sentence stands: defence in depth, not a
sandbox.

**ADR-0019 needs an amendment**, because the topology it describes ("host, runtime and preview origins under one base …
a wildcard DNS requirement and a wildcard TLS requirement") is A's shape, and its consequence list already records the
Vercel Pro wildcard as the blocker. The amendment should say:

- Three origin families remain, but they are grouped into **two sites**: the editor site, and an engine site that holds the
  runtime origin and every preview origin, each on its own origin (decided 2026-11-15; see "Decisions").
- The engine site **must hold no editor storage and no editor credentials, and no engine-owned endpoint may issue, consume or trust a cookie**. That is already true of the runtime
  origin by construction; making it a rule for the whole engine site is what keeps runtime-and-preview being same-site
  acceptable.
- The second registrable domain is a **product requirement**, not an optimisation: it is what makes "previewed code must
  not be able to act as the editor" enforceable by the browser instead of by our own code.
- `crossOriginIsolated` is unaffected: it is an origin property (so the syscall channel is indifferent to this decision).

**ADR-0017 needs an amendment** too, narrower: its deployment constraint says "project-scoped preview hostnames backed by
wildcard DNS and TLS, or an equivalent routing mechanism", which is agnostic about the site. It should point at this
document and record that the preview base sits on the engine domain.

## Decisions

### Decided: runtime placement (owner, 2026-11-15)

**The runtime and the previews share the engine registrable domain, each on its own origin.**

```text
app.example.com                  editor            editor credentials, cookies and storage live here and only here
runtime.example-preview.com      runtime frame     no cookies, no storage, no credentials (ADR-0019)
{id}.example-preview.com         project preview   one origin per project
```

Reasoning, recorded so it is not re-litigated from a diagram: both engine origins execute user code, so neither is a place
to keep anything the editor owns, and there is therefore nothing on the engine site for the runtime to reach. Separating
them onto a third registrable domain was considered and dropped: another domain and zone for no boundary that matters
today.

**The rule that makes that acceptable, stated so it can be enforced:** the engine site must contain no editor credentials,
no editor cookies and no editor storage, **and no engine-owned endpoint may issue, consume or trust a cookie** (§8 measures
why: previewed code can write a parent-domain cookie that every other project's origin reads, so a cookie on this site is a
shared namespace, not private state, and the jar cannot be kept empty). Concretely, nothing under `example-preview.com` may ever hold a session, a token,
or a copy of the editor's project store, and no engine origin may be granted a "trusted first party" exemption from the
editor's API. If that rule is ever violated, the reason for grouping runtime and previews on one site is gone and the
runtime needs its own registrable domain.

### Still open (owner)

1. **Second domain name and whether to buy now.** B assumes one. Staging can prove the topology without buying (below),
   but the name should be chosen before any public launch of previews.
2. **ACM versus a flat hostname, only if A is chosen anyway.** A can avoid the paid add-on by naming previews
   `{id}.example.com` (first-level, covered by Universal SSL) at the cost of an unguessable-but-colliding namespace under
   the apex and no clean Worker route pattern. Recorded for completeness; not recommended.
3. **Whether the editor stays on Cloudflare Pages** (H1's assumption) while the engine zone hosts a standalone Worker.
   That is the shape this document assumes; it is not implemented.

## Before B ships: the gates

Each of these is a measurement, not a decision to be assumed:

1. **Browser matrix for the cross-site service worker — mandatory, and before any purchase.** Run the preview chain in
   Chromium, Firefox and WebKit with the editor and the preview on genuinely different registrable domains, under TLS.
   The existing lane cannot be repurposed for this: it runs Chromium only, on `*.localhost`, over `http://`, against a
   dev server, and it asserts origins rather than sites (§3). If a browser refuses a third-party service-worker
   registration, B's architecture needs the Storage Access API or a redesign, and that finding has to land before the
   domain is bought, not after.
2. **Cookie proof.** On staging, set a `SameSite=Lax` cookie on the editor host, make a same-site request and a cross-site
   request from a preview document, and record which one carries it. This is the claim B rests on; it is cheap to measure
   once the hosts exist.
3. **Free staging without buying anything.** Deploy the editor to `<project>.pages.dev` and a path-routing Worker to
   `<worker>.workers.dev`. Both are PSL entries, so the two hosts are already cross-site, and the Worker's header and
   streaming behaviour can be proven there. Path routing is acceptable *for this proof only* — it is rejected for
   production by §8.
4. **TLS and routing on the real zone** (H2 proper): wildcard DNS, the Worker route, COOP/COEP/CORP on the Worker's own
   responses, streaming intact, WebSocket upgrade intact, and one project's failure not affecting another's.
5. **Leakage test**: from a preview document, assert no cookie is readable, no editor `localStorage` is visible, and no
   credentialed cross-site request succeeds.

## Boundaries honoured

No domain was bought. No DNS was configured. No Worker, application or preview deployment was made. No authentication or
backend was introduced. No runtime behaviour changed. No CSP was added. W-15, W-19 and W-20 remain open — this document
records the reasoning and the next measurement for each, and closes nothing.
