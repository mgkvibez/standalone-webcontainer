# Proposal: a cross-browser harness for third-party service workers

Status: **proposal only.** Nothing here is implemented: no lane, no script, no CI job. This revision (2026-11-15, manager
review) replaces the spike's conclusions with measurements taken across three browsers on the intended runner, and fixes
the storage test the earlier version got wrong.

It references `docs/deploy/h2-preview-domain-design.md`, which at the time of writing is PR #99 and not yet on `main`.

## Why this exists

The preview tier depends on one browser behaviour nothing in the repository measures: **a service worker registered from
inside a cross-site third-party iframe**. `src/browser/preview-shell.ts:37` registers `/preview-sw.js` with scope `/` on
the preview origin, and that worker is the only thing that can answer `/preview/<port>/…`, because the dev server lives
inside the reader's browser. If a browser refuses the registration, previews do not work there.

The existing browser lane cannot answer it. It runs Chromium only, on `*.localhost`, over `http://`, against the Vite dev
server, and what it asserts is an **origin** relationship (`event.origin`, `crossOriginIsolated`, the document served), not
a **site** relationship. `localhost` appears nowhere in the Public Suffix List, and browsers special-case loopback names
in their cookie and storage code, so whether Chromium even classifies `<id>.preview.localhost` as a different site from
`localhost` is unestablished and cannot be read off that suite.

## What has been measured (this runner, 2026-11-15)

Runner: Debian 12, Playwright 1.65.0, browsers launched by Playwright with no certificate-bypass flags. Hosts
`swc-app.test`, `swc-other.test`, `swc-engine.test` mapped to `127.0.0.1` in `/etc/hosts`; one Node `https` server with a
leaf certificate signed by a locally generated CA. `.test` is reserved by RFC 2606 and is not a PSL suffix, so each name
is its own registrable domain: genuine cross-site conditions, unlike `*.localhost`.

### A. Trusting a local CA is per-browser, and the system store is not enough

| Browser | `update-ca-certificates` only | `--use-system-ca` | `security.enterprise_roots.enabled` | CA in the NSS database |
| --- | --- | --- | --- | --- |
| Chromium 158.0.8127.18 | `net::ERR_CERT_AUTHORITY_INVALID` | still `ERR_CERT_AUTHORITY_INVALID` | n/a | **works** (`certutil -d sql:$HOME/.pki/nssdb -A -t "C,,"`) |
| Firefox 159.0 | `SEC_ERROR_UNKNOWN_ISSUER` | n/a | still `SEC_ERROR_UNKNOWN_ISSUER` | not tested (Firefox profile DB) |
| WebKit 27.2 | **works** | n/a | n/a | n/a |

So the assumption the review warned about is exactly wrong on this runner: `update-ca-certificates` configures **one** of
three browsers. Chromium reads the NSS database in `$HOME/.pki/nssdb`, Firefox reads the per-profile NSS database, and
only WebKit (WebKitGTK via GnuTLS) uses the system bundle directly. `--use-system-ca` did not change Chromium's answer
here, and Firefox's enterprise-roots switch did not change its answer either; both remain untrusted until the CA is in the
database that browser actually reads.

**Acceptance path: a CA the browser genuinely trusts**, never `ignoreHTTPSErrors` and never a certificate-error bypass.
The earlier spike used `--ignore-certificate-errors` to get past a TLS failure and drew conclusions from that run; that was
a bypass masquerading as a fix, and it is withdrawn. A bypass would also hide a real certificate regression, which is the
opposite of what this lane is for.

### B. Where TLS succeeded, the preview architecture works

Two browsers reached the application. Both rows are the same script, the same origin layout and the same assertions.

| Observation | Chromium 158 (NSS CA) | WebKit 27.2 (system CA) |
| --- | --- | --- |
| HTTPS navigation to the editor host | ok | ok |
| Worker script fetched and registration accepted, in a cross-site third-party iframe | yes | yes |
| `controller` after a bounded `controllerchange` wait | `true` | `true` |
| A request actually served by the worker (`/relay-probe` → `{servedBySw:true}`) | yes | yes |
| Credentialed cross-site `fetch` to the editor host | `SameSite=None` sent, `SameSite=Lax` **withheld** | same |
| `localStorage` for the engine origin under two different top-level sites | **shared** | **shared** |

Two of those rows need care before anyone quotes them.

- **The cookie row is a second, independent confirmation** of the claim PR #99 §2 rests on: `SameSite=Lax` is not attached
  cross-site, `SameSite=None; Secure` is. It was measured here in two engines, with real registrable domains.
- **The storage row is an observation, not a product claim.** Both browsers shared the engine origin's `localStorage` across
  two different top-level sites, which is *not* what Chrome's documented third-party storage partitioning says should
  happen in a normal Chrome build on Chrome 115+. The most likely explanation is that Playwright's Chromium is launched
  with partitioning-affecting feature flags, and that WebKit build is not Safari with ITP. Either way, the honest
  reading is that this harness measures **Playwright's browsers**, and the partitioning row must be recorded as an
  observation per build rather than asserted as a requirement.

### C. Firefox is currently an infrastructure failure, not a refusal

Firefox launched and navigated, but TLS could not be established, so no registration result was recorded. That is
**infrastructure**, and the harness must label it that way rather than as "Firefox refuses third-party service workers".
Recording it as a refusal would be a false compatibility finding, which is precisely the confusion this section exists to
prevent.

## Harness design

### Dimensions

1. **Topology**: same-origin (control); same-site cross-origin (`a.example.test` + `b.example.test`); cross-site
   (`app.example.test` + `engine.test`). The middle row is design A, and it is the one nobody has measured.
