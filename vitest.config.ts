/**
 * The Node test lane.
 *
 * Playwright specs live in `tests/browser` and are run by their own runner, so they are excluded here rather than
 * being discovered by vitest and failing for the wrong reason. The include is explicit on purpose: a stray `.spec.ts`
 * outside tests/browser should be a deliberate decision, not silently picked up.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
    // The charter requires hard timeouts. Without these, a hung test is a hung CI job.
    testTimeout: 15_000,
    hookTimeout: 10_000,
    // Fail loudly instead of running a half-collected suite.
    passWithNoTests: false,
  },
});
