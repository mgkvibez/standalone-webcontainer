/**
 * Verifies a live Vercel deployment against the audit's requirements. Executed, never imported.
 *
 * It is HTTP-only on purpose: everything it asserts (status, headers, origin separation, TLS trust) is observable
 * without a browser, so it can run from a laptop, CI, or the moment a deployment exists. The one thing it cannot
 * prove is the service worker serving `/preview/<port>/` inside a real browser, because that requires a browsing
 * context; it says so instead of pretending a 404 from a static host is a failure.
 *
 * Usage:
 *   npm run verify:deployment -- --editor-url https://app.example.dev --preview-base preview.example.dev \
 *     --preview-id <32 hex chars> --port 8080
 */

import {
  buildShellUrl,
  checkAssetCaching,
  checkFramingAllowed,
  checkOriginSeparation,
  checkRootDocument,
  checkServiceWorker,
  previewOriginFor,
  reportIsolationPolicy,
  summarise,
  type CheckResult,
  type HttpResult,
} from "./deployment-checks.js";

interface Args {
  readonly editorUrl: string;
  readonly previewBase: string;
  readonly previewId: string;
  readonly port: number;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${arg} needs a value`);
    values.set(arg.slice(2), next);
    index += 1;
  }
  const editorUrl = values.get("editor-url") ?? "";
  const previewBase = values.get("preview-base") ?? "";
  if (editorUrl === "" || previewBase === "") {
    throw new Error("missing --editor-url and/or --preview-base. Use the real deployed hostnames, not placeholders.");
  }
  if (/example\.(com|org|net)/.test(editorUrl) || /example\.(com|org|net)/.test(previewBase)) {
    throw new Error("placeholder hostnames are refused; verification is only meaningful against the real deployment");
  }
  const previewId = values.get("preview-id") ?? "0".repeat(32);
  const port = Number(values.get("port") ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid port number");
  return { editorUrl, previewBase, previewId, port };
}

async function fetchResult(url: string, method: "GET" | "HEAD" = "GET"): Promise<HttpResult> {
  const response = await fetch(url, { method, redirect: "follow" });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { url, status: response.status, headers };
}

/** Pull one built asset out of the document so its caching can be checked without guessing a hash. */
function firstAssetPath(html: string): string | null {
  const match = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html);
  return match?.[1] ?? null;
}

async function readBody(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

function print(results: readonly CheckResult[]): void {
  const width = results.reduce((max, result) => Math.max(max, result.name.length), 4);
  for (const result of results) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(width)}  ${result.detail}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editorOrigin = new URL(args.editorUrl).origin;
  const shellOrigin = previewOriginFor({ previewId: args.previewId, baseDomain: args.previewBase });
  const results: CheckResult[] = [];

  console.log(`editor:  ${editorOrigin}`);
  console.log(`preview: ${shellOrigin}\n`);

  const root = await fetchResult(editorOrigin);
  results.push(checkRootDocument(root));
  results.push(checkFramingAllowed(root, "editor"));
  results.push(reportIsolationPolicy(root, "editor"));

  const sw = await fetchResult(new URL("/preview-sw.js", editorOrigin).href);
  results.push(...checkServiceWorker(sw));
  results.push(checkFramingAllowed(sw, "/preview-sw.js"));

  const html = await readBody(editorOrigin);
  const assetPath = firstAssetPath(html);
  if (assetPath === null) {
    results.push({ name: "asset caching", ok: false, detail: "no /assets/ reference found in the root document" });
  } else {
    results.push(checkAssetCaching(await fetchResult(new URL(assetPath, editorOrigin).href)));
  }

  results.push(checkOriginSeparation(editorOrigin, shellOrigin));

  const shellUrl = buildShellUrl(shellOrigin, {
    nonce: "0".repeat(32),
    hostOrigin: editorOrigin,
    port: args.port,
  });
  const shell = await fetchResult(shellUrl);
  results.push(checkRootDocument({ ...shell, url: `${shellOrigin}/ (preview shell)` }));
  results.push(checkFramingAllowed(shell, "preview shell"));
  results.push(reportIsolationPolicy(shell, "preview shell"));
  results.push(...checkServiceWorker(await fetchResult(new URL("/preview-sw.js", shellOrigin).href)).map((result) => ({
    ...result,
    name: `preview ${result.name}`,
  })));

  print(results);
  const { passed, failed } = summarise(results);
  console.log(`\n${passed} passed, ${failed} failed`);

  console.log(
    `\nNot asserted here: the service worker serving /preview/${args.port}/ inside a browser. A plain HTTP request to\n` +
      `that path is expected to 404 on a static host; the shell registers /preview-sw.js and controls the origin first.\n` +
      `Prove it in a browser with: npx playwright test tests/browser/p1b.spec.ts (local origins), or open\n` +
      `${shellUrl} in a browser and confirm the preview frame renders.`,
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${message}`);
  process.exitCode = 1;
});
