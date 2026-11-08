/**
 * Locks the deployment contract that the Vercel rollout depends on.
 *
 * These assertions exist so the properties the audit requires cannot be lost silently in a later edit: an SPA
 * fallback added for `/preview/<port>/`, a frame-blocking header, a cached service worker, or a build command that
 * stops matching what `vercel.json` claims. Each one names the consequence, not just the mismatch.
 */

import { readFileSync, existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolvePreviewOrigin } from "../../src/browser/preview-origin.js";
import {
  assertCanApply,
  buildDeploymentPlan,
  PREVIEW_ENV_NAME,
  renderPlan,
  resolveTargets,
} from "../../tools/deploy/vercel-plan.js";
import {
  buildShellUrl,
  checkAssetCaching,
  checkFramingAllowed,
  checkOriginSeparation,
  checkRootDocument,
  checkServiceWorker,
  previewOriginFor,
  summarise,
  type HttpResult,
} from "../../tools/verify/deployment-checks.js";

const root = new URL("../../", import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, root), "utf8")) as Record<string, unknown>;
}

interface HeaderRule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

const config = readJson("vercel.json");
const headers = (config["headers"] ?? []) as readonly HeaderRule[];

function headersFor(source: string): Record<string, string> {
  const rule = headers.find((entry) => entry.source === source);
  if (rule === undefined) throw new Error(`no header rule for ${source}`);
  return Object.fromEntries(rule.headers.map((header) => [header.key.toLowerCase(), header.value]));
}

