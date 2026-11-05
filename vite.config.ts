/**
 * The browser build.
 *
 * `root` stays the repository root so that `index.html` sits beside the runtime it boots and `/src/...` URLs resolve in
 * development the same way they do in production. Output goes to `dist/browser`, which is build output and gitignored.
 *
 * The Worker is emitted as an ES module chunk. That is not a preference: the Worker imports the runtime as ES modules,
 * and `type: "module"` is what lets a single bundle serve both page and Worker without a second build.
 */

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/browser",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: { input: "index.html" },
  },
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
  preview: { port: 5199, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  // Browser-native stand-ins for the three Node-shaped dependencies the runtime ships with.
  optimizeDeps: { include: ["buffer", "acorn", "pathe"] },
});
