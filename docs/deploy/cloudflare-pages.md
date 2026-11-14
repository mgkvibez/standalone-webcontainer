# Cloudflare Pages: the isolation contract

Status: **H1, implemented and tested. Nothing is deployed.** No Cloudflare account was configured, no DNS record was read
or changed, no domain was bought, and no Worker exists. What this document specifies is the repository change that makes a
Pages deployment of the *application* able to boot at all, plus the Pages limitations the next phase has to work around.

The preview tier is explicitly **not** part of this change. Pages cannot host it (below), so previews stay on the Worker
routing layer that H2 prototypes.

## The one requirement this document exists for

Without `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` the deployed document is not cross-origin
isolated, `SharedArrayBuffer` does not exist, and ADR-0018's synchronous syscall channel (`Atomics.wait`) cannot be
built. Nothing throws. The page loads and the runtime reaches a state it cannot boot from, with no cause stated anywhere
except a console warning about isolation that looks unrelated.

The dev server and `vercel.json` already send those headers. Cloudflare Pages does not read `vercel.json`: it reads header
rules from a plain-text `_headers` file that has to be **in the build output**. So the deployment requirement is one file:

| | |
| --- | --- |
| File in the repository | `public/_headers` (`public/` is copied verbatim into `dist/browser`) |
| File in the deployment | `/_headers`, beside `index.html`, `preview-sw.js` and `assets/` |
| Generated? | **Yes.** `npm run headers:write` renders it from `ISOLATION_HEADERS` in `vite.config.ts` |
| Verified? | `npm run headers:check` (inside `npm run verify`) fails on any drift, including a missing file |
| Enforced at build? | Yes: the `pages-headers-contract` plugin in `vite.config.ts` fails `vite build` if `dist/browser/_headers` is absent or would not isolate the document |

Do not edit `public/_headers` by hand. Change `vite.config.ts` and regenerate, or `verify` fails. The reason for a
generated file rather than a hand-written one is the same reason the dev-server headers are pinned to `vercel.json` by a
test: there are now three carriers for one set of values, and a third hand-typed copy is a copy that drifts.

### What it contains, and why each line is there

