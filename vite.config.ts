/**
 * The browser build.
 *
 * `root` stays the repository root so that `index.html` sits beside the runtime it boots and `/src/...` URLs resolve in
 * development the same way they do in production. Output goes to `dist/browser`, which is build output and gitignored.
 *
 * The Worker is emitted as an ES module chunk. That is not a preference: the Worker imports the runtime as ES modules,
 * and `type: "module"` is what lets a single bundle serve both page and Worker without a second build.
 */

import { defineConfig, loadEnv } from "vite";

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
    server: { port: 5199, strictPort: true, host: "127.0.0.1", allowedHosts },
    preview: { port: 5199, strictPort: true, host: "127.0.0.1", allowedHosts },
    worker: { format: "es" },
    // Browser-native stand-ins for the three Node-shaped dependencies the runtime ships with.
    optimizeDeps: { include: ["buffer", "acorn", "pathe"] },
    plugins: [{
      name: "preview-base-domain",
      transformIndexHtml(html: string) {
        return html.replace('name="preview-base-domain" content=""', `name="preview-base-domain" content="${previewBaseDomain}"`);
      },
    }],
  };
});
