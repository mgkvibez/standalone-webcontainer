/**
 * The snapshot lane: real tarballs, frozen, pinned by integrity, served with no network.
 *
 * This is the third of the three registry lanes and the one that makes CI hermetic without making it dishonest:
 *
 * - the **corpus** (`@corpus/*`) is synthetic and is for unit tests only, because a synthetic `vite` proves nothing about `vite`;
 * - the **network** lane is the product path and reaches `registry.npmjs.org` at run time;
 * - a **snapshot** is a directory of real `.tgz` bytes captured once, with the exact resolutions the capture produced. The fixture
 *   lane runs against it, so a compatibility verdict is about real package bytes and does not depend on a registry being up, on a
 *   version not having been republished, or on the network being reachable in a sandbox.
 *
 * A snapshot is deliberately **not** a mirror. It holds the versions an install actually resolved, so a range that would pick a
 * newer version tomorrow cannot silently change what the gate measures. Asking for a package the snapshot does not hold is a named
 * error, never a fallback to the network: a fallback would make "hermetic" a claim nobody could check.
 */

import { computeIntegrity } from "../npm/digest.js";
import type { Packument, PackumentVersion, RegistryClient } from "../npm/install.js";
import { compareVersions } from "../npm/semver-range.js";

export interface SnapshotEntry {
  readonly version: string;
  /** `sha512-<base64>`, as npm records it. Verified again when the bytes are served. */
  readonly integrity: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  /** Path to the committed tarball, relative to the snapshot directory. */
  readonly tarball: string;
}

export interface SnapshotManifest {
  /** Bumped when the on-disk shape changes; a reader refuses a version it does not know. */
  readonly formatVersion: 1;
  /** The registry the bytes were captured from, so provenance travels with the snapshot. */
  readonly source: string;
  readonly capturedAt: string;
  /** The specs that were installed to produce this snapshot, for a human reading it later. */
  readonly requested: readonly string[];
  /** Package name to every version this snapshot holds, in the order the capture resolved them. */
  readonly packages: Record<string, readonly SnapshotEntry[]>;
}

export const SNAPSHOT_FORMAT_VERSION = 1;

export class SnapshotError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SnapshotError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringMap = (value: unknown, field: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SnapshotError("SNAPSHOT_INVALID", `${field} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new SnapshotError("SNAPSHOT_INVALID", `${field}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
};

const stringList = (value: unknown, field: string): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SnapshotError("SNAPSHOT_INVALID", `${field} must be an array of strings`);
  }
  return value as readonly string[];
};

/**
 * Validates a parsed `snapshot.json`.
 *
 * Every field is checked rather than trusted, because a snapshot is committed data that a future change can corrupt, and the
 * failure a caller sees should name the field rather than surface later as a package that mysteriously does not resolve.
 */
export function parseSnapshotManifest(value: unknown): SnapshotManifest {
  if (!isRecord(value)) throw new SnapshotError("SNAPSHOT_INVALID", "snapshot.json must be an object");
  if (value["formatVersion"] !== SNAPSHOT_FORMAT_VERSION) {
    throw new SnapshotError(
      "SNAPSHOT_INVALID",
      `unsupported formatVersion ${String(value["formatVersion"])}, this reader understands ${SNAPSHOT_FORMAT_VERSION}`,
    );
  }
  if (typeof value["source"] !== "string" || value["source"] === "") {
    throw new SnapshotError("SNAPSHOT_INVALID", "source must be a non-empty string");
  }
  if (typeof value["capturedAt"] !== "string") throw new SnapshotError("SNAPSHOT_INVALID", "capturedAt must be a string");
  const requested = stringList(value["requested"], "requested");
  if (requested === undefined) throw new SnapshotError("SNAPSHOT_INVALID", "requested must be present");
  if (!isRecord(value["packages"])) throw new SnapshotError("SNAPSHOT_INVALID", "packages must be an object");

  const packages: Record<string, readonly SnapshotEntry[]> = {};
  for (const [name, rawVersions] of Object.entries(value["packages"])) {
    if (!Array.isArray(rawVersions) || rawVersions.length === 0) {
      throw new SnapshotError("SNAPSHOT_INVALID", `packages["${name}"] must be a non-empty array of versions`);
    }
    const seen = new Set<string>();
    const versions: SnapshotEntry[] = rawVersions.map((raw, index) => {
      if (!isRecord(raw)) throw new SnapshotError("SNAPSHOT_INVALID", `packages["${name}"][${index}] must be an object`);
      const version = raw["version"];
      if (typeof version !== "string" || version === "") {
        throw new SnapshotError("SNAPSHOT_INVALID", `packages["${name}"][${index}].version must be a non-empty string`);
      }
      if (seen.has(version)) throw new SnapshotError("SNAPSHOT_INVALID", `${name}@${version} appears twice`);
      seen.add(version);
      const integrity = raw["integrity"];
      if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
        throw new SnapshotError("SNAPSHOT_INVALID", `${name}@${version} must carry a sha512 integrity`);
      }
      const tarball = raw["tarball"];
      if (typeof tarball !== "string" || tarball === "" || tarball.startsWith("/") || tarball.includes("..")) {
        throw new SnapshotError("SNAPSHOT_INVALID", `${name}@${version} tarball must be a relative path inside the snapshot`);
      }
      const dependencies = stringMap(raw["dependencies"], `${name}@${version}.dependencies`);
      const optionalDependencies = stringMap(raw["optionalDependencies"], `${name}@${version}.optionalDependencies`);
      const os = stringList(raw["os"], `${name}@${version}.os`);
      const cpu = stringList(raw["cpu"], `${name}@${version}.cpu`);
      const entry: SnapshotEntry = {
        version,
        integrity,
        tarball,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
        ...(os === undefined ? {} : { os }),
        ...(cpu === undefined ? {} : { cpu }),
      };
      return entry;
    });
    packages[name] = versions;
  }

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    source: value["source"],
    capturedAt: value["capturedAt"] as string,
    requested,
    packages,
  };
}

