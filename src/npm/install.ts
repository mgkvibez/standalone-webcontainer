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

import { VFSNotFoundError } from "../vfs/errors.js";

import {
  LOCKFILE_VERSION,
  lockfileKey,
  parseLockfile,
  serializeLockfile,
  type Lockfile,
  type LockfilePackage,
} from "./lockfile.js";
import { compareVersions, isRangeExpression, maxSatisfying } from "./semver-range.js";
import { DEFAULT_TAR_LIMITS, extractTarball, stripTopLevelDirectory, type TarLimits } from "./tarball.js";
import { computeIntegrity, sha512Base64 } from "./digest.js";
import { resolvedRange, substitutionFor, SubstitutionError, type SubstitutionUse } from "./substitutions.js";

export interface PackumentVersion {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  /**
   * Reached through an `optionalDependencies` edge. Kept because a failure here must be a warning, not an
   * error, which is what lets a package like `chokidar` install on a platform `fsevents` cannot serve.
   */
  readonly optionalDependencies?: Record<string, string>;
  /** npm's platform fields. A package that enumerates real operating systems cannot run in a browser. */
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
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
  /**
   * Where the bytes came from, for the line a user reads afterwards: "from the offline corpus" and "from registry.npmjs.org" are
   * very different claims about an install, and a single hard-coded sentence would be wrong for one of them.
   */
  readonly origin?: string;
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
  /**
   * A `package-lock.json` to install from. When a locked version still satisfies the manifest range it is used
   * directly: same version, same URL, same integrity, and no packument fetch at all.
   *
   * Nullable so `loadLockfile`'s result can be passed straight through: a project with no lockfile returns null,
   * which means "resolve normally" rather than being an error.
   */
  readonly lockfile?: Lockfile | null;
  /** Refuse any resolution not pinned by this lockfile (the `npm ci` contract). */
  readonly requireLockfile?: boolean;
  /** Write `package-lock.json` into `root` after a successful install. Defaults to true. */
  readonly writeLockfile?: boolean;
}

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /** Absolute path of the package directory. */
  readonly path: string;
}

/**
 * The parts of `package.json` this installer reads. Named rather than inline so the runtime facade, the fixture
 * runner and the tests all describe the same shape instead of three compatible-but-separate ones.
 */
export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

export interface InstallReport {
  readonly packages: readonly InstalledPackage[];
  readonly warnings: readonly string[];
  /** The lockfile describing what was installed, whether or not it was written to the VFS. */
  readonly lockfile: Lockfile;
  /**
   * True when the tree came from an existing lockfile rather than from registry resolution.
   *
   * Reported because `npm ci` is defined by refusing to run without one: a caller that wants ci semantics needs to
   * know whether a lockfile was actually used, and inferring it from "did anything get fetched" is guesswork.
   */
  readonly usedLockfile: boolean;
  /**
   * Every substitution this install applied, in the order it applied them.
   *
   * Empty is the ordinary answer. A non-empty list means the tree does not contain the package someone asked for, and a reader is
   * entitled to know that without diffing tarballs: the reason travels with the record.
   */
  readonly substitutions: readonly SubstitutionUse[];
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
  /** An `optionalDependencies` edge: failure is a warning, and a platform mismatch is expected. */
  readonly optional: boolean;
}

