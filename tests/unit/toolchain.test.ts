/**
 * Toolchain smoke test — NOT a product test.
 *
 * Sole purpose: prove that `npm test` (vitest + tsconfig strict mode)
 * executes in this repository. Product behavior is covered by the focused
 * VFS, runtime, npm, container, and browser suites; this test only checks the
 * runner itself.
 */
import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("vitest executes and resolves imports under strict tsconfig", () => {
    expect(true).toBe(true);
  });
});
