/**
 * The probe lane.
 *
 * A probe is a diagnostic that asks one question of the running product and PRINTS the answer; it is not a gate. The distinction is not
 * cosmetic: a probe's failure mode is a hang (it waits for a condition that may never arrive), so a probe left in `tests/browser` fails CI
 * by *timeout* and says nothing about the code. That is what `probe-hmr.spec.ts` did on run 43443033526: 56 passed, 2 skipped, and the only
 * failure was a probe sitting on a `locator.click` for its full 600s.
 *
 * So probes live here, out of `playwright.config.ts`'s testDir, and run only when asked:
 *
 *     npm run probe:browser              # every probe
 *     npm run probe:browser -- hmr       # one, by filename filter
 *
 * `tests/unit/probe-lane.test.ts` pins the separation: the gate's testDir must contain no probe, and this config must serve the same target
 * as the gate, so a probe can never quietly measure a different app than the one CI gates on.
 */

import { defineConfig, devices } from "@playwright/test";

// Deliberately the same knobs as playwright.config.ts. The parity test asserts they stay equal rather than trusting the duplication.
const PORT = Number(process.env["SWC_BROWSER_PORT"] ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /\.probe\.ts$/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  // Probes print; the list reporter keeps that output attached to the step it belongs to.
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
