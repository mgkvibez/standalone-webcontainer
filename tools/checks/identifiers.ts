/**
 * ADR-0002 decision #8: "Harness-only flags must exist behind a build define absent from the shipping build, enforced by
 * a CI grep of src/ for forbidden identifiers."
 *
 * That check was specified and never written, which is the same as not having the decision. This is the check. It reads
 * source text rather than a compiled bundle so it cannot be defeated by a build step, and it scans `src/` only, because a
 * test may legitimately carry the switch it is asserting on.
 *
 * Executed as a CLI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Identifiers that must never appear in shipping source. Each is a switch that widens trust, so the shipping build has
 * no business containing the name at all.
 */
export const FORBIDDEN = [
  "dangerouslyAllowSameOrigin",
  "dangerouslyAllowUnsafeEval",
  "allowSameOrigin",
  "trustedSameOrigin",
  "skipOriginCheck",
] as const;

const BY_LENGTH = [...FORBIDDEN].sort((a, b) => b.length - a.length);

/** An inline opt-out for the one legitimate case: a comment explaining why the word is in the file. */
const ALLOW_MARKER = "guard-allow:";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
  readonly text: string;
}

export function scanSource(files: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, source] of files) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.includes(ALLOW_MARKER)) continue;
      // Longest identifier first, so one occurrence reports once: every short name here is a substring of a longer one.
      for (const identifier of BY_LENGTH) {
        // Leading boundary only. A trailing \\b is trivially bypassed by renaming the flag to `allowSameOriginByDefault`,
        // which is exactly the move a guard like this has to survive; the leading boundary still refuses `xallowSameOrigin`.
        if (new RegExp(`(?<![A-Za-z0-9_$])${identifier}`).test(line)) {
          violations.push({ file, line: i + 1, identifier, text: line.trim().slice(0, 120) });
          break;
        }
      }
    }
  }
  return violations;
}

export function collectSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) files.set(full, readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return files;
}
