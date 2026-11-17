# H3 prototype: one Worker, one wildcard, five questions

Status: **design and requirements only. Nothing is created, deployed, registered or purchased.** No Cloudflare account,
zone, DNS record, Worker or certificate exists because of this document. It exists to be approved, corrected or rejected
before anything is spent.

The prototype is not a temporary production environment. It is the smallest experiment that can falsify the hosting design
before the design is paid for. Every part of it that is not one of the five questions is deliberately absent: no
application changes, no second Worker, no database, no authentication, no preview runtime.

---

## 1. Hostname depth is the entire question, so the shape has to be reproduced exactly

**Production target:** `<32hex>.aporyx-engine.com`, one label directly below the execution apex.

**Cloudflare's certificate rule (verified, Universal SSL limitations, read 17 Nov 2026):** a full nameserver setup issues
one certificate covering the zone apex and first-level subdomains, and nothing deeper. The rule is about *label depth*,
not about how the hostname is written, so a wildcard that looks tidily nested is a different certificate requirement:

| Hostname | Labels below apex | Certificate that covers it | Cost |
| --- | --- | --- | --- |
| `<32hex>.aporyx-engine.com` | 1 | `*.aporyx-engine.com` in the Universal SSL cert | included |
| `<32hex>.h3-probe.aporyx.com` | 2 | none, needs Advanced Certificate Manager or Total TLS | paid |

So the earlier draft of this document was wrong in a way that would have wasted the whole experiment: a route on
`*.h3-probe.<zone>/*` is a **deeper** wildcard, is not covered by Universal SSL, and would have failed the TLS test for a
reason that has nothing to do with the production design. A prototype that fails for the wrong reason is worse than no
prototype.

**The prototype zone is therefore the execution apex itself.** There is no "probe" label under someone else's domain: the
throwaway zone takes the place that `aporyx-engine.com` will occupy, and the preview hosts sit one label below its apex,
which is the same depth, the same certificate, and the same routing pattern.

```
production                          prototype (equivalent)
aporyx-engine.com            <-apex->   <ZONE>
  <32hex>.aporyx-engine.com  <-host->   <32hex>.<ZONE>
  *.aporyx-engine.com        <-cert->   *.<ZONE>
```

The apex itself is not matched by `*.<ZONE>/*` (wildcards do not match the apex), which is a useful property rather than
an inconvenience: the zone apex stays inert for the whole experiment, and a request to it returning a connection error is
the control that shows the route is binding only where it should.

### Options for obtaining that zone

| Option | Cost | Verdict |
| --- | --- | --- |
| Register one throwaway domain dedicated to the prototype | ~$10-12 for the first year at Cloudflare Registrar | **Recommended.** Reproduces the depth exactly, nothing else is at risk |
| Use an existing Cloudflare-hosted domain | $0 | Only if it is genuinely unused. A wildcard record and a route are zone-wide changes on a live zone; a mistake is an outage on whatever else that zone serves, and mail records make the teardown list longer than the experiment |
| Add Advanced Certificate Manager to an existing zone so `*.h3-probe.<zone>` can work | more than a domain per month | **Rejected.** Pays more to test the wrong shape |
| Free alternative | none | Routes are a zone feature, a zone needs a registrable domain, and `*.workers.dev` cannot host wildcard routes. There is no zero-cost path to the wildcard |

Nothing in this repository names such a domain, and the Vercel account owns no domains (verified inventory: four projects,
zero custom domains), so option 2 cannot be exercised without the owner naming a domain.

---

## 2. The stack that gets deployed

```
zone <ZONE> (throwaway, dedicated)
  route        *.<ZONE>/*                    -> worker aporyx-h3-probe
  DNS          *.<ZONE>                      -> AAAA 100::   (proxied placeholder origin)
  worker       aporyx-h3-probe
                 assets.directory            = ./dist/browser      (existing artifact, unchanged)
                 assets.binding              = ASSETS
                 assets.run_worker_first     = true
```

`run_worker_first` is on deliberately. The friendly path, where the assets layer answers everything and the Worker is never
invoked, is the one that tells us nothing: the question is what happens to `_headers` when a Worker fronts the request,
which is the shape the preview tier will have.

**Why a route and not a Worker custom domain:** custom domains are single hostnames. A wildcard hostname is a route.

