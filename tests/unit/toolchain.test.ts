/**
 * Toolchain smoke test — NOT a product test.
 *
 * Sole purpose: prove that `npm test` (vitest + tsconfig strict mode)
 * executes in this repository. There is deliberately no product assertion
 * here: nothing is implemented yet, and the VFS design is not approved
 * (see docs/decisions/ADR-0001.md, open questions). Product tests land
 * with their implementations.
 */
import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("vitest executes and resolves imports under strict tsconfig", () => {
    expect(true).toBe(true);
  });
});
