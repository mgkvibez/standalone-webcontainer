# P1e foundation: origin-separated browser previews

Status: local preview shell and request path implemented; production hostname routing is still deployment work.

## Request flow

The workspace resolves the active project's persisted opaque `previewId` beneath the configured preview base domain. It
opens a shell page in an iframe on that separate origin. The host accepts the shell handshake only when the message has
the expected nonce, exact preview origin and exact iframe `WindowProxy`. It transfers one `MessagePort` to the runtime
Worker and the other end to the preview shell. The Worker assigns each transport an ID so closing the preview can close
the Worker-owned port as well. Pending handshakes are abortable; project switches and server termination close the shell.

The shell registers `/preview-sw.js` on the preview origin only. Its nested project iframe loads
`/preview/<port>/`. The service worker identifies the project server and session nonce, sends the request to the shell
page, and the shell relays it through the transferred port to the Worker supervisor. The editor application's origin
does not receive preview fetch events or expose its storage to preview code.

Request and response bodies are limited to 16 MiB; headers are limited to 128 entries and 32 KiB total. The supervisor
still has one serialized execution lane and buffered HTTP responses.

## Configuration and boundaries

- Local development uses `<previewId>.preview.localhost:<app-port>`. Vite accepts that subdomain and serves the same
  index entry, which selects the preview shell from its bootstrap query.
- Development injects `preview.localhost` automatically. A standard production build leaves the value empty and disables
  preview launch. A preview deployment build must set `VITE_PREVIEW_BASE_DOMAIN` to a dedicated DNS base, for example
  `preview.example.com`; malformed values and missing values in preview mode fail the build. See [env.preview.example](../../env.preview.example).
- Production hosting must route wildcard DNS and TLS for `<previewId>.preview.example.com` to `dist/browser`, serve
  `index.html` for preview-origin document paths, serve `/preview-sw.js` as JavaScript from the preview origin root, and
  serve built assets from that same origin. This repository does not configure provider-specific DNS, certificates or
  rewrites.
- Vercel deployment uses [vercel.json](../../vercel.json): it runs the explicit preview build, publishes `dist/browser`,
  avoids caching the service-worker script, and caches fingerprinted assets immutably. Set
  `VITE_PREVIEW_BASE_DOMAIN=preview.example.com` in Vercel's Production environment and attach both the application
  domain and `*.preview.example.com` to the Vercel project. Vercel requires the nameservers method for wildcard domain
  certificates; copy existing DNS records such as MX and verification TXT records before changing nameservers.
- No COOP, COEP, CSP or `X-Frame-Options` policy is added here. The preview shell must be frameable by the editor,
  and the final deployment must test its chosen cross-origin policy before preview release.
- The host shell iframe and project iframe are separate from the editor origin. The preview shell and the user's project
  page share the preview origin, so this is an origin boundary for editor data, not a complete sandbox for user code.
- Preview hosting under COOP/COEP and credentialless/CORP/CORS policies still needs deployment verification before
  preview is enabled in production. The current runtime does not require SharedArrayBuffer.
- The UI currently opens one selected server port at a time. Multiple simultaneous preview tabs and WebSockets remain
  outside this slice.

## Verification

Typecheck, production browser build, and the focused unit suites passed. All 20 Chromium cases reported success, including
the preview integration for a real server on a project-specific `*.preview.localhost` origin, through the real service
worker and Worker supervisor. In this Windows session Playwright also remains alive after reporting an unrelated page-load
smoke test as successful, so its process exit is not confirmed and appears independent of the preview lifecycle.