function joinPath(...parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  // Collapse duplicate separators without touching ".." (the VFS normalises those itself).
  return joined.replace(/\/{2,}/g, "/");
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
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

/** The only part of the VFS this module reads, kept structural so a caller can pass a reader of their own. */
export interface LockfileReader {
  readFileSync(path: string): string | Uint8Array;
}

/**
 * Read the project's `package-lock.json`, or null when it has none.
 *
 * Absence is normal (a fresh project has no lockfile), so it is not an error. A file that exists but cannot be
 * parsed *is* an error and is allowed to throw: silently reinstalling from the registry because the lockfile was
 * corrupt is exactly how a deterministic build stops being deterministic.
 *
 * Deliberately not called automatically by `installDependencies`. Installing from a lockfile is a decision about
 * the project's state, and D-20 keeps that decision with the caller rather than hidden in the installer.
 */
export function loadLockfile(vfs: LockfileReader, root: string): Lockfile | null {
  const path = joinPath(stripTrailingSlash(root), "package-lock.json");
  let contents: string | Uint8Array;
  try {
    contents = vfs.readFileSync(path);
  } catch (error) {
    if (error instanceof VFSNotFoundError) return null;
    throw error;
  }
  const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  return parseLockfile(text);
}

/**
 * Read `<root>/package.json`.
 *
 * The two failures are kept distinct because they need different fixes: a missing manifest means "wrong directory",
 * a malformed one means "fix the file". Collapsing them into one error is how a run reports "install failed" with no
 * indication of which.
 */
export function readPackageManifest(vfs: LockfileReader, root: string): PackageManifest {
  const path = joinPath(stripTrailingSlash(root), "package.json");
  let contents: string | Uint8Array;
  try {
    contents = vfs.readFileSync(path);
  } catch (error) {
    if (error instanceof VFSNotFoundError) {
      throw new InstallError("MISSING_PACKAGE_JSON", `no package.json at ${path}`);
    }
    throw error;
  }

  const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InstallError("INVALID_PACKAGE_JSON", `${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InstallError("INVALID_PACKAGE_JSON", `${path} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const manifest: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (typeof record["name"] === "string") manifest.name = record["name"];
  if (typeof record["version"] === "string") manifest.version = record["version"];
  const dependencies = dependencyMap(record["dependencies"], `${path}: dependencies`);
  if (dependencies !== undefined) manifest.dependencies = dependencies;
  const devDependencies = dependencyMap(record["devDependencies"], `${path}: devDependencies`);
  if (devDependencies !== undefined) manifest.devDependencies = devDependencies;
  return manifest;
}

/** A dependency map, rejecting non-string values rather than installing with `undefined` as a version. */
function dependencyMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallError("INVALID_PACKAGE_JSON", `${where} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec !== "string") {
      throw new InstallError("INVALID_PACKAGE_JSON", `${where}.${name} must be a string, got ${typeof spec}`);
    }
    result[name] = spec;
  }
  return result;
}

/**
 * Is this package runnable in a browser?
 *
 * npm's `os` and `cpu` fields enumerate the platforms a package supports. A package that lists real operating
 * systems is, by that declaration, not portable: `fsevents` is darwin-only, and esbuild's platform packages each
 * name one OS and one architecture because each contains a native binary. No browser appears in those lists and
 * none ever will, so a non-empty positive list without an entry we can honour means "cannot run here".
 *
 * Negations are read in npm's sense (`!win32` excludes, and a list of only negations is otherwise portable),
 * because treating `!win32` as a positive requirement would wrongly refuse packages that are fine.
 *
 * This matters beyond tidiness: every platform-specific optional dependency that survives resolution becomes a
 * failed fetch and a wasted install in a browser, and `@esbuild/darwin-x64` is a 10 MB tarball of bytes that
 * cannot execute.
 */
function isPlatformUsable(entry: { readonly os?: readonly string[]; readonly cpu?: readonly string[] }): boolean {
  const allows = (list: readonly string[] | undefined): boolean => {
    if (list === undefined || list.length === 0) return true;
    const positives = list.filter((value) => !value.startsWith("!"));
    const negatives = list.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
    if (negatives.includes("browser")) return false;
    return positives.length === 0 || positives.includes("browser");
  };
  return allows(entry.os) && allows(entry.cpu);
}

/**
 * Dependency specs that are not registry ranges.
 *
 * npm accepts local paths, git URLs, `workspace:` protocol references and `npm:` aliases. This installer resolves
 * only against a registry, and without this check those specs fell through to version resolution and failed as
 * `NO_MATCHING_VERSION ... (newest is 1.0.0)`, which reads like a versioning problem and sends the reader looking in
 * the wrong place. Naming the real limitation costs one function.
 *
 * `owner/repo` shorthand and relative paths are included because they are the two forms people actually type.
 */
function unsupportedSpecReason(range: string): string | null {
  const spec = range.trim();
  if (/(^|\/)(file|link|workspace|git|git\+https|github|gitlab|bitbucket|npm):/.test(spec)) {
    return `${spec} uses a protocol this installer does not resolve`;
  }
  if (spec.includes("://")) return `${spec} is a URL, not a registry range`;
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec.startsWith("~/")) {
    return `${spec} is a local path, and nothing outside the registry is fetched`;
  }
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(spec)) return `${spec} looks like a GitHub shorthand reference`;
  return null;
}


export async function installDependencies(
  manifest: PackageManifest,
  options: InstallOptions,
): Promise<InstallReport> {
  const root = stripTrailingSlash(options.root);
  const rootNodeModules = joinPath(root, "node_modules");
  const limits = options.limits ?? DEFAULT_TAR_LIMITS;
  const maxPackages = options.maxPackages ?? 500;
  const verify = options.verifyIntegrity ?? true;
  const writeLockfile = options.writeLockfile ?? true;
  const locked = options.lockfile ?? null;
  const requireLockfile = options.requireLockfile ?? false;

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

  /**
   * Where this request would install, and the lockfile key for that location.
   *
   * The decision is forced by the current state rather than guessed: `findExisting` has already failed, so an
   * existing root copy cannot serve this range, which means a nested copy is the only correct outcome.
   */
  const hostForKey = (request: Request): { hostDir: string; key: string } => {
    const atRoot = placementFor(rootNodeModules, request.name);
    const hostDir = atRoot === undefined ? rootNodeModules : joinPath(request.fromDir, "node_modules");
    return { hostDir, key: lockfileKey(root, joinPath(hostDir, request.name)) };
  };

  /** A locked version, when the lockfile still has something usable at this exact path. */
  const lockedVersionFor = (key: string, name: string, range: string): PackumentVersion | null => {
    const entry = locked?.packages[key];
    if (entry === undefined) return null;
    if (entry.version === undefined || entry.resolved === undefined) return null;
    // A parseable range the locked version fails means the manifest moved on, so re-resolve. A dist-tag such as
    // `latest` cannot be checked offline, and the lockfile is precisely the record of what it meant.
    if (isRangeExpression(range) && maxSatisfying([entry.version], range) === null) return null;
    return {
      name,
      version: entry.version,
      dist: { tarball: entry.resolved, ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }) },
      ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
      // Carried so the platform filter runs on locked entries as well. A lockfile from a local install lists every
      // OS variant of a package like esbuild, and those must be skipped exactly as a fresh resolution would skip them.
      ...(entry.os === undefined ? {} : { os: entry.os }),
      ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
    };
  };

  const initial: Request[] = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    initial.push({ name, range, fromDir: root, requiredBy: `${root}/package.json`, optional: false });
  }
  if (options.includeDev === true) {
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      initial.push({ name, range, fromDir: root, requiredBy: `${root}/package.json (dev)`, optional: false });
    }
  }

  const substitutions: SubstitutionUse[] = [];
  const queue: Request[] = [...initial];
  interface ResolvedEntry {
    readonly placement: Placement;
    readonly optional: boolean;
    readonly fromLock: boolean;
  }
  const resolved: ResolvedEntry[] = [];

  while (queue.length > 0) {
    const request = queue.shift();
    if (request === undefined) break;

    if (findExisting(request.fromDir, request.name, request.range) !== undefined) continue;

    const { hostDir, key } = hostForKey(request);

    try {
      let chosen = lockedVersionFor(key, request.name, request.range);
      const fromLock = chosen !== null;

      if (chosen === null) {
        if (requireLockfile) {
          throw new InstallError(
            "LOCKFILE_MISMATCH",
            `${request.name}@${request.range} is not pinned to a satisfying version at ${key}`,
          );
        }
        // Only checked when a registry resolve is actually about to happen: a lockfile pin already carries a concrete
        // tarball URL, so a project pinned from a local install still installs.
        const unsupported = unsupportedSpecReason(request.range);
        if (unsupported !== null) {
          throw new InstallError("UNSUPPORTED_SPEC", `${request.name}: ${unsupported}`);
        }

        const stale = locked?.packages[key];
        if (stale?.version !== undefined && isRangeExpression(request.range)) {
          warnings.push(
            `${request.name}: lockfile pins ${stale.version}, which does not satisfy "${request.range}"; re-resolved`,
          );
        }
        const substitution = substitutionFor(request.name);
        // Only the substitute's packument is fetched. Asking for the requested package's versions first would be a wasted round trip,
        // and on the offline lanes it would be a guaranteed miss for a package whose bytes are never served anyway.
        const lookupName = substitution?.substitute ?? request.name;
        const packument = await fetchPackument(lookupName);
        const range = substitution === undefined ? request.range : resolvedRange(substitution, request.range);
        try {
          chosen = chooseVersion(packument, range, lookupName);
        } catch (error) {
          // A substitution that cannot honour the caller's range is a broken table, not a version conflict in the user's project.
          if (substitution === undefined) throw error;
          throw new SubstitutionError(
            "SUBSTITUTE_NO_MATCH",
            `${substitution.substitute} has no version satisfying "${request.range}" (rule "${substitution.rule}"), which ${request.name}@${request.range} needs`,
          );
        }
        if (substitution !== undefined) {
          substitutions.push({
            requested: substitution.requested,
            substitute: substitution.substitute,
            rule: substitution.rule,
            requestedRange: request.range,
            version: chosen.version,
            reason: substitution.reason,
            ...(substitution.initHook === undefined ? {} : { initHook: substitution.initHook }),
          });
          warnings.push(
            `${request.name}@${request.range} is served by ${substitution.substitute}@${chosen.version}: ${substitution.reason}`,
          );
          // The tree keeps the requested name, because Node resolves by directory: a caller writing `require('esbuild')` looks in
          // node_modules/esbuild and must find the substitute there. The substitute's own package.json still says what it is.
          chosen = { ...chosen, name: request.name };
        }
      }

      // Applied to the chosen version regardless of where it came from, because a lockfile written by a local
      // install carries the same platform packages a fresh resolution would produce.
      //
      // Optionality comes from the lockfile entry when there is one: npm records `optional: true` on the entry, and
      // the edge that reached it may well be a plain dependency (esbuild lists its platform packages under
      // optionalDependencies, but a reinstall walks whatever the lockfile says).
      const optionalEntry = request.optional || locked?.packages[key]?.optional === true;
      if (!isPlatformUsable(chosen)) {
        if (optionalEntry) {
          warnings.push(`${chosen.name}@${chosen.version} skipped: platform-specific (${describePlatform(chosen)})`);
          continue;
        }
        throw new InstallError(
          "PLATFORM_UNSUPPORTED",
          `${chosen.name}@${chosen.version} supports ${describePlatform(chosen)}, which cannot run in a browser`,
        );
      }

      const existingAtRoot = placementFor(rootNodeModules, chosen.name);
      if (existingAtRoot?.version === chosen.version) continue;

      const placement: Placement = { name: chosen.name, version: chosen.version, chosen, hostDir };
      const hostPlacements = placementsByHost.get(hostDir) ?? new Map<string, Placement>();
      hostPlacements.set(chosen.name, placement);
      placementsByHost.set(hostDir, hostPlacements);

      // Counted against `resolved`, not `packages`: the write loop has not run yet, so `packages` is empty
      // here and the guard used to be a no-op that always passed.
      if (resolved.length >= maxPackages) {
        throw new InstallError("TOO_MANY_PACKAGES", `exceeded ${maxPackages} packages; refusing to continue`);
      }

      // Every placement gets written, and `visited` only decides whether to walk this package's own edges again.
      // Conflating the two was a real bug: two dependents that each need their own nested copy of the same version
      // produced one directory, and the second dependent required a path that was never created. Duplicated bytes
      // are exactly what D-15 accepts in exchange for isolation, so duplicates must actually be written.
      resolved.push({ placement, optional: request.optional, fromLock });

      const identifier = `${chosen.name}@${chosen.version}`;
      if (!visited.has(identifier)) {
        visited.add(identifier);

        const targetDir = joinPath(hostDir, chosen.name);
        // An entry with no `dependencies` means a package with none: that is npm's meaning, and it is what makes a
        // reinstall offline. An earlier version fell back to fetching the packument "just for the edges", which
        // then fired for every leaf package and defeated the point of having a lockfile at all.
        for (const [name, range] of Object.entries(chosen.dependencies ?? {})) {
          queue.push({ name, range, fromDir: targetDir, requiredBy: identifier, optional: false });
        }

        // Optional edges are only discovered from the registry. With a lockfile the tree is already fixed, so
        // re-walking optional edges would install packages the lockfile deliberately does not contain.
        if (!fromLock) {
          for (const [name, range] of Object.entries(chosen.optionalDependencies ?? {})) {
            queue.push({ name, range, fromDir: targetDir, requiredBy: identifier, optional: true });
          }
        }
      }
    } catch (error) {
      if (request.optional) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`${request.name} skipped (optional, required by ${request.requiredBy}): ${detail}`);
        continue;
      }
      throw error;
    }
  }

  interface WrittenEntry extends ResolvedEntry {
    readonly integrity: string | null;
  }
  const written: WrittenEntry[] = [];

  for (const entry of resolved) {
    const { placement } = entry;
    const directory = joinPath(placement.hostDir, placement.name);
    const compressed = await options.registry.tarball(placement.chosen.dist.tarball);

    if (verify) {
      const problem = await verifyIntegrity(compressed, placement.chosen.dist.integrity);
      if (problem !== null) warnings.push(`${placement.name}@${placement.version}: ${problem}`);
    }
    // Every lockfile entry gets an integrity value, including for packages that publish none: a lockfile without
    // one cannot verify anything the next time it is used.
    const integrity = placement.chosen.dist.integrity ?? (await computeIntegrity(compressed));

    const entries = stripTopLevelDirectory(await extractTarball(compressed, limits));
    options.vfs.mkdirSync(directory, { recursive: true });
    for (const file of entries) {
      const target = joinPath(directory, file.path);
      if (file.type === "directory") {
        options.vfs.mkdirSync(target, { recursive: true });
        continue;
      }
      const parent = target.slice(0, Math.max(0, target.lastIndexOf("/")));
      if (parent !== "") options.vfs.mkdirSync(parent, { recursive: true });
      options.vfs.writeFileSync(target, file.data);
    }

    packages.push({ name: placement.name, version: placement.version, path: directory });
    written.push({ ...entry, integrity });
  }

  const lockPackages: Record<string, LockfilePackage> = {};
  const rootEntry: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (manifest.name !== undefined) rootEntry.name = manifest.name;
  if (manifest.version !== undefined) rootEntry.version = manifest.version;
  // Bound to locals: narrowing `manifest.dependencies ?? {}` does not narrow the property itself.
  const rootDependencies = manifest.dependencies;
  if (rootDependencies !== undefined && Object.keys(rootDependencies).length > 0) rootEntry.dependencies = rootDependencies;
  const rootDevDependencies = manifest.devDependencies;
  if (options.includeDev === true && rootDevDependencies !== undefined && Object.keys(rootDevDependencies).length > 0) {
    rootEntry.devDependencies = rootDevDependencies;
  }
  lockPackages[""] = rootEntry;

  for (const entry of written) {
    const { placement } = entry;
    const key = lockfileKey(root, joinPath(placement.hostDir, placement.name));
    const lockedEntry: {
      version?: string;
      resolved?: string;
      integrity?: string;
      dependencies?: Record<string, string>;
      optional?: boolean;
    } = { version: placement.version, resolved: placement.chosen.dist.tarball };
    if (entry.integrity !== null) lockedEntry.integrity = entry.integrity;
    const declared = placement.chosen.dependencies;
    if (declared !== undefined && Object.keys(declared).length > 0) lockedEntry.dependencies = declared;
    // Only recorded for packages actually reached through an optional edge, which is what npm means by it.
    if (entry.optional) lockedEntry.optional = true;
    lockPackages[key] = lockedEntry;
  }

  const lockfile: Lockfile = {
    ...(manifest.name === undefined ? {} : { name: manifest.name }),
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    lockfileVersion: LOCKFILE_VERSION,
    requires: true,
    packages: lockPackages,
  };

  if (writeLockfile) {
    options.vfs.writeFileSync(joinPath(root, "package-lock.json"), serializeLockfile(lockfile));
  }

  return { packages, warnings, lockfile, usedLockfile: locked !== null, substitutions };
}

/** Human-readable platform description, used in the messages that refuse or skip a package. */
function describePlatform(entry: { readonly os?: readonly string[]; readonly cpu?: readonly string[] }): string {
  const os = entry.os === undefined || entry.os.length === 0 ? "any os" : entry.os.join("/");
  const cpu = entry.cpu === undefined || entry.cpu.length === 0 ? "any cpu" : entry.cpu.join("/");
  return `${os}, ${cpu}`;
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
    origin: new URL(baseUrl).host,
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
