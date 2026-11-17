# H3: staging readiness

Status: **plan. Nothing is deployed, purchased or configured.** No domain was registered, no DNS record exists, no Worker
was created, no Cloudflare account was touched. This document exists so the staging architecture can be argued about
before it is built.

It assumes H1, which is merged: the application build already emits a `_headers` file that isolates the document, enforced
at build time and checked by `npm run verify` (see `cloudflare-pages.md`). H3 is about where that build is *served*, and
about the second hostname family that previews need.

The proposal under review:

| Identity | Hostname | Runs |
| --- | --- | --- |
| Product / editor | `aporyx.com` | our code, our session, the editor, the runtime supervisor |
| Execution / preview infrastructure | `aporyx-engine.com` | user code, and the runtime that executes it |
| Project preview | `<32-hex-id>.aporyx-engine.com` | one project's preview, one origin per project |

**These are proposed identities, not approved purchases.** The proposal is the *separation*, not the strings.

---

## 1. Origin is not site, and the difference is the whole point

Two URLs are **same-origin** when scheme, host and port all match. They are **same-site** when their registrable domains
match; `site` ignores ports and ignores subdomains.

| Pair | Same origin? | Same site? |
| --- | --- | --- |
| `aporyx.com` and `aporyx-engine.com` | no | **no** |
| `aporyx.com` and `project.aporyx.com` | no | yes |
| `<id>.aporyx-engine.com` and `<id2>.aporyx-engine.com` | no | yes |
| `<id>.aporyx-engine.com` and `aporyx.com` | no | **no** |

This matters because the two boundaries are enforced by *different* browser machinery, and only one of them is about
data:

- **Origin** partitions `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage` and service-worker scope. One origin
  cannot read another's storage at all. This is a hard, browser-enforced boundary, and it is why one origin per project
  is enough to separate two projects' *storage*.
- **Site** decides which cookies are "same-site", and therefore whether ambient credentials travel with a request. It does
  **not** partition storage, and it is not something our code controls: it is decided by the registrable domain.

So a design that puts the editor at `aporyx.com` and previews at `<id>.aporyx.com` gets storage separation for free and
**no** cookie separation. That is the mistake this document exists to prevent, and it is the same conclusion H2 reached
independently (`h2-preview-domain-design.md`, still open for review).

## 2. Why the second registrable domain is the load-bearing decision

`<id>.aporyx.com` is a different origin from `aporyx.com` but the **same site**, so:

- A cookie set on `aporyx.com` with `SameSite=Lax` is attached to requests from `<id>.aporyx.com`, because Lax is decided
  per site, not per origin. Previewed code issuing `fetch("/", {credentials:"include"})` to the editor would carry the
  session.
- An editor cookie scoped with `Domain=aporyx.com` is readable from every preview subdomain.

Nothing in our code fixes that. The only fix is a different registrable domain, which is why previews live on
`aporyx-engine.com` and not on a subdomain of the product.

What that buys, stated precisely: previewed code **cannot** set or read a cookie for `aporyx.com`, because the cookie
`Domain` attribute has to domain-match the request host and `aporyx-engine.com` is not `aporyx.com`. That is browser
enforcement, not our discipline.

What it does **not** buy: anything about cookies *within* `aporyx-engine.com`. See §7.

## 3. Wildcard DNS, and the certificate shape that decides the hostname depth

The preview hostnames are unbounded in number (one per project), so they need a wildcard record, and the wildcard's
**depth** decides whether certificates cost money.

Verified against Cloudflare's Universal SSL limitations page (read 2026-11-17):

> When you rely only on Universal SSL in a full setup zone, coverage is limited to the root domain … and first-level
> subdomains … Deeper subdomains — such as `dev.www.example.com` — are not covered and will not serve a valid
> certificate. To enable SSL for deeper subdomains, you can: purchase Advanced Certificate Manager … or upload a custom
> SSL certificate.

That single paragraph decides the shape:

- `<id>.aporyx-engine.com` is **first level**. Covered by Universal SSL on a full setup zone. Included.
- `<id>.preview.aporyx-engine.com` is **second level**. Not covered. Requires Advanced Certificate Manager (paid) plus
  Total TLS, or an uploaded custom certificate to maintain by hand.

`resolvePreviewOrigin` builds exactly `<previewId>.<baseDomain>`, so the base domain must be the execution **apex**:

```text
VITE_PREVIEW_BASE_DOMAIN=aporyx-engine.com   ->  <32-hex>.aporyx-engine.com      included, first level
VITE_PREVIEW_BASE_DOMAIN=preview.aporyx-engine.com -> <32-hex>.preview.aporyx-engine.com   paid, second level
```

The `preview.example.com` shape used in the existing deployment contract test is therefore the *expensive* shape, and the
H3 configuration must not copy it. This is a configuration decision, not a code change: the base domain is an environment
variable and the derivation already produces the cheap shape when the base is the apex.

Two consequences worth writing down before anyone types a DNS record:

