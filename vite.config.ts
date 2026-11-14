/**
 * The browser build.
 *
 * `root` stays the repository root so that `index.html` sits beside the runtime it boots and `/src/...` URLs resolve in
 * development the same way they do in production. Output goes to `dist/browser`, which is build output and gitignored.
 *
 * The Worker is emitted as an ES module chunk. That is not a preference: the Worker imports the runtime as ES modules,
 * and `type: "module"` is what lets a single bundle serve both page and Worker without a second build.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { defineConfig, loadEnv } from "vite";

import { PAGES_HEADERS_OUTPUT_NAME, PAGES_HEADERS_SOURCE, pagesHeaderProblems } from "./tools/deploy/pages-headers.js";

/**
 * Isolation headers, needed for `crossOriginIsolated` and therefore for `SharedArrayBuffer`, which ADR-0018's synchronous
 * syscall channel depends on (`Atomics.wait`). A secure context is not enough: `http://localhost` is already trustworthy,
 * but SAB still refuses to exist unless the document is cross-origin isolated.
 *
 * `require-corp` fails closed, so it would break any cross-origin subresource that does not opt in. That is deliberate:
 * the app bundles its dependencies (no third-party CDN), so nothing needs an exception today, and the failure mode if
 * something is added later is a loud console error rather than a silent loss of isolation.
 *
 * CORP `cross-origin` is the exception that makes embedding work: the editor embeds the preview as an iframe on a
 * different host, and under COEP require-corp that child document has to be explicitly shareable.
 *
 * Kept identical in `vercel.json`; `tests/unit/isolation.headers.test.ts` fails if the two disagree.
 */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
} as const;

/**
 * Cloudflare Pages reads response headers from a `_headers` file in the *published* directory, not from `vercel.json`.
 * That file is generated (`npm run headers:write`) from `ISOLATION_HEADERS` above, and this plugin fails the build if
 * what landed in the output is missing or wrong.
 *
 * The reason to fail the build rather than only test the source file: a Pages deploy runs the build command and
 * publishes whatever it produced. If `public/_headers` were moved, renamed or emptied, the deploy would succeed, the
 * page would load, and the runtime would fail to boot with no stated cause, because `crossOriginIsolated` would be
 * false and `SharedArrayBuffer` would not exist. A failed build is the only version of that which gets noticed.
 */
const pagesHeadersContract = () => {
  let outDir = "";
  return {
    name: "pages-headers-contract",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const path = join(outDir, PAGES_HEADERS_OUTPUT_NAME);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        throw new Error(
          `the build output has no ${path}. It is copied from ${PAGES_HEADERS_SOURCE}; without COOP/COEP the deployed ` +
            "document is not cross-origin isolated, SharedArrayBuffer does not exist, and ADR-0018's syscall channel " +
            "cannot boot. Run `npm run headers:write`.",
        );
      }
      const problems = pagesHeaderProblems(text, {
        opener: ISOLATION_HEADERS["Cross-Origin-Opener-Policy"],
        embedder: ISOLATION_HEADERS["Cross-Origin-Embedder-Policy"],
        resource: ISOLATION_HEADERS["Cross-Origin-Resource-Policy"],
      });
      if (problems.length > 0) {
        throw new Error(`the built ${PAGES_HEADERS_OUTPUT_NAME} would not isolate the document:\n- ${problems.join("\n- ")}`);
      }
    },
  };
};

const isDnsName = (value: string): boolean =>
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const configuredDomain = env.VITE_PREVIEW_BASE_DOMAIN?.trim().toLowerCase() ?? "";
  if (mode === "preview" && configuredDomain === "") {
    throw new Error("VITE_PREVIEW_BASE_DOMAIN is required for `npm run build:browser:preview`.");
  }
  if (configuredDomain !== "" && (!isDnsName(configuredDomain) || configuredDomain === "localhost" || configuredDomain.endsWith(".localhost"))) {
    throw new Error("VITE_PREVIEW_BASE_DOMAIN must be a dedicated DNS name such as preview.example.com, without a scheme, port or path.");
  }
  const previewBaseDomain = configuredDomain || (command === "serve" ? "preview.localhost" : "");
  const allowedHosts = ["127.0.0.1", "localhost", ".preview.localhost"];
  if (configuredDomain !== "") allowedHosts.push(`.${configuredDomain}`);

  return {
    build: {
      outDir: "dist/browser",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: true,
      rollupOptions: { input: "index.html" },
    },
    server: { port: 5199, strictPort: true, host: "127.0.0.1", allowedHosts, headers: ISOLATION_HEADERS },
    preview: { port: 5199, strictPort: true, host: "127.0.0.1", allowedHosts, headers: ISOLATION_HEADERS },
    worker: { format: "es" },
    // Browser-native stand-ins for the three Node-shaped dependencies the runtime ships with.
    optimizeDeps: { include: ["buffer", "acorn", "pathe"] },
    plugins: [pagesHeadersContract(), {
      name: "preview-base-domain",
      transformIndexHtml(html: string) {
        return html.replace('name="preview-base-domain" content=""', `name="preview-base-domain" content="${previewBaseDomain}"`);
      },
    }],
  };
});
