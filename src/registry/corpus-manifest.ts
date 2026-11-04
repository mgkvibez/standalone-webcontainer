/**
 * The corpus manifest: its contract, and the validation that has to pass before anything is installed from it.
 *
 * The manifest is a committed artifact, which means it can rot in ways a generated file cannot: a tarball replaced
 * without updating its hash, a package deleted but still listed, a stray `.tgz` left behind by an experiment, two
 * entries claiming the same identity. Every one of those turns into a confusing install failure hours later, so they
 * are all refused here, at load, by name.
 *
 * Validation is split in two on purpose. `parseCorpusManifest` is synchronous and structural: it never touches bytes and
 * can run in any environment. `verifyCorpus` hashes the committed tarballs and compares archive contents, which needs
 * bytes and `crypto.subtle`. A caller that only needs metadata can use the first; anything that installs must use both.
 */

import { extractTarball, stripTopLevelDirectory } from "../npm/tarball.js";
import { computeIntegrity } from "../npm/digest.js";

/** The only manifest version this module understands. An unknown number is refused, never guessed at. */
export const CORPUS_FORMAT_VERSION = 1;

/** Normal-test namespace. */
export const CORPUS_NAMESPACE = "@corpus";

/** Negative-test namespace. Not installable by fixtures; exists so corruption can be tested without touching normal ones. */
export const CORPUS_NEGATIVE_NAMESPACE = "@corpus-broken";

export type CorpusErrorCode =
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_FORMAT"
  | "DUPLICATE_PACKAGE"
  | "MISSING_TARBALL"
  | "UNEXPECTED_FILE"
  | "INTEGRITY_MISMATCH"
  | "NAMESPACE_POLICY"
  | "ARCHIVE_MISMATCH";

export class CorpusError extends Error {
  public readonly code: CorpusErrorCode;

  constructor(code: CorpusErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CorpusError";
    this.code = code;
  }
}

export interface CorpusEntry {
  readonly name: string;
  readonly version: string;
  /** Path relative to the corpus root, always `<name>/<version>.tgz`. */
  readonly tarball: string;
  /** `sha512-<base64>` of the committed tarball bytes. */
  readonly integrity: string;
  /** True only for `@corpus-broken/*`. */
  readonly negative: boolean;
  /** Package-relative paths the archive is expected to contain, `package.json` included. Omitted only for a deliberately malformed archive. */
  readonly contents?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly main?: string;
  readonly type?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly exports?: unknown;
}

export interface CorpusManifest {
  readonly formatVersion: number;
  readonly packages: readonly CorpusEntry[];
}

const NAME_PATTERN = /^@corpus(-broken)?\/[a-z0-9][a-z0-9.*-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CorpusError("INVALID_MANIFEST", `${where} must be a non-empty string`);
  }
  return value;
}

