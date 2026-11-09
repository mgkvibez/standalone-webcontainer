/**
 * The audit's deployment checks, as pure functions over HTTP results.
 *
 * Pure on purpose: the real deployment is not reachable from CI, so the assertions that matter have to be testable
 * without one. The CLI does the fetching and hands the results here, which also means a failure names the exact
 * header or status that was wrong instead of "verification failed".
 */

export interface HttpResult {
  readonly url: string;
  readonly status: number;
  /** Response headers, lowercased by the CLI. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, ok: true, detail });
const fail = (name: string, detail: string): CheckResult => ({ name, ok: false, detail });

function header(headers: Readonly<Record<string, string>>, name: string): string {
  return headers[name.toLowerCase()] ?? "";
}

/** The editor root must be the application, served as HTML. */
export function checkRootDocument(result: HttpResult): CheckResult {
  if (result.status !== 200) return fail("root document", `${result.url} returned ${result.status}`);
  const type = header(result.headers, "content-type");
  if (!type.includes("text/html")) return fail("root document", `content-type was "${type}", expected HTML`);
  return ok("root document", `200 ${type.split(";")[0] ?? type}`);
}

/**
 * `/preview-sw.js` is the piece that makes previews work at all. It must never be cached, because a stale service
 * worker outlives deployments and would keep serving an old protocol against a new editor.
 */
export function checkServiceWorker(result: HttpResult): CheckResult[] {
  const checks: CheckResult[] = [];
  checks.push(
    result.status === 200 ? ok("/preview-sw.js", "200") : fail("/preview-sw.js", `returned ${result.status}`),
  );

  const type = header(result.headers, "content-type");
  checks.push(
    type.includes("javascript")
      ? ok("/preview-sw.js type", type.split(";")[0] ?? type)
      : fail("/preview-sw.js type", `content-type was "${type}", expected JavaScript`),
  );

  const cache = header(result.headers, "cache-control");
  const uncached = cache.includes("no-store") || (cache.includes("no-cache") && cache.includes("must-revalidate"));
  checks.push(
    uncached
      ? ok("/preview-sw.js cache", cache)
      : fail("/preview-sw.js cache", `cache-control was "${cache || "(absent)"}"; a cached service worker survives deploys`),
  );

  const nosniff = header(result.headers, "x-content-type-options") === "nosniff";
  checks.push(nosniff ? ok("/preview-sw.js nosniff", "nosniff") : fail("/preview-sw.js nosniff", "missing nosniff"));
  return checks;
}

/** Immutable hashed assets; a mutable asset URL would serve stale code after a deploy. */
export function checkAssetCaching(result: HttpResult): CheckResult {
  if (result.status !== 200) return fail("asset caching", `${result.url} returned ${result.status}`);
  const cache = header(result.headers, "cache-control");
  if (!cache.includes("immutable") || !cache.includes("max-age=31536000")) {
    return fail("asset caching", `cache-control was "${cache || "(absent)"}", expected immutable max-age=31536000`);
  }
  return ok("asset caching", cache);
}

/**
 * The editor embeds the preview shell in an iframe, so nothing on either origin may forbid framing. Checked as a
 * refusal of the two mechanisms that can: `X-Frame-Options`, and a CSP `frame-ancestors`/`frame-src` directive.
 */
export function checkFramingAllowed(result: HttpResult, label: string): CheckResult {
  const xfo = header(result.headers, "x-frame-options");
  if (xfo !== "") return fail(`${label} framing`, `X-Frame-Options: ${xfo} would block the editor's iframe`);

  const csp = header(result.headers, "content-security-policy");
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frame-ancestors"));
  if (directive !== undefined) {
    return fail(`${label} framing`, `CSP ${directive} restricts who may embed this document`);
  }
  return ok(`${label} framing`, csp === "" ? "no frame restriction" : "CSP present, no frame-ancestors");
}

/**
 * Cross-origin isolation is now part of what this deployment claims, because ADR-0018's synchronous syscall channel needs
 * `SharedArrayBuffer` and `SharedArrayBuffer` needs `crossOriginIsolated`. The rollout that used to report "no COOP/COEP"
 * as an accepted state is over: `vercel.json`, the dev server and the preview service worker all send them, and the
 * browser lane asserts `crossOriginIsolated === true` on both origins.
 *
 * Still reported rather than asserted: a live deployment's headers can drift from the repository's config, and this
 * check reads the deployment, not the config. Treat a missing header here as a failed rollout, not as informational.
 */
export function reportIsolationPolicy(result: HttpResult, label: string): CheckResult {
  const coop = header(result.headers, "cross-origin-opener-policy");
  const coep = header(result.headers, "cross-origin-embedder-policy");
  const detail = [
    coop === "" ? "no COOP" : `COOP: ${coop}`,
    coep === "" ? "no COEP" : `COEP: ${coep}`,
  ].join(", ");
  const missing = [coop === "" ? "COOP" : "", coep === "" ? "COEP" : ""].filter((part) => part !== "");
  if (missing.length > 0) {
    return { name: `${label} isolation policy`, ok: false, detail: `${detail}: ${missing.join(" and ")} absent, so SharedArrayBuffer is unavailable` };
  }
  return ok(`${label} isolation policy`, `${detail}`);
}

/** The whole point of the preview design: previews never share the editor's origin. */
export function checkOriginSeparation(editorUrl: string, previewOrigin: string): CheckResult {
  const editor = new URL(editorUrl);
  const preview = new URL(previewOrigin);
  if (editor.origin === preview.origin) {
    return fail("origin separation", `preview origin equals the editor origin (${editor.origin})`);
  }
  if (editor.hostname === preview.hostname) {
    return fail("origin separation", `same hostname (${editor.hostname}); only the port differs`);
  }
  return ok("origin separation", `${editor.hostname} -> ${preview.hostname}, distinct hosts`);
}

/** The shell document the editor frames, with the exact bootstrap contract the entry module reads. */
export function buildShellUrl(previewOrigin: string, options: { readonly nonce: string; readonly hostOrigin: string; readonly port: number }): string {
  const url = new URL("/", previewOrigin);
  url.searchParams.set("__preview_shell", "1");
  url.searchParams.set("__preview_nonce", options.nonce);
  url.searchParams.set("__host_origin", options.hostOrigin);
  url.searchParams.set("__preview_port", String(options.port));
  return url.href;
}

export interface PreviewIdSource {
  /** 128-bit lowercase hex, the same shape `resolvePreviewOrigin` enforces. */
  readonly previewId: string;
  readonly baseDomain: string;
}

/** Mirrors `resolvePreviewOrigin` for a production (https) base, so the verifier requests the origin the app builds. */
export function previewOriginFor(source: PreviewIdSource): string {
  if (!/^[a-f0-9]{32}$/.test(source.previewId)) throw new Error("preview ID must be 128-bit lowercase hexadecimal");
  if (!/^[a-z0-9.-]+$/.test(source.baseDomain)) throw new Error("preview base domain must be a plain hostname");
  return `https://${source.previewId}.${source.baseDomain}`;
}

export function summarise(results: readonly CheckResult[]): { readonly passed: number; readonly failed: number } {
  const failed = results.filter((result) => !result.ok).length;
  return { passed: results.length - failed, failed };
}
