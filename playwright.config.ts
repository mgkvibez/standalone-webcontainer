/**
 * The browser lane.
 *
 * Kept in its own runner rather than inside vitest because it drives a real Chromium and a real Worker; mixing that with
 * 640 fast Node tests would make the fast lane slow and the slow lane flaky in the same move.
 *
 * `webServer` builds nothing: it serves the Vite dev server, which compiles the same sources the production build does.
 * The production build is verified separately (`npm run build:browser`), so a dev-only success cannot hide a broken
 * bundle, and vice versa.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