function optionalStringRecord(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CorpusError("INVALID_MANIFEST", `${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new CorpusError("INVALID_MANIFEST", `${where}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

/** A path that cannot escape the corpus root, has no backslashes and is not absolute. */
function assertSafeRelativePath(path: string, where: string): void {
  if (path.startsWith("/") || path.includes("\\")) {
    throw new CorpusError("INVALID_MANIFEST", `${where} must be a relative POSIX path, got ${path}`);
  }
  for (const segment of path.split("/")) {
    if (segment === ".." || segment === "." || segment === "") {
      throw new CorpusError("INVALID_MANIFEST", `${where} must not contain "${segment}" segments: ${path}`);
    }
  }
}

function parseEntry(value: unknown, index: number): CorpusEntry {
  const where = `packages[${index}]`;
  if (!isRecord(value)) throw new CorpusError("INVALID_MANIFEST", `${where} must be an object`);

  const name = requireString(value["name"], `${where}.name`);
  if (!NAME_PATTERN.test(name)) {
    throw new CorpusError(
      "INVALID_MANIFEST",
      `${where}.name "${name}" is not a corpus package name (expected @corpus/... or @corpus-broken/...)`,
    );
  }

  const version = requireString(value["version"], `${where}.version`);
  if (!VERSION_PATTERN.test(version)) {
    throw new CorpusError("INVALID_MANIFEST", `${where}.version "${version}" is not an exact x.y.z version`);
  }

  const tarball = requireString(value["tarball"], `${where}.tarball`);
  assertSafeRelativePath(tarball, `${where}.tarball`);
  const expectedPath = `${name}/${version}.tgz`;
  if (tarball !== expectedPath) {
    throw new CorpusError(
      "INVALID_MANIFEST",
      `${where}.tarball is "${tarball}" but ${name}@${version} must live at "${expectedPath}"`,
    );
  }

  const integrity = requireString(value["integrity"], `${where}.integrity`);
  if (!INTEGRITY_PATTERN.test(integrity)) {
    throw new CorpusError("INVALID_MANIFEST", `${where}.integrity is not a sha512 base64 digest: ${integrity}`);
  }

  const negative = value["negative"];
  if (typeof negative !== "boolean") {
    throw new CorpusError("INVALID_MANIFEST", `${where}.negative must be a boolean`);
  }
  const inNegativeNamespace = name.startsWith(`${CORPUS_NEGATIVE_NAMESPACE}/`);
  if (negative !== inNegativeNamespace) {
    throw new CorpusError(
      "NAMESPACE_POLICY",
      negative
        ? `${where} "${name}" is marked negative but is not in ${CORPUS_NEGATIVE_NAMESPACE}/`
        : `${where} "${name}" is in the negative namespace but is not marked negative`,
    );
  }

  let contents: readonly string[] | undefined;
  if (value["contents"] !== undefined) {
    const raw = value["contents"];
    if (!Array.isArray(raw)) throw new CorpusError("INVALID_MANIFEST", `${where}.contents must be an array`);
    const seen = new Set<string>();
    for (const item of raw) {
      const path = requireString(item, `${where}.contents[]`);
      assertSafeRelativePath(path, `${where}.contents[]`);
      if (seen.has(path)) throw new CorpusError("INVALID_MANIFEST", `${where}.contents lists ${path} twice`);
      seen.add(path);
    }
    if (!seen.has("package.json")) {
      throw new CorpusError("INVALID_MANIFEST", `${where}.contents must include package.json`);
    }
    contents = raw as readonly string[];
  }

  const main = value["main"] === undefined ? undefined : requireString(value["main"], `${where}.main`);
  const dependencies =
    value["dependencies"] === undefined ? undefined : optionalStringRecord(value["dependencies"], `${where}.dependencies`);
  const type = value["type"] === undefined ? undefined : requireString(value["type"], `${where}.type`);
  const bin = value["bin"];
  if (bin !== undefined && typeof bin !== "string" && !isRecord(bin)) {
    throw new CorpusError("INVALID_MANIFEST", `${where}.bin must be a string or an object`);
  }

  return {
    name,
    version,
    tarball,
    integrity,
    negative,
    ...(contents === undefined ? {} : { contents }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(main === undefined ? {} : { main }),
    ...(type === undefined ? {} : { type }),
    ...(bin === undefined ? {} : { bin: bin as string | Readonly<Record<string, string>> }),
    ...(value["exports"] === undefined ? {} : { exports: value["exports"] }),
  };
}

/**
 * Structural validation. No bytes are read: this answers "is this a well-formed corpus manifest", not "is the corpus
 * intact". Throws `CorpusError` on the first problem, naming the package and field.
 */
export function parseCorpusManifest(text: string): CorpusManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CorpusError("INVALID_MANIFEST", `manifest is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new CorpusError("INVALID_MANIFEST", "manifest must be a JSON object");

  const version = parsed["formatVersion"];
  if (typeof version !== "number") throw new CorpusError("INVALID_MANIFEST", "formatVersion must be a number");
  if (version !== CORPUS_FORMAT_VERSION) {
    throw new CorpusError(
      "UNSUPPORTED_FORMAT",
      `found formatVersion ${version}, this runtime reads ${CORPUS_FORMAT_VERSION}`,
    );
  }

  const rawPackages = parsed["packages"];
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    throw new CorpusError("INVALID_MANIFEST", "packages must be a non-empty array");
  }

  const packages = rawPackages.map(parseEntry);
  const identities = new Set<string>();
  const tarballs = new Set<string>();
  for (const entry of packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (identities.has(identity)) {
      throw new CorpusError("DUPLICATE_PACKAGE", `${identity} appears more than once in the manifest`);
    }
    identities.add(identity);
    if (tarballs.has(entry.tarball)) {
      throw new CorpusError("DUPLICATE_PACKAGE", `${entry.tarball} is claimed by more than one package`);
    }
    tarballs.add(entry.tarball);
  }

  return { formatVersion: version, packages };
}

export interface VerifiedPackage {
  readonly entry: CorpusEntry;
  readonly byteLength: number;
  /** Re-computed from the committed bytes, which must equal `entry.integrity`. */
  readonly integrity: string;
}

export interface VerifiedCorpus {
  readonly manifest: CorpusManifest;
  readonly packages: readonly VerifiedPackage[];
  /** Paths under the corpus root that the manifest does not mention, relative to it. */
  readonly unlisted: readonly string[];
}

function joinPath(root: string, relative: string): string {
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${trimmed}/${relative}`;
}

/**
 * Full validation: structure, then every tarball's bytes.
 *
 * Checks, in the order that gives the clearest error: identity and layout (from `parseCorpusManifest`), then that each
 * listed tarball exists, then that its bytes hash to the recorded integrity, then that its archive holds exactly the
 * declared files. Finally, anything on disk the manifest does not mention is reported rather than ignored, because an
 * unlisted `.tgz` in a committed corpus is either a forgotten artifact or a tampering, and both want a human.
 */
export async function verifyCorpus(options: {
  readonly root: string;
  readonly manifestText: string;
  readonly read: (path: string) => string | Uint8Array;
  readonly listFiles: (root: string) => readonly string[];
}): Promise<VerifiedCorpus> {
  const manifest = parseCorpusManifest(options.manifestText);
  const verified: VerifiedPackage[] = [];

  for (const entry of manifest.packages) {
    const path = joinPath(options.root, entry.tarball);
    let raw: string | Uint8Array;
    try {
      raw = options.read(path);
    } catch {
      throw new CorpusError("MISSING_TARBALL", `${entry.name}@${entry.version} is listed but ${entry.tarball} is absent`);
    }
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;

    const integrity = await computeIntegrity(bytes);
    if (integrity === null) {
      throw new CorpusError(
        "INTEGRITY_MISMATCH",
        `cannot verify ${entry.name}@${entry.version}: this platform provides no crypto.subtle`,
      );
    }
    if (integrity !== entry.integrity) {
      throw new CorpusError(
        "INTEGRITY_MISMATCH",
        `${entry.name}@${entry.version}: bytes hash to ${integrity}, manifest records ${entry.integrity}`,
      );
    }

    if (entry.contents !== undefined) {
      const entries = stripTopLevelDirectory(await extractTarball(bytes));
      const files = entries
        .filter((item) => item.type === "file")
        .map((item) => item.path)
        .sort();
      const declared = [...entry.contents].sort();
      if (files.length !== declared.length || files.some((file, index) => file !== declared[index])) {
        const extra = files.filter((file) => !declared.includes(file));
        const missing = declared.filter((file) => !files.includes(file));
        throw new CorpusError(
          "ARCHIVE_MISMATCH",
          `${entry.name}@${entry.version}: archive holds [${files.join(", ")}], manifest declares [${declared.join(", ")}]` +
            `${extra.length > 0 ? ` (unexpected: ${extra.join(", ")})` : ""}` +
            `${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`,
        );
      }
    }

    verified.push({ entry, byteLength: bytes.byteLength, integrity });
  }

  const listed = new Set(manifest.packages.map((entry) => entry.tarball));
  const unlisted = options
    .listFiles(options.root)
    .filter((path) => path.endsWith(".tgz") && !listed.has(path))
    .sort();
  if (unlisted.length > 0) {
    throw new CorpusError("UNEXPECTED_FILE", `corpus holds tarballs the manifest does not list: ${unlisted.join(", ")}`);
  }

  return { manifest, packages: verified, unlisted };
}

/** The entries a fixture is allowed to reach. Negative packages are excluded structurally, not by convention. */
export function installablePackages(corpus: VerifiedCorpus): readonly CorpusEntry[] {
  return corpus.packages.map((item) => item.entry).filter((entry) => !entry.negative);
}