1. **The engine apex is not a preview.** `aporyx-engine.com` itself must serve nothing (or a 404), because a project id is
   32 lowercase hex characters and can never be the empty label. Previews are always `<id>.aporyx-engine.com`.
2. **Reserved hosts are safe by construction.** A 32-hex id cannot equal `runtime` or `api`, so any non-preview hostname we
   need on the execution domain (the runtime origin of ADR-0019) can coexist with the wildcard without a collision, and
   without needing an exclusion rule.

DNS records required, when and if this is authorised: an apex record for the product, a wildcard `*` record on the
execution domain, both proxied (orange clouded). Universal SSL's coverage is conditioned on the record being proxied, so
a grey-clouded wildcard has no certificate at all.

## 4. Worker routing and asset delivery

Cloudflare Pages cannot host this by itself. Pages custom domains are an apex or a single named host; there is no wildcard
custom domain, so `<id>.aporyx-engine.com` for every project is not expressible there. The preview tier therefore needs
the Worker routing layer, which is a different deployment model from H1 and is the part that most needs a prototype
(§11).

The shape, from Cloudflare's Routes documentation (read 2026-11-17):

- A **route** maps a URL pattern to a Worker. It requires an active zone, the Worker, and a **proxied DNS record** for the
  hostname being routed.
- Routes support patterns such as `*.aporyx-engine.com/*`, which is the mechanism that makes one Worker answer every
  project host without creating a record per project.
- "Routes cannot be the target of a same-zone `fetch()` call" — worth knowing, because it means a Worker handling a
  preview host cannot accidentally re-enter itself by fetching a same-zone URL, so no loop guard is needed for that case.
- Static assets are served through the **Assets binding** (`env.ASSETS.fetch(request)`) inside a Worker that also has
  assets deployed alongside it.

So: one Worker on `*.aporyx-engine.com/*`, serving the same `dist/browser` build the editor uses, with project identity
taken from the `Host` header rather than the path. That is the same file set H1 already produces; nothing about the build
changes.

## 5. Response headers, including the ones Pages would have set for us

H1's `_headers` file is a *Pages* mechanism. **Worker responses do not read it.** A Worker that answers with
`env.ASSETS.fetch()` returns whatever the asset carries, and a Worker that synthesises a response carries nothing. So the
preview tier must set the headers itself, and the values must be the same three, from the same single source of truth.

| Header | Value | Where it has to be sent |
| --- | --- | --- |
| `Cross-Origin-Opener-Policy` | `same-origin` | preview documents, and assets that are documents |
| `Cross-Origin-Embedder-Policy` | `require-corp` | same |
| `Cross-Origin-Resource-Policy` | `cross-origin` | every preview response the editor embeds |
| `X-Content-Type-Options` | `nosniff` | every response |
| `Referrer-Policy` | `no-referrer` | every response, because preview URLs carry the nonce |

Two failure modes this document is trying to prevent, both already observed in this repository:

- **Missing COEP on the preview document** renders an empty frame with `net::ERR_BLOCKED_BY_RESPONSE` and no cause in the
  page. `preview-sw.js` already sets COOP/COEP on synthesised `text/html` for exactly this reason; the Worker must not be
  the one place that forgets.
- **`require-corp` embeds need `CORP: cross-origin`** on the embedded document, or the embedder blocks it.

`X-Frame-Options` stays absent, and no CSP is added. A future editor CSP needs `'unsafe-eval'` because the engine compiles
user code with `new Function`; that is an argument for a separate origin, not for a header that breaks the product.

## 6. Preview service-worker scope

The preview chain depends on a service worker at scope `/` on the preview origin, because `/preview/<port>/…` is answered
by it. Consequences for H3:

- The worker must be served from the **root** of the preview origin with `Cache-Control: no-store`, or a cached copy keeps
  serving an old protocol against a new editor.
- Its scope is per origin, so each project's worker is isolated from every other project's by the browser, not by us.
- The Worker must **not** answer `/preview/<port>/…` on the preview hosts. A catch-all SPA fallback that maps those paths
  to `index.html` breaks every preview, which is why the deployment contract already forbids a rewrite for that path.
- Cross-site third-party registration is not guaranteed by any specification. It is exactly what `npm run
  test:browser:cross-site` measures, and the result is a per-browser finding, not an assumption: registration, a bounded
  `controllerchange`, and a request actually served by the worker, in Chromium, Firefox and WebKit.

## 7. Cookies and credentials

The rule for the execution domain is not "there are no cookies". Previewed code can always write to the shared cookie
namespace of its own site, and the harness measured exactly that: a preview-origin document setting
`Domain=aporyx-engine.com` is **accepted**, and sibling origins — including any runtime origin on the same domain — read
it.

The rule that is enforceable, and testable, is about trust:

> **No engine-owned endpoint may issue, consume or trust a cookie.** Not for identity, not for authorisation, not to
> remember anything that changes behaviour.

Identity on the execution domain stays the per-connection nonce in the URL, as today. Consequences:

- A preview can still plant a cookie for the whole execution domain. It cannot use it for anything, because nothing on
  that domain reads cookies for decisions.
