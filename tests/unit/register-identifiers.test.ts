/**
 * The register's identifiers are unique, and one of them keeps its meaning.
 *
 * `docs/audit/remaining-work.md` is the project's list of open work, and its rows are cited by id from ADRs, commit messages and
 * reports. Two rows sharing an id makes every citation ambiguous, and ambiguity in a register is worse than a wrong row: it
 * reads as one settled item. That had already happened here, where W-22 meant both the quarantined payload benchmark and an
 * uncomputed gate percentage until 2026-11-13.
 *
 * A one-off edit fixes today. This test is what stops it happening again, and the second case is what makes the fix durable:
 * renumbering is allowed, silently swapping two meanings is not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REGISTER = fileURLToPath(new URL("../../docs/audit/remaining-work.md", import.meta.url));

/**
 * A row is a table line whose first cell is an id. References in prose are deliberately not counted: an id exists once, and
 * citing it elsewhere is expected.
 */
interface Row {
  readonly id: string;
  readonly text: string;
}

const rows = (markdown: string): readonly Row[] =>
  markdown
    .split("\n")
    .flatMap((line) => {
      const match = /^\|\s*(W-\d+)\s*\|/u.exec(line);
      return match === null ? [] : [{ id: match[1] ?? "", text: line }];
    });

const register = rows(readFileSync(REGISTER, "utf8"));

describe("the remaining-work register", () => {
  it("parses its rows, so a table format change cannot make these checks vacuous", () => {
    // The register is the project's list of open work; a handful of rows would mean the parse broke, not that the work closed.
    expect(register.length).toBeGreaterThan(20);
    for (const row of register) expect(row.id).toMatch(/^W-\d+$/u);
  });

  it("defines each id exactly once", () => {
    const seen = new Map<string, number>();
    for (const row of register) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicates, `ids defined more than once: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("keeps W-22 pointed at the quarantined payload benchmark", () => {
    // The duplicate was corrected by renumbering the OTHER row. If this ever fails, two items have been swapped rather than
    // disambiguated, and every ADR or commit that cites W-22 now describes the wrong thing.
    const row = register.find((candidate) => candidate.id === "W-22");
    expect(row, "W-22 is missing from the register").toBeDefined();
    expect(row?.text).toContain("bench-scaling.spec.ts");
    expect(row?.text).toContain("SWC_BENCH=1");
  });
});
