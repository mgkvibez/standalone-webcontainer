/**
 * A registry client backed by the validated corpus.
 *
 * This is an implementation of the installer's `RegistryClient`, not a second installer: the resolution queue, hoisting,
 * nesting, integrity verification and lockfile writing stay exactly where they were. Swapping the registry is the whole
 * integration, which is what keeps "install from a corpus" from quietly becoming "install, differently".
 *
 * Two modes, because there are two things worth proving and they are different claims:
 *
 * - `resolution` serves packuments built from the corpus, so version ranges resolve against a validated offline set.
 * - `pinned` refuses packument access outright. An install that succeeds in this mode succeeded because the lockfile
 *   already knew every identity, which is the only way to demonstrate determinism rather than assert it.
 *
 * Nothing here reads the network, touches the filesystem, or knows what a URL means beyond the corpus's own scheme. The
 * `https://corpus.invalid` origin is deliberate: `.invalid` is reserved and can never resolve, so a URL leaking out of
 * this module into a real fetch would fail rather than quietly reach the internet.
 */

import { computeIntegrity } from "../npm/digest.js";
import type { Packument, PackumentVersion, RegistryClient } from "../npm/install.js";
import { compareVersions } from "../npm/semver-range.js";
import {
  installablePackages,
  verifyCorpus,
  type CorpusEntry,
  type VerifiedCorpus,
} from "./corpus-manifest.js";

/** The origin every corpus tarball URL lives under. Reserved TLD: it cannot be resolved, by design. */
export const CORPUS_ORIGIN = "https://corpus.invalid";

export type CorpusMode = "resolution" | "pinned";

export type CorpusRegistryCode =
  | "INVALID_PACKAGE_NAME"
  | "PACKAGE_NOT_FOUND"
  | "TARBALL_NOT_FOUND"
  | "PACKUMENT_FORBIDDEN_IN_PINNED_MODE"
  | "INTEGRITY_MISMATCH"
  | "NO_CRYPTO";

export class CorpusRegistryError extends Error {
  public readonly code: CorpusRegistryCode;

  constructor(code: CorpusRegistryCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CorpusRegistryError";
    this.code = code;
  }
}

/** The tarball URL for an identity. Deterministic, and derived only from the identity itself. */
export function corpusTarballUrl(name: string, version: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return `${CORPUS_ORIGIN}/${name}/-/${base}-${version}.tgz`;
}

/**
 * Observable evidence, kept in separate buckets on purpose.
 *
 * "It installed" hides four different facts: which packuments were asked for, which tarballs were read, whether each
 * hash matched, and what was refused. Collapsing them into one counter would make the interesting failure (a packument
 * request in pinned mode) invisible.
 */
export interface CorpusEvidence {
  readonly packumentRequests: readonly string[];
  readonly packumentHits: readonly string[];
  readonly tarballReads: readonly { readonly name: string; readonly version: string; readonly url: string; readonly byteLength: number }[];
  readonly integrityChecks: readonly { readonly name: string; readonly version: string; readonly ok: boolean }[];
  readonly refusals: readonly { readonly code: CorpusRegistryCode; readonly subject: string }[];
}

export interface CorpusRegistryOptions {
  /** A corpus that has already been through `verifyCorpus`. Nothing here re-validates identity or layout. */
  readonly corpus: VerifiedCorpus;
  /** Reads a tarball by its corpus-relative path. Injected so this module owns no I/O. */
  readonly read: (tarballPath: string) => string | Uint8Array;
  readonly mode: CorpusMode;
  /**
   * Serves the negative namespace. False everywhere except the tests that exist to prove the negative namespace works:
   * an ordinary fixture-facing install must not be able to reach it even by name.
   */
  readonly allowNegative?: boolean;
}

const PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.*-]*$/;

function toBytes(raw: string | Uint8Array): Uint8Array {
  return typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
}

export class CorpusRegistry implements RegistryClient {
  readonly #byName = new Map<string, CorpusEntry[]>();
  readonly #byUrl = new Map<string, CorpusEntry>();
  readonly #read: (tarballPath: string) => string | Uint8Array;
  readonly #mode: CorpusMode;
  readonly #allowNegative: boolean;

  readonly #packumentRequests: string[] = [];
  readonly #packumentHits: string[] = [];
  readonly #tarballReads: { name: string; version: string; url: string; byteLength: number }[] = [];
  readonly #integrityChecks: { name: string; version: string; ok: boolean }[] = [];
  readonly #refusals: { code: CorpusRegistryCode; subject: string }[] = [];

  constructor(options: CorpusRegistryOptions) {
    this.#read = options.read;
    this.#mode = options.mode;
    this.#allowNegative = options.allowNegative === true;

    const reachable = this.#allowNegative
      ? options.corpus.packages.map((item) => item.entry)
      : installablePackages(options.corpus);

    for (const entry of reachable) {
      const list = this.#byName.get(entry.name);
      if (list === undefined) this.#byName.set(entry.name, [entry]);
      else list.push(entry);
      this.#byUrl.set(corpusTarballUrl(entry.name, entry.version), entry);
    }
  }

  get mode(): CorpusMode {
    return this.#mode;
  }