- The editor's credentials stay on `aporyx.com`, a different site, so previewed code cannot set or read them at all.
- `__Host-` is the right prefix for any cookie we ever do set on the execution domain: it cannot be set with a `Domain`
  attribute and cannot be overwritten by a sibling origin. It is a useful hardening, not a substitute for the rule above.

The Worker can delete `Cookie` from inbound requests and `Set-Cookie` from outbound responses, and should, as defence in
depth. It cannot make the cookie jar empty, and it cannot stop a preview from reading its own site's cookies, so no
security argument may rest on it.

## 8. Storage separation

`localStorage`, `IndexedDB`, `CacheStorage` and service-worker registrations are all partitioned by **origin**, so H3 gets
project-to-project storage isolation from the hostname scheme alone. Two consequences to state plainly rather than
discover later:

- A new preview host is a **new origin with empty storage**. A project's data does not follow it from `localhost` or from a
  previous deployment hostname. That is a user-visible consequence of shipping, not a bug.
- Persistence today is `localStorage` keyed per project on the **editor** origin, which is unaffected by any of this. If
  project data ever moves to the preview origin, it becomes per-origin data and needs an export path before it does.

The harness also measured that the third-party storage of an execution-domain origin is **not partitioned by top-level
site** in the Playwright builds it ran (a preview frame under two different top-level sites read the same
`localStorage`). That is recorded as an observation, not relied on: the design must not depend on partitioning behaviour
that differs between engines and builds.

## 9. MessagePort and origin validation

The editor talks to the runtime over a `MessagePort` handed across after a handshake (ADR-0018/0019). For H3:

- `postMessage` to the preview origin must name the exact target origin. `"*"` is only acceptable before the runtime has
  proved who it is, and never for a message that carries code, a nonce or data.
- The receiving side must check `event.origin` against the expected origin, not just `event.source`, because a frame can
  be navigated.
- The port is a capability. Anything reachable through it is reachable by whatever ends up holding it, so it is handed to
  precisely one document, after the nonce handshake, and never re-broadcast.

## 10. Deployment reproducibility and browser compatibility

Reproducibility, already established and to be preserved: `npm run build:browser:preview` produces a byte-identical
`dist/browser`, the header file is generated from a single source of truth and checked in `verify`, and the build refuses
to produce a preview bundle without `VITE_PREVIEW_BASE_DOMAIN`. H3 adds a deployment step, not a build step, and must not
introduce one — a Worker that rewrites assets would break the byte-identical property that makes every other check
meaningful.

Browser compatibility is a measurement, not a claim. `npm run test:browser:cross-site` runs the third-party worker matrix
against Chromium, Firefox and WebKit on real registrable domains; `npm run test:browser` runs the localhost lane. Both are
green on `main`, and Playwright's WebKit is **not** Safari: Safari stays unknown until it is tested in Safari.

## 11. What is verified, and what still needs a prototype

**Verified against Cloudflare's documentation** (17 Nov 2026): Universal SSL covers the apex and first-level subdomains on
a full setup and nothing deeper; a CNAME (partial) setup behaves differently and needs a higher plan; routes map URL
patterns to a Worker, require a proxied DNS record, and wildcard patterns are the documented mechanism; routes cannot be
the target of a same-zone `fetch()`.

**Still requires a prototype before any of this is built.** Each of these is a question the documentation does not answer
for our case, and each one can invalidate part of the plan:

1. **Does a Worker route + Assets binding serve this SPA correctly on a wildcard host**, including `index.html` for the
   shell, `/assets/*` with the same cache headers, and no SPA fallback swallowing `/preview/<port>/`? The Worker bypasses
   `_headers`, so this is the highest-risk unknown.
2. **Does a preview document served this way register a service worker at scope `/` and control `/preview/<port>/` on a
   real proxied zone?** The harness proves the browser permits this on synthetic `.test` domains; it does not prove a
   Cloudflare-fronted host behaves identically.
3. **Are headers preserved through the Assets binding**, or must the Worker rewrite the `Response` to attach
   COOP/COEP/CORP? If it must rewrite, streaming and range behaviour have to be re-checked.
4. **Host header handling on a wildcard route**: confirm the Worker sees `Host: <id>.aporyx-engine.com` from the client and
   that `env.ASSETS.fetch()` does not need a rewritten URL to find the same files.
5. **Whether the runtime origin (ADR-0019) needs its own Worker or can share the wildcard** with a reserved label. The 32-
   hex id rule says collision is impossible, but routing precedence for a non-matching label needs confirming.

Nothing in §11 authorises building any of it. The prototype is the next decision, not this document.

## 12. The limitation, stated plainly

Separate origins, a second registrable domain, isolation headers and a preview-host wildcard are **defence in depth. Not a
sandbox.**

Previewed user code executes in the same browser, on the same CPU, with the same network access as the editor, and shares
the browser's cookie jar with everything else on its site. The boundaries here exist so that a mistake in user code cannot
silently reach editor credentials or another project's storage, not so that hostile code can be run safely. Calling this a
sandbox would be a claim the architecture cannot support, so this document does not make it.
