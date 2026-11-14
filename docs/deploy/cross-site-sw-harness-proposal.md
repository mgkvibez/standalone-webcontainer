# Proposal: a cross-browser harness for third-party service workers

Status: **proposal only.** Nothing here is implemented, and no lane, script or CI job exists yet. It is the measurement that
PR #99's gate 1 asks for, written after a spike that established the local setup works.

It references `docs/deploy/h2-preview-domain-design.md`, which at the time of writing is PR #99 and not yet on `main`.

## Why this exists

The preview tier's architecture depends on one browser behaviour nothing in the repository currently measures: **a service
worker registered from inside a cross-site third-party iframe**. `src/browser/preview-shell.ts:37` registers
`/preview-sw.js` with scope `/` on the preview origin, and that worker is the only thing that can answer `/preview/<port>/…`,
because the dev server lives inside the reader's browser. If a browser refuses the registration, previews do not work there.

The existing browser lane cannot answer it. It runs Chromium only, on `*.localhost`, over `http://`, against the Vite dev
server, and what it asserts is an **origin** relationship (`event.origin`, `crossOriginIsolated`, the document served) — not
a **site** relationship. `localhost` appears nowhere in the Public Suffix List, and browsers special-case loopback names in
their cookie and storage code, so whether Chromium even classifies `<id>.preview.localhost` as a different site from
`localhost` is unestablished and cannot be read off that suite.

## What the spike established (measured today, not assumed)

Two throwaway scripts under `/tmp`, both deleted after. Chromium 158.0.8127.18 from the repo's Playwright 1.65.0.

| Question | Result |
| --- | --- |
| Can genuine registrable domains be used locally with no DNS and no purchase? | **Yes.** `swc-app.test` and `swc-engine.test` added to `/etc/hosts` as `127.0.0.1`, served by one Node `https` server with SNI. `.test` is reserved by RFC 2606 and is not a PSL suffix, so each name is its own registrable domain: genuinely two sites, unlike `*.localhost`. |
| Is a self-signed certificate enough for a page load? | **Yes with `ignoreHTTPSErrors: true`**, but see the next row. |
| Is `ignoreHTTPSErrors: true` enough for the **service worker**? | **No.** Registration failed: `An SSL certificate error occurred when fetching the script`, while the page itself loaded fine. The SW script fetch is not a page navigation and keeps validating the chain. |
| What makes it work? | Launching Chromium with `--ignore-certificate-errors`. Registration then succeeded from the cross-site iframe: `registered: true`, scope `https://swc-engine.test:8443/`. |
| Does control follow immediately? | **Not within the same tick.** `navigator.serviceWorker.ready` resolved, `controller` was still `false`, and an in-frame `fetch('/relay-probe')` reached the network instead of the worker. The PoC did not wait for `controllerchange`; the product's shell does exactly that (`preview-shell.ts:29-34`). The harness must wait for `controllerchange` before asserting anything about relayed responses. |
| Do the cookie claims in the report hold? | **Yes, measured.** From the third-party frame, `fetch(app, {credentials:'include'})` sent **only** the `SameSite=None; Secure` cookie; the `SameSite=Lax` cookie on the same host was **withheld**. That is Chromium evidence for PR #99 §2's central claim, and for its correction: a deliberately `SameSite=None` cookie is exposed cross-site. |

## What the harness must measure

Four dimensions, because each one changes the answer:

1. **Host topology**: same-origin (control), same-site cross-origin (`a.example.test` + `b.example.test`), cross-site
   (`app.example.test` + `engine.test`). The middle row is what design A is, and it is the row nobody has measured.
2. **Frame relationship**: the same document loaded top-level, and loaded as a third-party iframe. First-party vs
   third-party is a property of the embed, not of the origin, so both must be reported separately.
3. **Browser**: Chromium, Firefox and WebKit. The suite installs Chromium only today.
4. **Cookie attributes**: host-only; `SameSite=Lax`, `Strict`, `None`; `Domain=` on the parent; a `__Host-` cookie.

Assertions per cell, recorded as data (not pass/fail prose):

- registration outcome (`registered`, or the exact refusal reason);
- `controller` after `controllerchange`, and whether a request is actually served by the worker;
- which cookies arrive on a credentialed cross-site `fetch`, by name;
- `document.cookie` visible inside the frame;
- a `localStorage` key written inside the frame, read back from the top-level page (partitioning).

A browser that refuses the registration is a **product finding**, recorded and surfaced, not a skipped test. The harness's
job is to produce the matrix, and the decision about what to do with a refusal (Storage Access API, or a redesign) is the
owner's.

## Runner requirements, and the one that is awkward

- `npx playwright install firefox webkit`. The lane must refuse to run if a browser is missing rather than silently testing
  one.
- **`/etc/hosts` write access** for the two test hostnames. All three browsers then use the ordinary system resolver, and no
  engine-specific flag is involved. This needs root or sudo: available here and on GitHub's Ubuntu runners.
- **A locally-trusted CA** rather than `--ignore-certificate-errors`: generate a CA with `openssl`, sign a leaf with SANs for
  both hostnames, install it into the system trust store (`update-ca-certificates`) so the SW script fetch validates like
  production does. Ignoring certificate errors globally would mask a genuine TLS regression, and the point of this lane is to
  measure the browser, not to bypass it.
- **HTTPS is mandatory, not a preference.** `http://swc-app.test` is not a secure context, and service worker registration is
  refused outright. `http://localhost` is a secure context, which is precisely how the existing lane avoided the problem and
  landed in the localhost special case this harness exists to escape.
- Pinned browser versions printed in the report; no network access required after setup.

If a future runner cannot write `/etc/hosts`, the fallbacks are Chromium `--host-resolver-rules`, Firefox
`network.dns.localDomains`, and nothing for WebKit. That asymmetry is why the harness should **fail loudly** rather than fall
back per browser: a WebKit run that quietly resolved `localhost` would be worse than no run at all.

## Packaging

- `npm run test:browser:cross-site`, a separate Playwright project, **not** part of `npm run verify` (it needs root, extra
  browsers and a CA, which `verify` must not depend on).
- Its own CI job, allowed to fail loudly, reporting the matrix as the artifact.
- The existing `*.localhost` lane stays exactly as it is: it is the architecture regression, and it keeps proving the nested
  COEP behaviour cheaply.

## A caveat that must be written into the output

**Playwright's WebKit is not Safari.** It is a WebKit build with Playwright's own configuration; Safari's tracking-prevention
defaults, its third-party storage policy and its 7-day script-writable-storage cap are Safari product decisions layered on
top. A pass in Playwright WebKit is therefore evidence about WebKit, not proof for Safari, and the harness output must say so
in the same words. Deciding whether Safari matters enough to test manually is the owner's call; recording it as "WebKit
passed, Safari unknown" is the honest default.

## No public deployment is needed for this

The spike answers gate 1 locally: no zone, no DNS record, no certificate authority purchase and no staging deployment. A
public staging host is needed only for the edge behaviours (Worker headers, streaming, WebSocket upgrade, wildcard routing),
which are gate 4 and remain out of scope here.

## Order of work

1. This proposal reviewed.
2. Harness built and run locally across three browsers; matrix recorded.
3. Only then decide on the second domain, with gate 1 answered by measurement rather than by argument.

## Boundaries

No domain bought, no DNS configured, no Worker or application deployed, no authentication introduced, no runtime change. W-15,
W-19 and W-20 remain open.
