# Vercel rollout: origin-separated previews

Status: **everything that does not require Vercel access is implemented and tested.** Nothing is deployed. No DNS
record has been read or changed, because no domain has been chosen and this environment holds no Vercel credential.

The application side is complete on `feat/p1d-worker-supervisor` (`d9bafc0`). What remains is provider work plus one
decision that is yours to make: **which domain**.

## What is already true of the build

| Requirement | Where it is enforced | Verified |
| --- | --- | --- |
| Build requires a preview base domain | `vite.config.ts` throws when `mode === "preview"` and the value is empty | yes: exit 1, named error |
| Output directory is `dist/browser` | `vercel.json` `outputDirectory` | yes |
| Build command is `npm run build:browser:preview` | `vercel.json` `buildCommand` | yes |
| No SPA fallback for `/preview/<port>/` | `vercel.json` has no `rewrites` and no `routes` | yes, asserted in `tests/unit/deployment.contract.test.ts` |
| `/preview-sw.js` is never cached | `vercel.json` header rule | yes |
| Hashed assets are immutable | `vercel.json` header rule | yes |
| Nothing forbids the editor framing the shell | no `X-Frame-Options`, no CSP `frame-ancestors` anywhere | yes |
| The shell only loads its iframe once the worker controls the origin | `preview-shell.ts` registers, awaits `ready`, then waits for `controllerchange` | read in source |
| Previews never share the editor origin | `resolvePreviewOrigin` throws when the resolved origin equals the host origin | yes, existing tests |

`/preview/<port>/` returns 404 from a static host and that is **correct**: the service worker answers it before the
network. Adding a rewrite would answer it *before* the worker and break every preview, which is why the contract test
forbids one.

## The decision needed

Three facts are required, and none can be guessed:

1. **The zone.** Which domain do you own, and does it currently use a registrar's DNS or Cloudflare?
2. **The editor hostname** inside that zone, for example `app.<zone>` or the apex.
3. **The preview base**, a dedicated subdomain such as `preview.<zone>`, giving previews at
   `<previewId>.preview.<zone>`.

Two constraints follow from how Vercel issues wildcard TLS, and both are refused by name in the planner rather than
discovered at deploy time:

- Both hostnames must sit in **one zone**, because wildcard certificates require Vercel's nameservers, and moving two
  zones means two moves.
- The editor hostname must **not be under the preview wildcard**. If it were, one hostname would be both the editor and
  a preview, and the origin separation the whole preview design rests on would be gone.

A wildcard domain is a **Pro-plan feature** on Vercel. That is a cost decision, not a technical one, so it needs your
explicit yes.

## Procedure

### 1. Review the plan (no access needed)

```bash
npm run deploy:plan -- --project <project> --app <editor host> --preview-base <preview base>
```

Prints the exact five requests and why each exists. Performs no I/O. Placeholder hostnames (`example.com`), `localhost`
and mismatched zones are refused before a plan is produced.

### 2. Apply, once access exists

```bash
VERCEL_TOKEN=... npm run deploy:apply -- --project <project> --app <editor host> --preview-base <preview base>
```

Sets `VITE_PREVIEW_BASE_DOMAIN` in **both** Production and Preview (a preview deployment is built from the Preview
environment; a production build that lost the value would silently lose previews), attaches the editor hostname and
`*.<preview base>`, then reads the domain list back. Without a token it refuses with *"No changes have been made."*

### 3. Nameservers

Point the zone at Vercel's nameservers. This is the step that cannot be automated from here, and the one that must not
be done carelessly: **MX, SPF/DKIM/DMARC and any verification TXT records must be recreated at Vercel first**, or mail
stops when the zone moves. Wildcard TLS is issued only after this.

### 4. Verify the live deployment

```bash
npm run verify:deployment -- --editor-url https://<editor host> --preview-base <preview base> --preview-id <32 hex>
```

Asserts, against the real origins:

- root document is 200 HTML
- `/preview-sw.js` is 200 JavaScript with `no-store` and `nosniff`
- hashed assets are `immutable, max-age=31536000`
- neither origin sends `X-Frame-Options` or CSP `frame-ancestors`
- the shell document answers 200 on `<previewId>.<preview base>`
- the preview origin differs from the editor origin, by host
- existing COOP/COEP state is **reported, not changed**

It prints `PASS`/`FAIL` per check and exits non-zero on any failure.

### 5. The one check no HTTP client can make

The service worker serving `/preview/<port>/` needs a browsing context. The verifier says so explicitly instead of
counting a static 404 as a defect. Prove it in a browser by opening the shell URL on the preview origin and confirming
the preview frame renders and the Worker's HTTP server answers.

## What this rollout deliberately does not do

- **No COOP/COEP.** Nothing shipped today needs `SharedArrayBuffer`, and `COEP: require-corp` would break the preview
  iframe unless every subresource carried CORP. Adding it is a separate decision with its own consequences, so the
  current policy (none) is preserved and reported.
- **No frame restrictions.** The editor must be able to embed the shell, so neither `X-Frame-Options` nor
  `frame-ancestors` may be introduced.
- **No DNS changes.** Not one record has been read or written from this environment.
