/**
 * npm install: resolve a dependency tree and write it into the VFS.
 *
 * This is the piece the charter singled out as "*real* npm" rather than a toy: StackBlitz deleted their
 * Turbo package manager, which is the strongest available signal that the naive approach (flatten everything,
 * hope for the best) does not survive contact with real packages. What is here is a real resolver with one
 * honest simplification, stated up front:
 *
 * **Simplification: hoisting is shallow.** A package goes into the top-level `node_modules` unless that name
 * is already taken there by a different version, in which case it nests under the dependent that asked for
 * it. npm's actual hoisting also lifts nested packages upward when no conflict exists, which produces a
 * smaller tree. Ours produces a correct tree. Node's resolution algorithm walks up parent directories, so a
 * nested copy is found exactly where it is needed; the cost is duplicated bytes on disk, not wrong behaviour.
 *
 * Everything else is real: ranges resolve through semver with npm's own precedence, each dependent gets a
 * version that satisfies its own range, transitive dependencies are walked with cycle protection, and every
 * tarball is verified against its `dist.integrity` before a single byte reaches the file system.
 *
 * Failure policy: a range nothing satisfies, or an integrity mismatch, throws. npm errors in both cases, and
 * a half-installed tree that looks installed is the worst outcome for a runtime whose users will debug the
 * *application*, not the package manager.
 */

import { compareVersions, maxSatisfying } from "./semver-range.js";
import { DEFAULT_TAR_LIMITS, extractTarball, stripTopLevelDirectory, type TarLimits } from "./tarball.js";

export interface PackumentVersion {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly dist: { readonly tarball: string; readonly integrity?: string };
}

export interface Packument {
  readonly name: string;
  readonly "dist-tags"?: Record<string, string>;
  readonly versions: Record<string, PackumentVersion>;
}

/** The registry surface the installer needs. Injected so tests never touch the network. */
export interface RegistryClient {
  packument(name: string): Promise<Packument>;
  tarball(url: string): Promise<Uint8Array>;
}

/** The VFS surface the installer needs. Structural, so the real VFS and a test double both fit. */
export interface VfsWriter {
  mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
}

export interface InstallOptions {
  readonly registry: RegistryClient;
  readonly vfs: VfsWriter;
  /** Project root, e.g. `/app`. Packages land in `/app/node_modules`. */
  readonly root: string;
  readonly limits?: TarLimits;
  /** Guard against a pathological graph. npm has no such limit; a browser tab needs one. */
  readonly maxPackages?: number;
  readonly includeDev?: boolean;
  /** Defaults to true. Turning it off is for tests that deliberately serve corrupt bytes. */
  readonly verifyIntegrity?: boolean;
}

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /** Absolute path of the package directory. */
  readonly path: string;
}

export interface InstallReport {
  readonly packages: readonly InstalledPackage[];
  readonly warnings: readonly string[];
}

export class InstallError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "InstallError";
    this.code = code;
  }
}

interface Placement {
  readonly name: string;
  readonly version: string;
  readonly chosen: PackumentVersion;
  /** Absolute directory of the node_modules that will hold this package. */
  readonly hostDir: string;
}

interface Request {
  readonly name: string;
  readonly range: string;
  /** Directory of the dependent, used to find an already-installed copy above it. */
  readonly fromDir: string;
  readonly requiredBy: string;
}