  /** A snapshot, deep enough that a caller cannot mutate the record of what happened. */
  evidence(): CorpusEvidence {
    return {
      packumentRequests: [...this.#packumentRequests],
      packumentHits: [...this.#packumentHits],
      tarballReads: this.#tarballReads.map((item) => ({ ...item })),
      integrityChecks: this.#integrityChecks.map((item) => ({ ...item })),
      refusals: this.#refusals.map((item) => ({ ...item })),
    };
  }

  async packument(name: string): Promise<Packument> {
    this.#packumentRequests.push(name);

    if (typeof name !== "string" || !PACKAGE_NAME_PATTERN.test(name)) {
      throw this.#refuse("INVALID_PACKAGE_NAME", String(name), `"${String(name)}" is not a scoped package name`);
    }

    if (this.#mode === "pinned") {
      // Not an oversight to be worked around: a packument request in pinned mode means the lockfile did not cover
      // this edge, and falling back to resolution would silently turn a pinned install into a resolved one.
      throw this.#refuse(
        "PACKUMENT_FORBIDDEN_IN_PINNED_MODE",
        name,
        `pinned mode does not serve packuments; ${name} is not covered by the lockfile`,
      );
    }

    const entries = this.#byName.get(name);
    if (entries === undefined || entries.length === 0) {
      if (name.startsWith("@corpus-broken/")) {
        throw this.#refuse("PACKAGE_NOT_FOUND", name, `${name} is reserved for negative tests and is not installable`);
      }
      throw this.#refuse("PACKAGE_NOT_FOUND", name, `the corpus does not publish ${name}`);
    }

    const versions: Record<string, PackumentVersion> = {};
    for (const entry of entries) {
      versions[entry.version] = {
        name: entry.name,
        version: entry.version,
        ...(entry.dependencies === undefined ? {} : { dependencies: { ...entry.dependencies } }),
        dist: { tarball: corpusTarballUrl(entry.name, entry.version), integrity: entry.integrity },
      };
    }
    const sorted = [...entries].sort((left, right) => compareVersions(left.version, right.version));
    const latest = sorted[sorted.length - 1];

    this.#packumentHits.push(name);
    return {
      name,
      ...(latest === undefined ? {} : { "dist-tags": { latest: latest.version } }),
      versions,
    };
  }

  async tarball(url: string): Promise<Uint8Array> {
    const entry = this.#byUrl.get(url);
    if (entry === undefined) {
      throw this.#refuse("TARBALL_NOT_FOUND", url, `no corpus package is served at ${url}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = toBytes(this.#read(entry.tarball));
    } catch {
      throw this.#refuse("TARBALL_NOT_FOUND", entry.tarball, `${entry.name}@${entry.version} has no readable tarball`);
    }

    // Verified here, before the installer ever sees the bytes. The installer verifies again against the advertised
    // digest; two independent checks because this one catches a corrupted corpus and that one catches a lying packument.
    const integrity = await computeIntegrity(bytes);
    if (integrity === null) {
      throw this.#refuse("NO_CRYPTO", entry.name, "this platform provides no crypto.subtle, so nothing can be verified");
    }
    const ok = integrity === entry.integrity;
    this.#integrityChecks.push({ name: entry.name, version: entry.version, ok });
    if (!ok) {
      throw this.#refuse(
        "INTEGRITY_MISMATCH",
        entry.name,
        `${entry.name}@${entry.version} bytes hash to ${integrity}, corpus records ${entry.integrity}`,
      );
    }

    this.#tarballReads.push({
      name: entry.name,
      version: entry.version,
      url,
      byteLength: bytes.byteLength,
    });
    return bytes;
  }

  #refuse(code: CorpusRegistryCode, subject: string, message: string): CorpusRegistryError {
    this.#refusals.push({ code, subject });
    return new CorpusRegistryError(code, message);
  }
}

/**
 * Validate, then build.
 *
 * The only sanctioned way to obtain a registry: `verifyCorpus` runs first, so a manifest that has drifted, a tarball
 * whose hash no longer matches, or a duplicated identity refuses here rather than becoming a confusing install failure.
 */
export async function loadCorpusRegistry(options: {
  readonly root: string;
  readonly manifestText: string;
  readonly mode: CorpusMode;
  readonly read: (path: string) => string | Uint8Array;
  readonly listFiles: (root: string) => readonly string[];
  readonly allowNegative?: boolean;
}): Promise<{ readonly registry: CorpusRegistry; readonly corpus: VerifiedCorpus }> {
  // `options.read` takes a corpus-relative path in both places, so the verifier's rooted paths are translated here
  // rather than forcing callers to know which of the two conventions a given helper uses.
  const base = options.root.endsWith("/") ? options.root : `${options.root}/`;
  const corpus = await verifyCorpus({
    root: options.root,
    manifestText: options.manifestText,
    read: (path) => options.read(path.startsWith(base) ? path.slice(base.length) : path),
    listFiles: options.listFiles,
  });
  return {
    corpus,
    registry: new CorpusRegistry({
      corpus,
      read: options.read,
      mode: options.mode,
      ...(options.allowNegative === undefined ? {} : { allowNegative: options.allowNegative }),
    }),
  };
}
