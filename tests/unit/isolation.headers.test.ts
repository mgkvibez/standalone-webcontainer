import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The isolation headers.
 *
 * Why this is a test and not a comment: without COOP and COEP the document is not cross-origin isolated, `SharedArrayBuffer`
 * does not exist, and ADR-0018's synchronous syscall channel silently cannot be built. Nothing throws. The runtime simply
 * falls back to something slower and the difference is invisible until someone measures it. Both the dev server and the
 * production deployment have to send the same three headers, so this pins both, and pins them to each other.
 */

const root = resolve(__dirname, "../..");

interface HeaderRule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

function productionHeaders(): Record<string, string> {
  const config = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as {
    headers?: readonly HeaderRule[];
  };
  const rule = (config.headers ?? []).find((entry) => entry.source === "/(.*)");
  if (rule === undefined) throw new Error("vercel.json has no catch-all header rule");
  return Object.fromEntries(rule.headers.map((header) => [header.key.toLowerCase(), header.value]));
}

async function devHeaders(): Promise<Record<string, string>> {
  // Dynamic import, not require: the config is an ES module, and loading it here means the test reads the real resolved
  // config rather than grepping its source text.
  const loaded = (await import("../../vite.config.js")) as unknown as {
    default: (env: { command: string; mode: string }) => {
      server?: { headers?: Record<string, string> };
      preview?: { headers?: Record<string, string> };
    };
  };
  const config = loaded.default({ command: "serve", mode: "development" });
  const server = config.server?.headers ?? {};
  const preview = config.preview?.headers ?? {};
  // Both blocks are asserted equal to each other here so a fix to one cannot leave the other behind.
  expect(preview).toEqual(server);
  return Object.fromEntries(Object.entries(server).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

describe("cross-origin isolation headers", () => {
  it("declare COOP, COEP and CORP in the dev server", async () => {
    expect(await devHeaders()).toMatchObject({
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
  });

  it("declare the same three in the production deployment config", () => {
    expect(productionHeaders()).toMatchObject({
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
  });

  it("agree between dev and production, so a local success cannot hide a deployed failure", async () => {
    const isolation = (headers: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.startsWith("cross-origin-")),
      );

    expect(isolation(await devHeaders())).toEqual(isolation(productionHeaders()));
  });

  it("use require-corp rather than credentialless, because credentialless is Chromium-only", async () => {
    // Both isolate the document, but `credentialless` is not implemented in Firefox or Safari, so choosing it would make
    // the same code isolated in one browser and not in another. The choice has to be the portable one.
    expect((await devHeaders())["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(productionHeaders()["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  it("do not serve X-Frame-Options, which would block the editor embedding its preview", async () => {
    for (const headers of [await devHeaders(), productionHeaders()]) {
      expect(headers["x-frame-options"]).toBeUndefined();
    }
  });
});
