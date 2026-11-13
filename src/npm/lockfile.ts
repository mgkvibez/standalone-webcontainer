/**
 * `package-lock.json`, npm's format, version 3 (`packages` dictionary).
 *
 * The decision to reproduce npm's own format rather than invent one is recorded in ADR-0006 (D-18): the value
 * of running in a browser is parity with a local install, and a custom format would break that promise along
 * with every tool that reads lockfiles.
 *
 * **The subset.** We write only what this runtime reads back: `version`, `resolved`, `integrity`,
 * `dependencies`, and the `optional` flag. When *reading*, everything else is ignored rather than rejected,
 * because a lockfile produced by real npm carries license, engines, bin, dev, peerDependencies and more, and
 * refusing those would make the reader useless on the exact files we claim compatibility with.
 *
 * Writing a narrower file than npm does has one visible consequence worth stating: a lockfile written here and
 * then used by `npm ci` locally still pins versions correctly, but npm may rewrite it to add the fields it
 * normally records. That is a difference in bookkeeping, not in resolution.
 */

export const LOCKFILE_VERSION = 3;

export interface LockfilePackage {
  /** Absent only for a root entry that has no version, which npm also allows. */
  readonly version?: string;
  /** Tarball URL. */
  readonly resolved?: string;
  /** `sha512-<base64>`. */
  readonly integrity?: string;
  /** Dependency name to range, exactly as the package declared them. */
  readonly dependencies?: Record<string, string>;
  /** Written when the package was reached through an optionalDependencies edge. */
  readonly optional?: boolean;
  /**
   * The peer contract this package declares.
   *
   * Recorded because a lockfile that dropped it would describe a tree whose peers nobody checked, and because npm's own lockfiles carry it: the
   * reader already had to tolerate the field, so writing it costs nothing and makes a repeat install check the same contract the first one did.
   */
  readonly peerDependencies?: Record<string, string>;
  /** Per-peer metadata, so `optional: true` survives a round trip rather than turning a skippable peer into a fatal one. */
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
  /** npm's "this package declares an install script" flag, carried so a reinstall reports the same skipped scripts the first install did. */
  readonly hasInstallScript?: boolean;
  /**
   * npm records the platform fields of a published package. We never write them, because packages that cannot run
   * in a browser are filtered out before they reach the tree, but we must **read** them: a lockfile produced by a
   * local `npm install` contains every platform variant of esbuild, and without this the browser would download
   * darwin and linux binaries it can never execute.
   */
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  /** Root entry only. */
  readonly name?: string;
  readonly devDependencies?: Record<string, string>;
}

export interface Lockfile {
  readonly name?: string;
  readonly version?: string;
  readonly lockfileVersion: number;
  readonly requires?: boolean;
  /** Keys are install paths relative to the project root; the root itself is `""`. */
  readonly packages: Record<string, LockfilePackage>;
}

export class LockfileError extends Error {
  public readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "LockfileError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new LockfileError("INVALID_LOCKFILE", `${where}.${key} is not a string`);
  return value;
}

function stringArray(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new LockfileError("INVALID_LOCKFILE", `${where} is not an array of strings`);
  }
  return value as readonly string[];
}

function peerMeta(value: unknown, where: string): Record<string, { readonly optional?: boolean }> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new LockfileError("INVALID_LOCKFILE", `${where} is not an object`);
  const result: Record<string, { readonly optional?: boolean }> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) throw new LockfileError("INVALID_LOCKFILE", `${where}.${key} is not an object`);
    const optional = entry["optional"];
    if (optional !== undefined && typeof optional !== "boolean") {
      throw new LockfileError("INVALID_LOCKFILE", `${where}.${key}.optional is not a boolean`);
    }
    result[key] = optional === undefined ? {} : { optional };
  }
  return result;
}

function stringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new LockfileError("INVALID_LOCKFILE", `${where} is not an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new LockfileError("INVALID_LOCKFILE", `${where}.${key} is not a string`);
    result[key] = entry;
  }
  return result;
}

/**
 * Parse a lockfile, keeping the subset and ignoring the rest.
 *
 * A version other than 3 is refused by name rather than half-understood: v1 has no `packages` dictionary at all,
 * and silently treating it as empty would produce a lockfile that appears to install nothing.
 */
export function parseLockfile(text: string): Lockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LockfileError("UNPARSEABLE_LOCKFILE", detail);
  }

  if (!isRecord(parsed)) throw new LockfileError("INVALID_LOCKFILE", "top level is not an object");

  const version = parsed["lockfileVersion"];
  if (typeof version !== "number") {
    throw new LockfileError("INVALID_LOCKFILE", "lockfileVersion is missing or not a number");
  }
  if (version !== LOCKFILE_VERSION) {
    throw new LockfileError(
      "UNSUPPORTED_LOCKFILE_VERSION",
      `found lockfileVersion ${version}, this runtime reads and writes ${LOCKFILE_VERSION}`,
    );
  }

  const rawPackages = parsed["packages"];
  if (!isRecord(rawPackages)) throw new LockfileError("INVALID_LOCKFILE", "packages is missing or not an object");

  const packages: Record<string, LockfilePackage> = {};
  for (const [key, value] of Object.entries(rawPackages)) {
    if (!isRecord(value)) throw new LockfileError("INVALID_LOCKFILE", `packages["${key}"] is not an object`);
    const entry: {
      version?: string;
      resolved?: string;
      integrity?: string;
      dependencies?: Record<string, string>;
      optional?: boolean;
      name?: string;
      devDependencies?: Record<string, string>;
      os?: readonly string[];
      cpu?: readonly string[];
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
      hasInstallScript?: boolean;
    } = {};
    const version_ = optionalString(value, "version", `packages["${key}"]`);
    const resolved = optionalString(value, "resolved", `packages["${key}"]`);
    const integrity = optionalString(value, "integrity", `packages["${key}"]`);
    const name = optionalString(value, "name", `packages["${key}"]`);
    const dependencies = stringMap(value["dependencies"], `packages["${key}"].dependencies`);
    const devDependencies = stringMap(value["devDependencies"], `packages["${key}"].devDependencies`);
    const os = stringArray(value["os"], `packages["${key}"].os`);
    const cpu = stringArray(value["cpu"], `packages["${key}"].cpu`);
    const peerDependencies = stringMap(value["peerDependencies"], `packages["${key}"].peerDependencies`);
    const peerDependenciesMeta = peerMeta(value["peerDependenciesMeta"], `packages["${key}"].peerDependenciesMeta`);
    const hasInstallScript = value["hasInstallScript"];
    if (hasInstallScript !== undefined && typeof hasInstallScript !== "boolean") {
      throw new LockfileError("INVALID_LOCKFILE", `packages["${key}"].hasInstallScript is not a boolean`);
    }
    const optional = value["optional"];
    if (optional !== undefined && typeof optional !== "boolean") {
      throw new LockfileError("INVALID_LOCKFILE", `packages["${key}"].optional is not a boolean`);
    }
    // exactOptionalPropertyTypes: assign only what exists rather than writing keys as undefined.
    if (version_ !== undefined) entry.version = version_;
    if (resolved !== undefined) entry.resolved = resolved;
    if (integrity !== undefined) entry.integrity = integrity;
    if (name !== undefined) entry.name = name;
    if (dependencies !== undefined) entry.dependencies = dependencies;
    if (devDependencies !== undefined) entry.devDependencies = devDependencies;
    if (optional !== undefined) entry.optional = optional;
    if (os !== undefined) entry.os = os;
    if (cpu !== undefined) entry.cpu = cpu;
    if (peerDependencies !== undefined) entry.peerDependencies = peerDependencies;
    if (peerDependenciesMeta !== undefined) entry.peerDependenciesMeta = peerDependenciesMeta;
    if (hasInstallScript !== undefined) entry.hasInstallScript = hasInstallScript;
    packages[key] = entry;
  }

  const lockfile: { name?: string; version?: string; lockfileVersion: number; requires?: boolean; packages: Record<string, LockfilePackage> } = {
    lockfileVersion: LOCKFILE_VERSION,
    packages,
  };
  const name = optionalString(parsed, "name", "lockfile");
  const rootVersion = optionalString(parsed, "version", "lockfile");
  if (name !== undefined) lockfile.name = name;
  if (rootVersion !== undefined) lockfile.version = rootVersion;
  if (parsed["requires"] === true) lockfile.requires = true;
  return lockfile;
}

/** npm puts the root entry first; everything else is sorted so two identical trees serialise identically. */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  return a < b ? -1 : 1;
}

/**
 * Serialise deterministically: sorted keys, two-space indent, trailing newline.
 *
 * Determinism matters here beyond tidiness. A lockfile that reorders itself between runs produces spurious
 * diffs, and the fixture harness compares trees.
 */
export function serializeLockfile(lockfile: Lockfile): string {
  const keys = Object.keys(lockfile.packages).sort(compareKeys);
  const packages: Record<string, LockfilePackage> = {};
  for (const key of keys) {
    const entry = lockfile.packages[key];
    if (entry === undefined) continue;
    // Rebuild each entry in a fixed field order so the output does not depend on insertion order.
    const ordered: {
      name?: string;
      version?: string;
      resolved?: string;
      integrity?: string;
      optional?: boolean;
      hasInstallScript?: boolean;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
      devDependencies?: Record<string, string>;
    } = {};
    if (entry.name !== undefined) ordered.name = entry.name;
    if (entry.version !== undefined) ordered.version = entry.version;
    if (entry.resolved !== undefined) ordered.resolved = entry.resolved;
    if (entry.integrity !== undefined) ordered.integrity = entry.integrity;
    if (entry.optional !== undefined) ordered.optional = entry.optional;
    if (entry.hasInstallScript !== undefined) ordered.hasInstallScript = entry.hasInstallScript;
    if (entry.dependencies !== undefined) ordered.dependencies = sortMap(entry.dependencies);
    if (entry.peerDependencies !== undefined) ordered.peerDependencies = sortMap(entry.peerDependencies);
    if (entry.peerDependenciesMeta !== undefined) {
      ordered.peerDependenciesMeta = Object.fromEntries(
        Object.keys(entry.peerDependenciesMeta)
          .sort()
          .map((peer) => [peer, entry.peerDependenciesMeta?.[peer] ?? {}]),
      );
    }
    if (entry.devDependencies !== undefined) ordered.devDependencies = sortMap(entry.devDependencies);
    packages[key] = ordered;
  }

  const document: Record<string, unknown> = {};
  if (lockfile.name !== undefined) document["name"] = lockfile.name;
  if (lockfile.version !== undefined) document["version"] = lockfile.version;
  document["lockfileVersion"] = lockfile.lockfileVersion;
  document["requires"] = lockfile.requires ?? true;
  document["packages"] = packages;

  return `${JSON.stringify(document, null, 2)}\n`;
}

function sortMap(map: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/** Convert an absolute install path into the key form npm uses: relative, no leading or trailing slash. */
export function lockfileKey(root: string, absolutePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (absolutePath === normalizedRoot) return "";
  const prefix = `${normalizedRoot}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath.replace(/^\/+/, "");
}