describe("vercel.json contract", () => {
  it("builds the preview mode bundle into the directory Vercel publishes", () => {
    expect(config["buildCommand"]).toBe("npm run build:browser:preview");
    expect(config["outputDirectory"]).toBe("dist/browser");
    expect(config["installCommand"]).toBe("npm ci");
  });

  it("has no rewrite or route for /preview/<port>/", () => {
    // That path is served by the preview origin's service worker at runtime. A catch-all SPA fallback would answer
    // the request before the worker ever sees it, which silently breaks every preview.
    const rewrites = (config["rewrites"] ?? []) as readonly { readonly source?: string }[];
    const routes = (config["routes"] ?? []) as readonly { readonly src?: string }[];
    expect(rewrites).toEqual([]);
    expect(routes).toEqual([]);
    expect(JSON.stringify(config)).not.toMatch(/\/preview\//);
  });

  it("never caches the service worker", () => {
    const rule = headersFor("/preview-sw.js");
    expect(rule["cache-control"]).toContain("no-store");
    expect(rule["x-content-type-options"]).toBe("nosniff");
    expect(rule["referrer-policy"]).toBe("no-referrer");
  });

  it("caches hashed assets immutably", () => {
    const rule = headersFor("/assets/(.*)");
    expect(rule["cache-control"]).toContain("immutable");
    expect(rule["cache-control"]).toContain("max-age=31536000");
  });

  it("does not forbid the editor from embedding the preview shell", () => {
    const everything = JSON.stringify(headers).toLowerCase();
    expect(everything).not.toContain("x-frame-options");
    expect(everything).not.toContain("frame-ancestors");
  });

  it("ships the service worker as a root file, which is the only scope that can serve previews", () => {
    expect(existsSync(new URL("public/preview-sw.js", root))).toBe(true);
  });
});

describe("deployment target resolution", () => {
  const good = { appHost: "app.example.dev", previewBaseDomain: "preview.example.dev" };

  it("derives the wildcard and the zone that must move to Vercel nameservers", () => {
    const targets = resolveTargets(good);
    expect(targets.wildcardHost).toBe("*.preview.example.dev");
    expect(targets.zone).toBe("example.dev");
  });

  it("accepts a two-part public suffix without mis-splitting the zone", () => {
    expect(resolveTargets({ appHost: "app.example.co.uk", previewBaseDomain: "preview.example.co.uk" }).zone).toBe(
      "example.co.uk",
    );
  });

  it("refuses placeholder hostnames instead of building a plan around them", () => {
    expect(() => resolveTargets({ appHost: "app.example.com", previewBaseDomain: "preview.example.com" })).toThrow(
      /placeholder/,
    );
    expect(() => resolveTargets({ appHost: "localhost", previewBaseDomain: "preview.localhost" })).toThrow(/reserved/);
  });

  it("refuses an app host that the preview wildcard would swallow", () => {
    expect(() =>
      resolveTargets({ appHost: "studio.preview.example.dev", previewBaseDomain: "preview.example.dev" }),
    ).toThrow(/falls under the preview wildcard/);
  });

  it("refuses hostnames in different zones, because one nameserver move must cover both", () => {
    expect(() => resolveTargets({ appHost: "app.example.dev", previewBaseDomain: "preview.other.dev" })).toThrow(
      /same zone/,
    );
  });

  it("refuses a bare apex as the preview base", () => {
    expect(() => resolveTargets({ appHost: "app.example.dev", previewBaseDomain: "example.dev" })).toThrow(
      /subdomain of example\.dev/,
    );
  });

  it("refuses a scheme, port or path in a hostname", () => {
    expect(() => resolveTargets({ appHost: "https://app.example.dev", previewBaseDomain: "preview.example.dev" })).toThrow(
      /bare hostname/,
    );
    expect(() => resolveTargets({ appHost: "app.example.dev:443", previewBaseDomain: "preview.example.dev" })).toThrow(
      /bare hostname/,
    );
  });
});

describe("deployment plan", () => {
  const plan = buildDeploymentPlan("webcontainer", { appHost: "app.example.dev", previewBaseDomain: "preview.example.dev" });

  it("inspects before it changes anything", () => {
    expect(plan.requests[0]?.method).toBe("GET");
    expect(plan.requests[0]?.path).toBe("/v9/projects/webcontainer");
  });

  it("sets the preview base domain in both environments, once", () => {
    const envWrites = plan.requests.filter((request) => request.path.includes("/env"));
    expect(envWrites).toHaveLength(1);
    const body = envWrites[0]?.body as { key: string; target: string[]; value: string };
    expect(body.key).toBe(PREVIEW_ENV_NAME);
    expect(body.target).toEqual(["production", "preview"]);
    expect(body.value).toBe("preview.example.dev");
  });

  it("attaches the editor hostname and the wildcard, and reads the result back", () => {
    const attach = plan.requests
      .filter((request) => request.path.endsWith("/domains") && request.method === "POST")
      .map((request) => (request.body as { name: string }).name);
    expect(attach).toEqual(["app.example.dev", "*.preview.example.dev"]);
    expect(plan.requests.at(-1)?.method).toBe("GET");
  });

  it("carries no credential, so the printed plan is safe to share", () => {
    const rendered = renderPlan(plan);
    expect(rendered).not.toMatch(/bearer|token|secret/i);
    expect(rendered).toContain("*.preview.example.dev");
  });

  it("refuses to apply without access, and says nothing was changed", () => {
    expect(() => assertCanApply({ token: "", apply: true })).toThrow(/No changes have been made/);
    expect(() => assertCanApply({ token: "   ", apply: true })).toThrow(/No changes have been made/);
    expect(() => assertCanApply({ token: null, apply: false })).not.toThrow();
    expect(() => assertCanApply({ token: "present", apply: true })).not.toThrow();
  });
});

describe("live deployment checks", () => {
  const goodSw: HttpResult = {
    url: "https://app.example.dev/preview-sw.js",
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  };

  it("passes a correctly configured service worker", () => {
    const results = checkServiceWorker(goodSw);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(summarise(results)).toEqual({ passed: 4, failed: 0 });
  });

  it("fails a cacheable service worker by name", () => {
    const results = checkServiceWorker({ ...goodSw, headers: { ...goodSw.headers, "cache-control": "max-age=3600" } });
    const cacheCheck = results.find((result) => result.name.includes("cache"));
    expect(cacheCheck?.ok).toBe(false);
    expect(cacheCheck?.detail).toMatch(/survives deploys/);
  });

  it("fails a service worker served with the wrong content type", () => {
    const results = checkServiceWorker({ ...goodSw, headers: { ...goodSw.headers, "content-type": "text/html" } });
    expect(results.find((result) => result.name.includes("type"))?.ok).toBe(false);
  });

  it("fails a 404 root document", () => {
    expect(checkRootDocument({ url: "https://app.example.dev", status: 404, headers: {} }).ok).toBe(false);
  });

  it("detects both mechanisms that would block embedding", () => {
    expect(checkFramingAllowed({ ...goodSw, headers: { "x-frame-options": "SAMEORIGIN" } }, "editor").ok).toBe(false);
    expect(
      checkFramingAllowed({ ...goodSw, headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } }, "editor").ok,
    ).toBe(false);
    expect(
      checkFramingAllowed({ ...goodSw, headers: { "content-security-policy": "default-src 'self'" } }, "editor").ok,
    ).toBe(true);
  });

  it("requires immutable asset caching", () => {
    const immutable: HttpResult = {
      url: "https://app.example.dev/assets/index-abc.js",
      status: 200,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    };
    expect(checkAssetCaching(immutable).ok).toBe(true);
    expect(checkAssetCaching({ ...immutable, headers: { "cache-control": "public, max-age=60" } }).ok).toBe(false);
  });

  it("rejects a preview origin that shares the editor origin", () => {
    expect(checkOriginSeparation("https://app.example.dev", "https://app.example.dev").ok).toBe(false);
    expect(checkOriginSeparation("https://app.example.dev", "https://0123456789abcdef0123456789abcdef.preview.example.dev").ok).toBe(true);
  });
});

describe("verifier requests the same origin the application builds", () => {
  it("agrees with resolvePreviewOrigin for a production base", () => {
    const previewId = "0123456789abcdef0123456789abcdef";
    const fromApp = resolvePreviewOrigin(previewId, {
      baseDomain: "preview.example.dev",
      hostOrigin: "https://app.example.dev",
    });
    expect(previewOriginFor({ previewId, baseDomain: "preview.example.dev" })).toBe(fromApp);
  });

  it("builds the shell URL with the bootstrap contract the entry module reads", () => {
    const url = new URL(
      buildShellUrl("https://0123456789abcdef0123456789abcdef.preview.example.dev", {
        nonce: "abc123",
        hostOrigin: "https://app.example.dev",
        port: 8080,
      }),
    );
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("__preview_shell")).toBe("1");
    expect(url.searchParams.get("__preview_nonce")).toBe("abc123");
    expect(url.searchParams.get("__host_origin")).toBe("https://app.example.dev");
    expect(url.searchParams.get("__preview_port")).toBe("8080");
  });
});