2. **Frame relationship**: the same engine document loaded top-level, and loaded as a third-party iframe. First-party vs
   third-party is a property of the embed, so both are reported.
3. **Browser**: Chromium, Firefox, WebKit, each with the launch variant and trust path recorded.
4. **Cookie attributes**: host-only, `Lax`, `Strict`, `None`, `Domain=` on the parent, `__Host-`.

### The storage test, corrected

The earlier version asserted partitioning by having the editor parent read the iframe's `localStorage`. That cannot work:
a cross-origin parent cannot read a child origin's storage at all, so any version that "passes" is measuring the wrong
thing, and a same-origin shortcut would measure the editor's own store. The test is:

1. Load the engine document as a third-party iframe under top-level site **A**; it writes the probe key.
2. Load the same engine origin as a third-party iframe under top-level site **B**; it reports the value it reads *before*
   writing.
3. Load the engine origin **top-level** (first party) and report the value it reads.

Three separate partitions, three readings, all taken from the engine origin itself. A partitioned browser shows `null` at
steps 2 and 3; an unpartitioned browser shows site A's value at step 2.

Two lessons learned the hard way in the spike, both written into the harness requirements:

- the first-party comparison page must be **inert**: it must only read. In the spike the first-party document was the same
  script that writes the key, so the value it reported was its own write and the first-party row was worthless;
- the step-2 reader must read *before* writing, or it records its own value and the comparison collapses.

### Acceptance conditions

- **HTTPS navigation must succeed** in the browser under test before anything else is recorded. A navigation failure is
  infrastructure, recorded as `tls: failed` with the trust path attempted, and it stops that browser's row.
- **The worker script must be fetched and validated** and the registration accepted; a script-fetch TLS error is again
  infrastructure, not a refusal.
- **Wait for `controllerchange` with a bounded timeout (8 s), then prove control**: `navigator.serviceWorker.controller`
  is non-null *and* a request is actually answered by the worker. `navigator.serviceWorker.ready` resolves while the client
  is still uncontrolled, which is exactly the trap the first spike fell into: it reported `registered: true` and then saw
  its probe request reach the network.

### Result schema, and the two failure kinds

One record per (browser, launch variant, topology, frame relationship):

```text
browser, version, launchVariant, tlsTrustPath,
topLevelSite, engineOrigin, frameRelationship,
navigation: ok | tls-failed | error(+text),
registration: accepted | refused(+reason) | not-attempted(+why),
control: true | false | not-waited,
servedByWorker: true | false,
cookies: { sent: [...], withheld: [...] },
storage: { written, readUnderSecondSite, readFirstParty },
infrastructure: null | reason
```

**Infrastructure failure and product refusal are different statuses and must never be conflated.** A browser that will not
trust the CA, will not launch, or times out produces `infrastructure` and no compatibility verdict. A browser that
establishes HTTPS, fetches the worker script and *refuses the registration* produces a **compatibility finding**, which is
reported and never skipped. A skip is only ever legitimate for a dimension the owner has explicitly declined.

### Playwright's WebKit is not Safari

A WebKit pass is evidence about WebKit. It is not evidence about Safari: Safari layers ITP, its third-party storage policy
and its seven-day script-writable-storage cap on top. This revision measured a concrete divergence rather than assuming
one: the WebKit build **shared** an engine origin's `localStorage` across two different top-level sites, which is not how
Safari behaves with tracking prevention on. So the report must say "WebKit passed, **Safari unknown**", and Safari stays
unknown until it is tested in actual Safari. Whether Safari matters enough to test by hand is the owner's call.

## Packaging

- `npm run test:browser:cross-site`: its own Playwright project, its own explicit command, **outside** `npm run verify`.
  It needs root for `/etc/hosts`, extra browsers and a CA, none of which may become verify's dependencies.
- Its own CI job, which fails loudly and uploads the matrix as an artifact. A partial run is a failure, not a pass: if one
  browser cannot establish HTTPS, the job says so and does not silently report two-of-three.
- **The existing `*.localhost` browser lane stays exactly as it is**: it is the architecture regression (nesting, COEP,
  the shell handshake) and it must not be bent into a site test it cannot perform.

## Runner requirements

- `npx playwright install --with-deps chromium firefox webkit`. On a bare Debian 12 image, Firefox and WebKit additionally
  need their GTK/GStreamer libraries (`npx playwright install-deps`); without them both fail to launch, which the harness
  must report as infrastructure.
- Root (or sudo) for the three `/etc/hosts` entries, restored on exit.
- A generated CA, trusted per browser by the path that browser reads: system store for WebKit, `$HOME/.pki/nssdb` for
  Chromium, the profile's NSS database for Firefox. No `ignoreHTTPSErrors`, no `--ignore-certificate-errors`.
- Pinned browser versions printed in every record.

## Open before the harness can claim three browsers

1. **Firefox's trust path.** Neither the system store nor the enterprise-roots pref worked here; the remaining candidate is
   seeding the per-profile NSS database (`certutil -d sql:<profile>/cert9.db`), untested. Until it is solved, Firefox rows
   will be infrastructure failures, and that is what the report must say.
2. **Whether Playwright's flags change partitioning.** Compare an unflagged Chrome build and, if the owner wants it, real
   Safari, before quoting any partitioning behaviour as product behaviour.
3. **Safari.** Unknown by construction. Manual testing is a separate decision.

## Order of work

1. This proposal reviewed.
2. Harness built; Firefox trust path solved; three-browser matrix recorded with the schema above.
3. Only then decide on the second domain, with gate 1 answered by measurement rather than argument.

## Boundaries

No domain bought, no DNS configured, no Worker or application deployed, no authentication introduced, no runtime change.
W-15, W-19 and W-20 remain open. Nothing here is implemented.