/** The highest version a snapshot holds for a name, which is what `latest` means once the set is frozen. */
const latestOf = (entries: readonly SnapshotEntry[]): SnapshotEntry =>
  entries.reduce((best, entry) => (compareVersions(entry.version, best.version) > 0 ? entry : best), entries[0] as SnapshotEntry);

/**
 * Serves a snapshot through the installer's `RegistryClient` contract.
 *
 * Two things it does that a simple file reader would not: it synthesises a packument from the frozen set (so `latest` means the
 * newest version *in the snapshot*, not on the registry), and it re-verifies sha512 on every tarball it hands out, because a
 * corrupted checkout must fail as an integrity error rather than install wrong bytes.
 */
export class SnapshotRegistry implements RegistryClient {
  readonly origin: string;
  readonly #manifest: SnapshotManifest;
  readonly #read: (path: string) => string | Uint8Array;
  readonly #base: string;

  constructor(options: {
    readonly slug: string;
    readonly manifest: SnapshotManifest;
    readonly read: (path: string) => string | Uint8Array;
    /** Directory the manifest's relative paths are resolved against. Trailing slash optional. */
    readonly root: string;
  }) {
    this.origin = `snapshot "${options.slug}" (${options.manifest.packages === undefined ? 0 : Object.keys(options.manifest.packages).length} pinned packages)`;
    this.#manifest = options.manifest;
    this.#read = options.read;
    this.#base = options.root.endsWith("/") ? options.root : `${options.root}/`;
  }

  get manifest(): SnapshotManifest {
    return this.#manifest;
  }

  get packageCount(): number {
    return Object.keys(this.#manifest.packages).length;
  }

  #versions(name: string): readonly SnapshotEntry[] {
    const entries = this.#manifest.packages[name];
    if (entries === undefined) {
      throw new SnapshotError(
        "SNAPSHOT_MISSING",
        `${name} is not in this snapshot. A snapshot holds only the versions an install resolved; rebuild it with ` +
          "`npm run snapshot:build` rather than falling back to the network, which would make the lane non-hermetic.",
      );
    }
    return entries;
  }

  async packument(name: string): Promise<Packument> {
    const entries = this.#versions(name);
    const versions: Record<string, PackumentVersion> = {};
    for (const entry of entries) {
      const version: PackumentVersion = {
        name,
        version: entry.version,
        dist: { tarball: entry.tarball, integrity: entry.integrity },
        ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
        ...(entry.optionalDependencies === undefined ? {} : { optionalDependencies: entry.optionalDependencies }),
        ...(entry.os === undefined ? {} : { os: entry.os }),
        ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
      };
      versions[entry.version] = version;
    }
    const latest = latestOf(entries);
    return { name, "dist-tags": { latest: latest.version }, versions };
  }

  async tarball(url: string): Promise<Uint8Array> {
    const path = url.replace(/^\.\//, "");
    const entry = this.#entryFor(path);
    const raw = this.#read(`${this.#base}${path}`);
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
    const actual = await computeIntegrity(bytes);
    if (actual === null) {
      // Serving unverified bytes from a lane whose whole purpose is reproducibility would make the guarantee unfalsifiable.
      throw new SnapshotError("SNAPSHOT_INTEGRITY", "no crypto.subtle is available to verify this snapshot's tarballs");
    }
    if (actual !== entry.integrity) {
      throw new SnapshotError(
        "SNAPSHOT_INTEGRITY",
        `${entry.tarball} does not match its pinned integrity. Expected ${entry.integrity}, computed ${actual}. ` +
          "The committed bytes and the manifest disagree, so neither can be trusted.",
      );
    }
    return bytes;
  }

  #entryFor(path: string): SnapshotEntry {
    for (const entries of Object.values(this.#manifest.packages)) {
      for (const entry of entries) {
        if (entry.tarball === path) return entry;
      }
    }
    throw new SnapshotError("SNAPSHOT_MISSING", `${path} is not described by this snapshot's manifest`);
  }
}

/** Reads a snapshot from a directory, validating the manifest before anything is served. */
export function loadSnapshotRegistry(options: {
  readonly slug: string;
  readonly root: string;
  readonly manifestText: string;
  readonly read: (path: string) => string | Uint8Array;
}): SnapshotRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.manifestText);
  } catch (error) {
    throw new SnapshotError("SNAPSHOT_INVALID", `snapshot.json is not valid JSON: ${(error as Error).message}`);
  }
  return new SnapshotRegistry({
    slug: options.slug,
    manifest: parseSnapshotManifest(parsed),
    read: options.read,
    root: options.root,
  });
}
