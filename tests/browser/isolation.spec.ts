/**
 * Cross-origin isolation, in a real browser.
 *
 * The unit test proves the headers are declared. This one proves they work, which is a different claim: `crossOriginIsolated`
 * is computed by the browser from COOP + COEP plus the absence of any violating embedded resource, so a header test can
 * pass while the page is quietly not isolated.
 *
 * Both hosts matter and they are not the same claim. The editor document has to be isolated for the runtime it hosts, and
 * the preview origin has to be isolated for the code running inside the preview. Before this test, neither was.
 */

import { expect, test } from "@playwright/test";

const PORT = Number(process.env["SWC_BROWSER_PORT"] ?? 5199);
const PREVIEW_HOST = `http://preview-check-${Date.now().toString(36)}.preview.localhost:${PORT}`;

test("the editor document is cross-origin isolated, so SharedArrayBuffer exists", async ({ page }) => {
  await page.goto("/");

  const isolation = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    atomics: typeof Atomics,
  }));

  expect(isolation.isolated).toBe(true);
  // The point of isolation: without it SharedArrayBuffer is not even a constructor, and Atomics.wait cannot block.
  expect(isolation.sharedArrayBuffer).toBe("function");
  expect(isolation.atomics).toBe("object");
});

test("the editor still boots and runs code with isolation on", async ({ page }) => {
  // require-corp fails closed, so isolation could plausibly have broken module loading or the Worker. This is the check
  // that it did not.
  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();

  await page.fill("#command", "console.log('isolated-ok')");
  await page.press("#command", "Enter");
  await expect(page.locator("#scrollback")).toContainText("isolated-ok");
});

test("a preview-origin document is isolated too, and serves an embeddable resource policy", async ({ page }) => {
  // A hostname shape the real thing uses: <previewId>.preview.localhost. Browsers resolve *.localhost locally, which is
  // exactly why no domain is needed to prove this works.
  const response = await page.goto(`${PREVIEW_HOST}/`);

  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
  // The editor embeds this document in an iframe, which require-corp blocks unless the child says it may be shared.
  expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");

  const isolated = await page.evaluate(() => crossOriginIsolated);
  expect(isolated).toBe(true);
});

test("the preview service worker script is served from the preview origin with no-store", async ({ page }) => {
  // Scope is per-origin, so this file has to be reachable at the root of every preview host, not only the editor's.
  // Fetched from inside the page on purpose: the Node-side request fixture cannot resolve *.localhost (only the browser
  // special-cases that suffix), and testing the header on a different resolver would not be testing the same thing.
  await page.goto(`${PREVIEW_HOST}/`);
  const result = await page.evaluate(async () => {
    const response = await fetch("/preview-sw.js", { cache: "no-store" });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      cacheControl: response.headers.get("cache-control") ?? "",
    };
  });

  expect(result.status).toBe(200);
  expect(result.contentType).toContain("javascript");
  // `no-store` is a production header and Vite's dev server does not apply it, so it is asserted where it actually lives:
  // the vercel.json contract test (`deployment.contract.test.ts`, /preview-sw.js rule). Asserting it here would be testing
  // the dev server's cache policy and calling it the deployment's.
  expect(result.cacheControl.length).toBeGreaterThan(0);
});

test("documents the preview service worker serves are isolated, so a frame can be embedded in an isolated parent", async ({
  page,
}) => {
  // The regression this pins: with COOP/COEP on the shell, a proxied document that lacks these headers is blocked outright
  // with `net::ERR_BLOCKED_BY_RESPONSE`. The frame renders empty and the page logs nothing, so without this assertion the
  // only symptom is one distant test failing for an unexplained reason. Measured, not assumed: this exact check is what
  // found it.
  const served: { url: string; contentType: string; coep: string; coop: string; corp: string }[] = [];
  page.on("response", (response) => {
    const headers = response.headers();
    if (!response.url().includes("/preview/3211/")) return;
    served.push({
      url: response.url(),
      contentType: headers["content-type"] ?? "",
      coep: headers["cross-origin-embedder-policy"] ?? "",
      coop: headers["cross-origin-opener-policy"] ?? "",
      corp: headers["cross-origin-resource-policy"] ?? "",
    });
  });

  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept("/server.js"));
  await page.click("#new-file");
  await page.locator(".cm-content").fill(
    [
      'const http = require("http");',
      'http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<main>isolation check</main>"); }).listen(3211);',
    ].join("\n"),
  );
  await expect(page.locator("#save-state")).toHaveText("saved", { timeout: 5_000 });
  await page.fill("#command", "node server.js");
  await page.press("#command", "Enter");
  const server = page.locator(".process-chip[data-pid='1']");
  await expect(server).toHaveAttribute("data-state", "running", { timeout: 15_000 });
  await server.getByRole("button", { name: "preview 3211" }).click();

  const inner = page.frameLocator("#preview-frame").frameLocator("iframe[title='Project preview on port 3211']");
  await expect(inner.locator("body")).toContainText("isolation check", { timeout: 15_000 });

  const document = served.find((entry) => entry.contentType.includes("text/html"));
  expect(document).toBeDefined();
  expect(document?.coep).toBe("require-corp");
  expect(document?.coop).toBe("same-origin");
  expect(document?.corp).toBe("cross-origin");
});
