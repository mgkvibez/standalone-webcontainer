# The cross-site harness

`npm run test:browser:cross-site` — **not** part of `npm run verify`.

It answers the one question the `*.localhost` browser lane cannot: does a browser let a service worker be **registered from a
third-party iframe on a genuinely different site**, and does it then **control** requests? That is the behaviour the preview
tier is built on (`src/browser/preview-shell.ts:37`), and the localhost lane cannot test it: `localhost` appears nowhere in
the Public Suffix List, browsers special-case loopback names in cookie and storage code, and the lane asserts origins rather
than sites.

This implements the proposal in PR #100 (merged as `94abc7f`).

## Running it

```bash
sudo npx playwright install --with-deps chromium firefox webkit
sudo apt-get install -y libnss3-tools          # certutil: Chromium and Firefox both need it
sudo npm run test:browser:cross-site           # all three, or add `chromium` / `firefox` / `webkit`
```

Root is required for `/etc/hosts` and the system trust store, and the harness refuses to run without it. It restores
`/etc/hosts` and removes the CA on exit, including on failure. Results are printed and written to
`artifacts/cross-site-harness.json`.

## What it does not need

No domain, no DNS, no deployment, no staging host. Genuine registrable domains come from `/etc/hosts`: `.test` is reserved by
RFC 2606 and is not a PSL suffix, so `swc-app.test` and `swc-engine.test` are different **sites**, not two names for
localhost.

## The per-browser CA problem (measured, not assumed)

`update-ca-certificates` configures **one** of three browsers. Each browser therefore gets the CA through the store it
actually reads:

| Browser | Store it reads | What failed |
| --- | --- | --- |
| WebKit 27.2 | system bundle (`/etc/ssl/certs`) | — |
| Chromium 158.0.8127.18 | NSS database at `$HOME/.pki/nssdb` | system bundle; `--use-system-ca` |
| Firefox 159.0 | the **profile's** NSS database, launched with `launchPersistentContext` | system bundle; `security.enterprise_roots.enabled`; `distribution/policies.json` with `Certificates.Install` |

No certificate bypass is used anywhere. `ignoreHTTPSErrors` and `--ignore-certificate-errors` are explicitly not the
acceptance path: a bypassed run measured the wrong thing once already (an SSL error fetching the worker script is exactly a
result this harness exists to see).

If the CA cannot be trusted for a browser, that row is an **infrastructure failure**, not a refusal, and the run fails.

## The matrix

| Case | Top-level site | Engine origin | Frame |
| --- | --- | --- | --- |
| `cross-site-third-party` | `swc-app.test` | `swc-engine.test` | third-party iframe |
| `same-site-third-party` | `a.swc.test` | `b.swc.test` | third-party iframe |
| `cross-site-first-party` | `swc-engine.test` | `swc-engine.test` | first-party (baseline: registration asserted, control recorded) |
| `storage-across-top-level-sites` | `swc-app.test` then `swc-other.test` | `swc-engine.test` | third-party iframe |

The same-site row exists because it is **design A's shape**, and because the harness's first version accidentally produced it
while claiming to be cross-site: `a.preview.test` and `b.preview.test` are different origins and the same site, so a
credentialed fetch carried the `SameSite=Lax` cookie. Every row therefore **asserts the topology it believes it is testing**
(`tools/harness/cross-site/topology.ts`) and fails as a harness error if the measurement does not match the claim.

## What each row records

Browser and pinned version, launch variant, trust path, the topology actually measured (both registrable domains, same-site
and cross-origin booleans, frame relationship), navigation outcome, registration outcome, `controller` after a **bounded**
`controllerchange` wait, whether a request was **actually served by the worker** (`/relay-probe`), which cookies arrived on a
credentialed fetch by name, the embedder's own cookie string and a same-origin control fetch (so a silently rejected cookie
looks different from a browser withholding one), and the storage readings.

Control and a worker-served request are **asserted on the two third-party rows** — that is what this harness exists to
measure — and **recorded, not asserted, on the first-party row**. A top-level document is only controlled once an active
worker claims it, and engines differ on whether the first navigation shows that: Firefox 159 reports `controller: false` on a
fresh first-party document even after a second client in the same context, while its third-party iframe rows are controlled
normally. Treating that lifecycle difference as a failure would mask the thing being measured, so the baseline row records it
with `controlAfter`.


`navigator.serviceWorker.ready` is never used as proof of control: it resolves while the client is still uncontrolled.

## Statuses are not interchangeable

- **pass** — measured, and it matches the case's expectation.
- **refusal** — HTTPS worked, the worker script was fetched and validated, and the browser refused the registration. This is
  a **compatibility finding** and fails the lane. It is never a skip.
- **infrastructure** — the browser could not launch, the CA was not trusted, navigation failed. Recorded separately and never
  counted as a refusal.
- **harness-error** — the measurement did not match the case's claim (wrong topology, no control, no worker-served response, a
  cookie expectation that changed). "The harness is wrong, not the browser: fix the case before reading any result."

`storage-across-top-level-sites` is recorded, **not asserted**: partitioning differs across builds (Playwright flags in
Chromium, ITP absent from the WebKit build) and treating it as a pass/fail would turn a build property into a product claim.

## Current results

Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2 — 12/12 pass:

- registration from a cross-site third-party iframe: **accepted** in all three;
- `controllerchange` within the bound, then a request **served by the worker**: all three;
- cross-site credentialed fetch: `SameSite=None` attached, `SameSite=Lax` withheld (all three);
- same-site credentialed fetch: **both** attached (all three), which is design A's hazard, measured;
- storage: **shared** across two different top-level sites in all three builds (observation).

**Playwright's WebKit is not Safari.** A WebKit pass is evidence about WebKit only. Safari stays unknown until it is tested in
actual Safari, and nothing in this harness should be read as Safari compatibility.

## One interaction worth knowing

The worker's first version proxied **every** request:

```js
event.respondWith(fetch(event.request, { credentials: "omit" }));   // do not do this
```

With that in place, the third-party frame's own credentialed fetches carried **no cookies at all** in all three browsers, so
the cookie rows measured the worker rather than the browser. The harness now proxies only its own transport paths
(`/proxy/*`) and passes everything else through. The mechanism was not isolated, so this is recorded as an interaction to
respect, not as product behaviour: a preview worker that re-issues arbitrary requests with `credentials: "omit"` will change
the credential behaviour of the page it controls.

## CI

Its own job (`.github/workflows/ci.yml`, `cross-site`), separate from the toolchain job and from the existing
`test:browser` lane, which is unchanged. The job installs the three engines and `libnss3-tools`, runs the harness under
`sudo`, and uploads `artifacts/cross-site-harness.json`.
