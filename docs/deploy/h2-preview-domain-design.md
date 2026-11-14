# Preview domain topology: one registrable domain or two

Status: **H2 design investigation. No implementation.** Nothing was bought, configured or deployed. The preview tier is
**not** claimed to be sandboxed here, and this document does not say so anywhere: the isolation described is what browsers
enforce between origins and sites, plus what ADR-0019 specifies and W-19 still owes.

Scope: compare the two approved candidate topologies for the preview tier and recommend one. The Worker itself is H2's
next step and is not written yet.

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

What is *not* decided by this document: the second domain's name, whether `runtime.` sits on the engine domain or its own,
and the ACM-versus-flat-naming trade in A. Those are the owner's, listed under "Decisions still open".

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
- **It does not defeat a deliberately cross-site cookie.** A cookie set with `SameSite=None; Secure` is sent on
  cross-site subresource requests by design, so if the editor ever sets one (an embed-friendly analytics or SSO cookie,
  say), it is exposed to preview code in B exactly as it is in A. The rule that keeps B's guarantee is "the editor sets
  no `SameSite=None` cookie for any authenticated purpose", and it needs to be stated where cookies are introduced.
- **It does not cover unauthenticated actions.** An endpoint that accepts a write without a credential is equally
  writable from a preview in either design.
- **It does not stop a request being sent to an authenticated endpoint either.** CORS is a response-side control: it
  decides whether the caller may *read* the response, not whether the request is made. A credentialed request the browser
  does attach in some future configuration has still happened.
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
  runtime origin and every preview origin.
- The engine site **must hold no cookies, no editor storage and no credentials**. That is already true of the runtime
  origin by construction; making it a rule for the whole engine site is what keeps runtime-and-preview being same-site
  acceptable.
- The second registrable domain is a **product requirement**, not an optimisation: it is what makes "previewed code must
  not be able to act as the editor" enforceable by the browser instead of by our own code.
- `crossOriginIsolated` is unaffected: it is an origin property (so the syscall channel is indifferent to this decision).

**ADR-0017 needs an amendment** too, narrower: its deployment constraint says "project-scoped preview hostnames backed by
wildcard DNS and TLS, or an equivalent routing mechanism", which is agnostic about the site. It should point at this
document and record that the preview base sits on the engine domain.

## Decisions still open (owner)

1. **Second domain name and whether to buy now.** B assumes one. Staging can prove the topology without buying (below),
   but the name should be chosen before any public launch of previews.
2. **Where the runtime origin lives.** This document puts it on the engine domain (`runtime.example-preview.com`) because
   it executes user code and must never share a site with credentials. The alternative — a third registrable domain just
   for the runtime — is defensible and costs another domain and zone for no additional boundary that matters today.
3. **ACM versus a flat hostname, only if A is chosen anyway.** A can avoid the paid add-on by naming previews
   `{id}.example.com` (first-level, covered by Universal SSL) at the cost of an unguessable-but-colliding namespace under
   the apex and no clean Worker route pattern. Recorded for completeness; not recommended.
4. **Whether the editor stays on Cloudflare Pages** (H1's assumption) while the engine zone hosts a standalone Worker.
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