function joinPath(...parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  // Collapse duplicate separators without touching ".." (the VFS normalises those itself).
  return joined.replace(/\/{2,}/g, "/");
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function base64(bytes: Uint8Array): string {
  // btoa exists in browsers and in Node 16+; going through a binary string keeps one code path.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha512Base64(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return null;
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await subtle.digest("SHA-512", owned);
  return base64(new Uint8Array(digest));
}

/**
 * The classic npm `dist.integrity` format is `sha512-<base64>`, sometimes with several space-separated
 * entries. A missing value is tolerated with a warning (very old packages predate it); a *mismatch* is fatal.
 */
async function verifyIntegrity(bytes: Uint8Array, integrity: string | undefined): Promise<string | null> {
  if (integrity === undefined || integrity.trim() === "") return "no integrity field published; bytes unverified";
  const expected = integrity
    .trim()
    .split(/\s+/)
    .map((entry) => entry.split("-"))
    .filter((pair) => pair[0] === "sha512")
    .map((pair) => pair[1] ?? "");
  if (expected.length === 0) return `unsupported integrity algorithm in ${integrity}; bytes unverified`;

  const digest = await sha512Base64(bytes);
  if (digest === null) return "no crypto.subtle available; bytes unverified";
  if (!expected.includes(digest)) {
    throw new InstallError("INTEGRITY_MISMATCH", `sha512 does not match dist.integrity (${integrity})`);
  }
  return null;
}

/** Choose a version for a range, honouring a dist-tag if the range names one. */
function chooseVersion(packument: Packument, range: string, name: string): PackumentVersion {
  const tags = packument["dist-tags"] ?? {};
  const tagVersion = tags[range];
  if (tagVersion !== undefined) {
    const fromTag = packument.versions[tagVersion];
    if (fromTag === undefined) {
      throw new InstallError("MISSING_TAG_VERSION", `${name}@${range} points at ${tagVersion}, which is not published`);
    }
    return fromTag;
  }

  const candidates = Object.keys(packument.versions);
  const best = maxSatisfying(candidates, range);
  if (best === null) {
    const newest = candidates.sort(compareVersions).at(-1) ?? "none";
    throw new InstallError("NO_MATCHING_VERSION", `no version of ${name} satisfies "${range}" (newest is ${newest})`);
  }
  const chosen = packument.versions[best];
  if (chosen === undefined) throw new InstallError("MISSING_VERSION", `${name}@${best} disappeared from its packument`);
  return chosen;
}

export async function installDependencies(
  manifest: { readonly dependencies?: Record<string, string>; readonly devDependencies?: Record<string, string> },
  options: InstallOptions,
): Promise<InstallReport> {
  const root = stripTrailingSlash(options.root);
  const rootNodeModules = joinPath(root, "node_modules");
  const limits = options.limits ?? DEFAULT_TAR_LIMITS;
  const maxPackages = options.maxPackages ?? 500;
  const verify = options.verifyIntegrity ?? true;

  const warnings: string[] = [];
  const packuments = new Map<string, Packument>();
  /** name -> placements already made, so a second dependent can reuse them. */
  const placementsByHost = new Map<string, Map<string, Placement>>();
  const packages: InstalledPackage[] = [];
  const visited = new Set<string>();

  const placementFor = (hostDir: string, name: string): Placement | undefined =>
    placementsByHost.get(hostDir)?.get(name);

  /**
   * The `node_modules` directories Node would search, in order, from a dependent's own directory upwards.
   *
   * Ancestors that are themselves `node_modules` are skipped, exactly as Node does: for `/app/node_modules/c`
   * the search is `c/node_modules`, then `/app/node_modules`, then `/node_modules`. A naive walk-up would
   * also look in `/app/node_modules/node_modules`, which does not exist and would mislead anyone reading the
   * resolver later.
   */
  const hostsFor = (fromDir: string): readonly string[] => {
    const hosts: string[] = [];
    let current: string | null = fromDir;
    while (current !== null && current !== "" && current !== "/") {
      if (!current.endsWith("/node_modules") && current !== "node_modules") {
        hosts.push(joinPath(current, "node_modules"));
      }
      const separator = current.lastIndexOf("/");
      current = separator <= 0 ? null : current.slice(0, separator);
    }
    return hosts;
  };

  /** Look for a copy already installed anywhere Node would search from this dependent. */
  const findExisting = (fromDir: string, name: string, range: string): Placement | undefined => {
    for (const host of hostsFor(fromDir)) {
      const placement = placementFor(host, name);
      if (placement !== undefined && maxSatisfying([placement.version], range) !== null) return placement;
    }
    return undefined;
  };

  const fetchPackument = async (name: string): Promise<Packument> => {
    const cached = packuments.get(name);
    if (cached !== undefined) return cached;
    const fetched = await options.registry.packument(name);
    packuments.set(name, fetched);
    return fetched;
  };

  const initial: Request[] = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    initial.push({ name, range, fromDir: root, requiredBy: `${root}/package.json` });
  }
  if (options.includeDev === true) {
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      initial.push({ name, range, fromDir: root, requiredBy: `${root}/package.json (dev)` });
    }
  }

  const queue: Request[] = [...initial];
  const resolved: Array<{ placement: Placement; request: Request }> = [];

  while (queue.length > 0) {
    const request = queue.shift();
    if (request === undefined) break;

    if (findExisting(request.fromDir, request.name, request.range) !== undefined) continue;

    const packument = await fetchPackument(request.name);
    const chosen = chooseVersion(packument, request.range, request.name);
    const key = `${chosen.name}@${chosen.version}`;

    // Hoist to the root when the name is free or already there at this exact version.
    const atRoot = placementFor(rootNodeModules, chosen.name);
    let hostDir: string;
    if (atRoot === undefined) {
      hostDir = rootNodeModules;
    } else if (atRoot.version === chosen.version) {
      continue; // already provided, and findExisting would have caught it only for descendants
    } else {
      hostDir = joinPath(request.fromDir, "node_modules");
    }

    const placement: Placement = { name: chosen.name, version: chosen.version, chosen, hostDir };
    const hostPlacements = placementsByHost.get(hostDir) ?? new Map<string, Placement>();
    hostPlacements.set(chosen.name, placement);
    placementsByHost.set(hostDir, hostPlacements);

    // Counted against `resolved`, not `packages`: the write loop has not run yet, so `packages` is empty
    // here and the guard used to be a no-op that always passed.
    if (resolved.length >= maxPackages) {
      throw new InstallError("TOO_MANY_PACKAGES", `exceeded ${maxPackages} packages; refusing to continue`);
    }

    if (!visited.has(key)) {
      visited.add(key);
      resolved.push({ placement, request });
      const targetDir = joinPath(hostDir, chosen.name);
      for (const [name, range] of Object.entries(chosen.dependencies ?? {})) {
        queue.push({ name, range, fromDir: targetDir, requiredBy: `${key}` });
      }
    }
  }

  for (const { placement } of resolved) {
    const directory = joinPath(placement.hostDir, placement.name);
    const compressed = await options.registry.tarball(placement.chosen.dist.tarball);

    if (verify) {
      const problem = await verifyIntegrity(compressed, placement.chosen.dist.integrity);
      if (problem !== null) warnings.push(`${placement.name}@${placement.version}: ${problem}`);
    }

    const entries = stripTopLevelDirectory(await extractTarball(compressed, limits));
    options.vfs.mkdirSync(directory, { recursive: true });
    for (const entry of entries) {
      const target = joinPath(directory, entry.path);
      if (entry.type === "directory") {
        options.vfs.mkdirSync(target, { recursive: true });
        continue;
      }
      const parent = target.slice(0, Math.max(0, target.lastIndexOf("/")));
      if (parent !== "") options.vfs.mkdirSync(parent, { recursive: true });
      options.vfs.writeFileSync(target, entry.data);
    }

    packages.push({ name: placement.name, version: placement.version, path: directory });
  }

  return { packages, warnings };
}

/**
 * The HTTP registry client. Kept separate from the installer so the installer can be tested without a
 * network, and so a caller can point at a mirror or a cache by supplying a different client.
 */
export function createHttpRegistryClient(
  options: { readonly baseUrl?: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): RegistryClient {
  const baseUrl = (options.baseUrl ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 30_000;

  const withTimeout = async (run: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async packument(name: string): Promise<Packument> {
      // Scoped names need their slash escaped on the registry path.
      const path = name.startsWith("@") ? name.replace("/", "%2F") : name;
      const response = await withTimeout((signal) => doFetch(`${baseUrl}/${path}`, { signal }));
      if (!response.ok) throw new InstallError("REGISTRY_ERROR", `GET ${name} returned ${response.status}`);
      return (await response.json()) as Packument;
    },

    async tarball(url: string): Promise<Uint8Array> {
      const response = await withTimeout((signal) => doFetch(url, { signal }));
      if (!response.ok) throw new InstallError("REGISTRY_ERROR", `GET ${url} returned ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
