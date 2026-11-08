/**
 * The charter's licence allowlist, enforced instead of remembered: "every dependency MIT/Apache-2.0/BSD/ISC; verify the
 * licence before adding".
 *
 * Two distinctions matter and both are easy to get wrong. A runtime package's licence ships in the product, while a
 * dev-only package's licence only affects this repo, so the audit reports them separately and only the runtime list is
 * fatal. And "runtime" means reachable from the root's dependencies through the lockfile, not "is a direct dependency":
 * a transitive package pulled in by a runtime dependency ships exactly as much as the dependency itself does.
 *
 * Library only. The CLI lives in licences.ts, per this repo's rule that an imported module never performs I/O on import.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The charter's allowlist, spelled out rather than pattern-matched, so an odd string like "MIT*" cannot slip through. */
export const ALLOWED: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

/** Packages allowed despite an off-list licence, with the reason. Empty by intent: justify every entry added. */
export const EXCEPTIONS: ReadonlyMap<string, string> = new Map([]);

export interface LockPackage {
  readonly version?: string;
  readonly license?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface Lockfile {
  readonly packages?: Readonly<Record<string, LockPackage>>;
}

export interface Finding {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface Audit {
  readonly runtime: readonly Finding[];
  readonly devOnly: readonly Finding[];
  readonly scanned: number;
}

/** Top-level install folders, scoped names included, exactly as the lockfile spells them. Nested copies are skipped. */
export function topLevelFolders(lock: Lockfile): string[] {
  return Object.keys(lock.packages ?? {})
    .filter((key) => key.startsWith("node_modules/"))
    .filter((key) => !key.slice("node_modules/".length).includes("node_modules/"))
    .map((key) => key.slice("node_modules/".length));
}

const dependencyNames = (entry: LockPackage | undefined): string[] => [
  ...Object.keys(entry?.dependencies ?? {}),
  ...Object.keys(entry?.optionalDependencies ?? {}),
];

/**
 * Resolve one dependency name to a lockfile key, preferring the copy nested under the requiring package and falling back
 * to the hoisted top-level copy, which is the order Node itself resolves in.
 */
function resolveKey(lock: Lockfile, name: string, fromKey: string): string | undefined {
  const nested = `${fromKey}/node_modules/${name}`;
  if (lock.packages?.[nested] !== undefined) return nested;
  const hoisted = `node_modules/${name}`;
  return lock.packages?.[hoisted] !== undefined ? hoisted : undefined;
}

/** Every package reachable from the root's runtime dependencies. */
export function runtimeClosure(lock: Lockfile): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = dependencyNames(lock.packages?.[""]).map((name) => resolveKey(lock, name, ""));
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    for (const name of dependencyNames(lock.packages?.[key])) {
      const next = resolveKey(lock, name, key);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Read a licence from an installed manifest; the lockfile does not always carry the field. */
export function licenceOf(folder: string): string {
  const manifest = join("node_modules", folder, "package.json");
  if (!existsSync(manifest)) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      license?: string | { type?: string };
      licenses?: readonly { type?: string }[];
    };
    if (typeof parsed.license === "string") return parsed.license;
    if (parsed.license && typeof parsed.license === "object" && parsed.license.type) return parsed.license.type;
    const legacy = parsed.licenses?.[0]?.type;
    return legacy ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function isAllowed(license: string, folder: string): boolean {
  return ALLOWED.has(license) || EXCEPTIONS.has(folder);
}

/**
 * `manifestReader` is injected so the audit can be exercised against a synthetic lockfile, with no node_modules and no
 * network, which is the only way a licence gate can itself be tested.
 */
export function auditLockfile(
  lock: Lockfile,
  manifestReader: (folder: string) => string = licenceOf,
): Audit {
  const runtimeKeys = runtimeClosure(lock);
  const runtime: Finding[] = [];
  const devOnly: Finding[] = [];

  for (const folder of topLevelFolders(lock)) {
    const key = `node_modules/${folder}`;
    const entry = lock.packages?.[key];
    const license = entry?.license ?? manifestReader(folder);
    if (isAllowed(license, folder)) continue;
    const finding: Finding = { name: folder, version: entry?.version ?? "?", license };
    if (runtimeKeys.has(key)) runtime.push(finding);
    else devOnly.push(finding);
  }

  return { runtime, devOnly, scanned: topLevelFolders(lock).length };
}