```text
/preview-sw.js
  Cache-Control: no-store, no-cache, must-revalidate
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

| Header | Value | Consequence of losing it |
| --- | --- | --- |
| `Cross-Origin-Opener-Policy` | `same-origin` | Not cross-origin isolated, so no `SharedArrayBuffer`. Also needed by the preview documents the service worker synthesises. |
| `Cross-Origin-Embedder-Policy` | `require-corp` | Same. `credentialless` would isolate in Chromium and not in Firefox or Safari, so it is refused; the dev-server test says so too. |
| `Cross-Origin-Resource-Policy` | `cross-origin` | The editor embeds the preview as an iframe on another host. Under `require-corp` that document must be explicitly shareable or it is blocked with `net::ERR_BLOCKED_BY_RESPONSE` and renders as an empty frame with no error in the page. |
| `X-Content-Type-Options` | `nosniff` | Browser content-type sniffing on files whose extension does not match their bytes. |
| `Referrer-Policy` | `no-referrer` | Preview URLs and their nonces would leak in `Referer` to anything a previewed app loads. |
| `Cache-Control` on `/preview-sw.js` | `no-store` | A cached service worker outlives deployments and keeps serving an old protocol against a new editor. |
| `Cache-Control` on `/assets/*` | `immutable, max-age=31536000` | Every hashed asset revalidated on each load. |

`X-Frame-Options` is absent on purpose: the editor must be able to embed the preview shell. A CSP is absent on purpose
too: this change does not introduce one, and any future CSP needs `'unsafe-eval'`, because the engine compiles user code
with `new Function`.

### Three Pages behaviours that shaped the file

All three are from Cloudflare's `_headers` documentation, and the first is the one that would have caused a bug that looks
like a caching problem rather than a header problem:

1. **Every matching rule applies; repeated header names are joined with a comma, not overridden.** `/preview-sw.js` and
   `/assets/*` are disjoint, so they may disagree about `Cache-Control`. Nothing may disagree with `/*`. The generator
   refuses to produce a file where two rules that *can* match the same request share a header name, and the test asserts
   the committed file has no such collision.
2. **Joining is not harmless for `Cache-Control`.** RFC 9111 says a cache should use the first value or treat the response
   as stale, so `public, max-age=31536000, immutable, public, max-age=0` is not merely ugly. This is why `/*` sets no
   `Cache-Control` at all and simply inherits nothing.
3. **`! Name` detaches a header.** This project uses no detach, and the parser rejects one rather than half-understanding
   it, so the file cannot quietly acquire semantics nothing here tests.

## Cloudflare Pages build settings

| Setting | Value | Note |
| --- | --- | --- |
| Build command | `npm run build:browser:preview` | Not `build:browser`: preview mode is what injects the preview base domain into `index.html`. Matches `vercel.json`. |
| Output directory | `dist/browser` | Matches `vercel.json`. `_headers` lands at its root. |
| Environment variable | `VITE_PREVIEW_BASE_DOMAIN` | Required. Preview mode throws without it, and validates it as a DNS name. Set it for **both** Production and Preview: a preview deployment is built from the Preview environment. |
| Node version | 20 | What CI uses; a Pages build should pin the same. |
| Install command | `npm ci` | Lockfile is committed. |

There is no SPA fallback to configure. The application is a single document at `/`, with no client-side router, so no
`_redirects` file is needed and none should be added speculatively: `/preview/<port>/` is answered by the service worker
*before* the network, and a catch-all rewrite would answer it first and break every preview. `tests/unit/deployment.contract.test.ts`
already forbids that rewrite for the Vercel deployment, and the same reasoning applies here.

## Limitations of Pages for this product

These are the facts that decide the hosting shape, not opinions about the platform.

1. **No wildcard custom domains.** A Pages custom domain is an apex or a single CNAME subdomain. Preview origins are
   `{previewId}.preview.<zone>`, which needs a wildcard. Pages can therefore host the editor and **cannot** host the
   preview tier. The approved fix is a Cloudflare Worker route on `https://*.preview.<zone>/*` serving the same build
   (H2). H0's report measured this and H1 does not change it.
2. **`_headers` is not applied to responses generated by Pages Functions.** If the Worker that fronts previews is
   implemented as a Pages Function or an `_worker.js`, it must attach the isolation headers to its own `Response`; a
   `_headers` rule matching the request will not do it. This is why the H2 Worker must send COOP/COEP/CORP itself and
   must be tested against the headers it actually returns.
3. **A `_headers` rule is inert for redirects it does not own.** Redirects are applied before headers, and when both match,
   the redirect wins. No `_redirects` file exists here, so nothing is affected today; it is recorded so that adding one
   later is a deliberate decision rather than a surprise.
4. **`_headers` limits: 100 rules, 2,000 characters per line.** The file uses 3 rules. The check fails above those limits
   so the ceiling cannot be crossed in silence.
5. **Unknown paths 404.** There is no document fallback. That is correct for this application and wrong to "fix" with a
   catch-all rewrite (see above).
6. **The `_headers` file itself is not served** as an asset. On Vercel it *would* be served, inertly, at `/_headers`;
   `vercel.json` remains the header carrier there and nothing depends on this file at Vercel.

## Verified here, and what is assumed

Verified in this change, by running it:

- `npm run build:browser:preview` with `VITE_PREVIEW_BASE_DOMAIN` set exits 0 and `dist/browser/_headers` is byte-identical
  to `public/_headers`.
- Removing `public/_headers` makes the build exit **1** with: *"the build output has no …/_headers. It is copied from
  public/_headers; without COOP/COEP the deployed document is not cross-origin isolated…"*.
- Setting `Cross-Origin-Embedder-Policy: credentialless` in the source file makes the build exit **1**, naming that header
  and the expected value.
- `npm run build:browser` (non-preview) also exits 0 with the file copied.
- `npm run headers:check` exits 0 on the committed file, and exits 1 with a named reason when the file is missing, drifted
  by one byte, or contains a wrong value.
- Deleting `public/_headers` makes 13 of the 31 contract tests fail; weakening a compared value fails 3; removing the
  byte-drift check fails 1; permitting `Cache-Control` on `/*` fails 1; and each branch of the overlap rule fails 1 or 2.

Assumed, and to be confirmed on the first real deploy:

- That Pages applies `_headers` to a fresh project's asset responses as documented. The header semantics above are quoted
  from Cloudflare's documentation, not measured against a live Pages deployment, because nothing was deployed.
- That the Pages build image provides Node 20 and runs `npm ci` against the committed lockfile.
- That a Pages deployment behind a proxy or Access does not strip or rewrite the isolation headers.

## Staging acceptance checklist

Run in order, against a staging hostname; each step states what would be true if it failed.

1. Build the exact production command locally with the staging domain:
   `VITE_PREVIEW_BASE_DOMAIN=<preview base> npm run build:browser:preview`, then confirm `dist/browser/_headers` exists at
   the output root. If absent, the deploy will be non-isolated and the runtime will not boot.
2. Deploy to a Pages **preview** environment first, never straight to production.
3. `curl -sI https://<staging host>/ | grep -i cross-origin` → all three headers present with the values above. If none
   appear, Pages is not reading the file from the output root and the deploy is non-isolated.
4. `curl -sI https://<staging host>/preview-sw.js` → `cache-control: no-store` **and** the isolation headers. A cached
   service worker survives deploys.
5. `curl -sI https://<staging host>/assets/<any>.js` → `immutable, max-age=31536000`, plus the isolation headers.
6. Open the staging host in a browser and evaluate `crossOriginIsolated` and `typeof SharedArrayBuffer` in the console. Both
   must be `true` / `"function"`. This is the check the headers exist for.
7. Run a program in the workspace and confirm it settles with an exit code. If the page loads but nothing runs, the
   document is not isolated.
8. `npm run verify:deployment -- --editor-url https://<staging host> --preview-base <preview base>` for the HTTP-level
   checks that do not need a browser.
9. Confirm no `X-Frame-Options` and no CSP `frame-ancestors` appear in any response from step 3 onward.

Steps 1 to 6 are the ones that fail silently if skipped. Step 6 is the only one that proves the requirement the whole
change is about.