**Why the placeholder origin is `100::`:** a proxied record must exist for a route to match, and a Worker route never
reaches an origin, so the address is a conventional discard prefix that cannot accidentally serve anything.

---

## 3. The Worker answers with four distinct kinds of response, and the tests depend on telling them apart

| Kind | How it is produced | Diagnostic header |
| --- | --- | --- |
| Static asset | `env.ASSETS.fetch(request)` returned untouched | none added by us |
| Preview shell | synthesised in code for a 32-hex host | `x-probe-layer: worker-shell` |
| Unsupported preview path | explicit `503` in code with a plain-text reason | `x-probe-layer: worker-503` |
| Diagnostics | `/__probe` JSON, hosts and hosts only | `x-probe-layer: worker-probe` |

The Worker adds **no** header to the asset path. That restraint is the measurement: if an asset response carries
`Cross-Origin-Opener-Policy`, the only possible source is `_headers`, because our code did not put it there. If the header
is missing, the layer that dropped it is identifiable by the absence of `x-probe-layer` plus the presence of the asset
body. Without that discipline, "the header is there" cannot be attributed to a layer, which is the whole point of test 2.

---

## 4. Host handling: three values that are not interchangeable

The draft echoed `Host` and treated that as the test. It is not. Three separate things have to be recorded and compared,
because the application's correctness depends on their relationship, not on any single one:

1. **The hostname in the request URL**, `new URL(request.url).hostname`, as Cloudflare presents it to Worker code.
2. **The `Host` header**, `request.headers.get("host")`, as exposed to Worker code.
3. **The hostname the application resolves the preview origin from**, derived by `resolvePreviewOrigin(previewId, baseDomain)`
   from `VITE_PREVIEW_BASE_DOMAIN` and the 32-hex id, which is the value that decides service-worker scope, storage
   partitioning and `location.origin` in the page.

The assertions are that all three agree for a real preview host, and that the derived origin equals `location.origin` inside
the served document. That last equality is the one that matters in production: if the build's base domain and the zone's
hostname shape disagree, the worker registers at the wrong scope or not at all, and the failure looks like a browser bug.

**Cloudflare normalisation to record rather than assume:** the `Host` header is not guaranteed to be present in all
contexts, hostname comparison should be case-insensitive, a trailing dot is legal and distinct, IDNs are punycode on the
wire, and the default port is absent from both the URL and the header. The probe therefore records the raw strings it saw
*and* compares them lowercased, so a difference in normalisation is visible as data instead of being flattened by a
`toLowerCase()` that hides it.

---

## 5. The five tests

Each test names the response layer it is reading, because "the request succeeded" is satisfiable by the wrong layer.

| # | Question | Assertion | Pass criteria | If it fails |
| --- | --- | --- | --- | --- |
| 1 | Does a Worker on a wildcard route serve the app? | `GET https://<32hex>.<ZONE>/` on a fresh 32-hex host, then `GET /assets/<hash>.js` | Shell is `200`, `x-probe-layer: worker-shell`; the asset is `200`, `text/javascript`, **no** `x-probe-layer`; `/__probe` returns the same host | Route not firing (record grey or zone inactive), or the asset manifest does not resolve on the wildcard host |
| 2 | Do the isolation headers survive the binding? | Read `COOP`, `COEP`, `CORP`, `nosniff`, `Referrer-Policy` on an **asset** response and on the **shell** | Asset: all five present with no `x-probe-layer`, therefore supplied by `_headers` through the binding. Shell: all five present with `x-probe-layer: worker-shell`, therefore supplied by code. Both carry the same values, and `Cache-Control` is `immutable` on `/assets/*` and `no-store` on `/preview-sw.js` | `_headers` does not survive `run_worker_first`, in which case the headers move into code and the parity test grows a second consumer |
| 3 | Does a service worker own the client on a real proxied zone? | Register `/preview-sw.js` at scope `/` on three engines, then make an in-scope request | `registration.active.state === "activated"`, `navigator.serviceWorker.controller` is non-null and `controller.scriptURL` is the registered script, `controllerchange` observed, **and** the response to an in-scope request carries a header only the worker can add (`x-served-by: preview-sw`), which proves control rather than registration | Registration succeeds and control does not, which is a finding about proxied zones, not a test bug. Reported as a compatibility result, never skipped |
| 4 | Is `Host` intact, and does the Worker need to rewrite the URL before `ASSETS.fetch()`? | Compare the three values from §4, and byte-compare the asset body from the direct and the fetched-through-binding paths | All three host values agree; derived preview origin equals `location.origin`; the two asset bodies are identical and neither path needed a URL rewrite | The Worker must rewrite `request.url`, an extra failure mode that would have to be carried in every route handler |
| 5 | Is there an accidental SPA fallback on preview paths? | `GET https://<32hex>.<ZONE>/preview/3200/` with no service worker installed | `503`, `content-type: text/plain`, `x-probe-layer: worker-503`, a body naming the reason, and **not** `index.html`. Control: the same path with a valid asset extension returns `404`, proving 503 is ours and not the asset layer's | A catch-all answered first; every preview would be silently broken, which is the exact failure the deployment contract already forbids for `/preview/<port>/` |

Test 3 reuses the cross-site harness that is already merged: pinned browser versions, real certificates, the same
three-engine matrix and the same infrastructure-versus-refusal classification. A browser refusing is a finding; a browser
that will not launch is infrastructure. They are not merged into one red.

---

## 6. Isolation, and what becomes public

The probe serves the real static application shell at a random 32-hex hostname. There is no backend, no API, no database,
no credentials and no user data in that artifact: the application is a browser-local engine that stores its state in
`localStorage`, so a request to the probe cannot reach anything that exists. It is not a preview: no runtime, no container,
no project, no nonce.

What is publicly reachable during the window is therefore a copy of a public, MIT-licensed frontend at an unguessable
hostname, plus the response headers. The window is used for the tests and closed. The zone apex stays inert throughout, and
the Worker name is specific (`aporyx-h3-probe`) so no teardown step can match anything else.

---

## 7. Teardown: ordered, idempotent, verified, and recorded

Written before deployment, because the failure that matters is a probe that stays up because the tests passed.

1. Delete the route `*.<ZONE>/*`.
2. Delete the Worker `aporyx-h3-probe`, and confirm its assets deployment goes with it.
3. Delete the wildcard DNS record `*.<ZONE>`.
4. **Verify**: request a preview hostname and require a failure that is *not* the shell (`522`/`530`/`404`), and request
   `/__probe` and require it to fail as well. "No longer serves the application" is a measurement, not an assumption.
5. List routes, Workers and DNS records for the zone and require that none of ours appear.
6. Leave the zone inert with no records and no route. Deleting the zone is optional and listed separately, because
   keeping it costs nothing and re-creating it costs a nameserver change.

Every step tolerates "already absent" so that a rerun after a partial failure completes rather than erroring, and the
resource ledger is a JSON file written *before* creation with the intended resources and updated *after* each step, so the
record exists even if the run dies halfway. The ledger states, for every resource: kind, identifier, created-at,
deleted-at, and the API answer that confirmed the deletion.

---

## 8. What remains genuinely unknown, and what this prototype will not settle

- **The runtime origin.** ADR-0019 wants `runtime.<engine-domain>` as a separate origin from previews, and the two are
  *same-site* by construction. The prototype has no runtime host, so it proves routing, TLS, headers and worker control on
  the execution domain, and it will not prove anything about the runtime-versus-preview relationship. That stays open until
  there is a staging deployment with both.
- **Certificate issuance latency** for a brand-new wildcard host is minutes, not seconds; the test harness has to wait for
  it rather than treating the first TLS error as a failure.
- **Route binding** is the most commonly reported Workers failure mode, which is why test 1 is first.
- **`_headers` through the binding** may not survive `run_worker_first`; test 2 is written so that either answer is usable.

---

## 9. What approval would cover

Exactly five things, and nothing else:

1. Registering one throwaway domain (or naming an existing unused Cloudflare-hosted zone instead of buying one).
2. Creating that zone, which means a nameserver delegation for a domain that has no other records.
3. Uploading one Worker named `aporyx-h3-probe` with the build artifact the repository already produces.
4. Creating one proxied wildcard DNS record and one route.
5. Running the three-engine test window, then executing teardown §7 and publishing the ledger.

Not covered, and not requested: production domains, any `aporyx.com` or `aporyx-engine.com` registration, DNS for anything
that already exists, public preview execution, `runtime.<domain>`, authentication, or any application change.
