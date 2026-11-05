/**
 * The corpus registry as a `RegistryClient`.
 *
 * The installation path itself is exercised in tests/integration/corpus.install.test.ts; what is proved here is the
 * client's contract in isolation: which modes serve what, which refusals are typed, that evidence is recorded in
 * separate buckets, and that no operation reaches the network even when it fails.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CORPUS_ROOT } from "../../tools/corpus.js";
import { computeIntegrity } from "../../src/npm/digest.js";
import {
  CORPUS_ORIGIN,
  CorpusRegistry,
  CorpusRegistryError,
  corpusTarballUrl,
  loadCorpusRegistry,
} from "../../src/registry/corpus.js";
import { verifyCorpus, type VerifiedCorpus } from "../../src/registry/corpus-manifest.js";
import { makePackageTarball } from "../helpers/tarball.js";

const root = process.cwd();
const corpusRoot = join(root, CORPUS_ROOT);

function listFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else out.push(relative(directory, absolute).split("\\").join("/"));
    }
  };
  walk(directory);
  return out;
}

const manifestText = readFileSync(join(corpusRoot, "manifest.json"), "utf8");
/** Reads by corpus-relative path, which is the convention both `loadCorpusRegistry` and `CorpusRegistry` use. */
const readCorpus = (path: string): Uint8Array => new Uint8Array(readFileSync(join(corpusRoot, path)));

const verified = await verifyCorpus({
  root: CORPUS_ROOT,
  manifestText,
  read: (path) => readFileSync(join(root, path)),
  listFiles: (path) => listFiles(join(root, path)),
});

/**
 * The sanctioned production path. Every registry in this file is built by loading and verifying a corpus, because the
 * constructor is private: a test that wants a purpose-built corpus gets one by verifying real bytes, not by skipping.
 */
const registryFor = async (
  mode: "resolution" | "pinned",
  extra: { allowNegative?: boolean } = {},
): Promise<CorpusRegistry> =>
  (
    await loadCorpusRegistry({
      root: CORPUS_ROOT,
      manifestText,
      mode,
      read: readCorpus,
      listFiles: () => listFiles(corpusRoot),
      ...extra,
    })
  ).registry;

async function expectRegistryError(run: () => Promise<unknown>, code: string): Promise<CorpusRegistryError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusRegistryError);
    expect((error as CorpusRegistryError).code).toBe(code);
    return error as CorpusRegistryError;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

/**
 * A purpose-built corpus, built the same way production builds one: real tarball bytes, a manifest, then verification.
 * Nothing here is exempt from validation, which is the point of sealing the constructor.
 */
async function fabricatedRegistry(
  packages: readonly { name: string; version: string; dependencies?: Record<string, string> }[],
): Promise<{ registry: CorpusRegistry; corrupt: () => void }> {
  const files = new Map<string, Uint8Array>();
  const entries = [];
  for (const item of packages) {
    const bytes = makePackageTarball(
      { "index.js": "module.exports = 1;\n" },
      {
        name: item.name,
        version: item.version,
        main: "index.js",
        ...(item.dependencies === undefined ? {} : { dependencies: item.dependencies }),
      },
    );
    const integrity = await computeIntegrity(bytes);
    if (integrity === null) throw new Error("no crypto");
    const tarball = `${item.name}/${item.version}.tgz`;
    files.set(tarball, new Uint8Array(bytes));
    entries.push({
      name: item.name,
      version: item.version,
      tarball,
      integrity,
      negative: item.name.startsWith("@corpus-broken/"),
      contents: ["package.json", "index.js"],
      ...(item.dependencies === undefined ? {} : { dependencies: item.dependencies }),
      main: "index.js",
    });
  }

  // The reader can be corrupted after verification, which is exactly what the registry's own integrity check exists to
  // catch: the corpus was intact at load and the bytes are not intact now.
  let corrupted = false;
  const read = (path: string): Uint8Array => {
    if (corrupted) return new Uint8Array([1, 2, 3]);
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT ${path}`);
    return bytes;
  };

  const loaded = await loadCorpusRegistry({
    root: "corpus",
    manifestText: JSON.stringify({ formatVersion: 1, packages: entries }, null, 2),
    mode: "resolution",
    read,
    listFiles: () => [...files.keys()],
  });
  return { registry: loaded.registry, corrupt: () => (corrupted = true) };
}

describe("CorpusRegistry in resolution mode", () => {
  it("serves every published version of a name, with dist-tags pointing at the highest", async () => {
    const registry = await registryFor("resolution");
    const packument = await registry.packument("@corpus/leaf");

    expect(Object.keys(packument.versions).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(packument["dist-tags"]).toEqual({ latest: "2.0.0" });

    const entry = verified.packages.find((item) => item.entry.name === "@corpus/leaf" && item.entry.version === "2.0.0");
    expect(packument.versions["2.0.0"]?.dist.integrity).toBe(entry?.entry.integrity);
    expect(packument.versions["2.0.0"]?.dist.tarball).toBe(corpusTarballUrl("@corpus/leaf", "2.0.0"));
  });

  it("carries dependencies through, so resolution can walk an edge", async () => {
    const registry = await registryFor("resolution");
    const packument = await registry.packument("@corpus/chain");
    expect(packument.versions["1.0.0"]?.dependencies).toEqual({ "@corpus/leaf": "^1.0.0" });
  });

  it("records the request and the hit separately", async () => {
    const registry = await registryFor("resolution");
    await registry.packument("@corpus/deep");
    const evidence = registry.evidence();
    expect(evidence.packumentRequests).toEqual(["@corpus/deep"]);
    expect(evidence.packumentHits).toEqual(["@corpus/deep"]);
    expect(evidence.refusals).toEqual([]);
  });

  it("serves tarball bytes that hash to the recorded integrity, and says so", async () => {
    const registry = await registryFor("resolution");
    const bytes = await registry.tarball(corpusTarballUrl("@corpus/leaf", "1.0.0"));
    const committed = readFileSync(join(corpusRoot, "@corpus/leaf/1.0.0.tgz"));
    expect(Buffer.from(bytes).equals(committed)).toBe(true);

    const evidence = registry.evidence();
    expect(evidence.tarballReads).toEqual([
      {
        name: "@corpus/leaf",
        version: "1.0.0",
        url: corpusTarballUrl("@corpus/leaf", "1.0.0"),
        byteLength: bytes.byteLength,
      },
    ]);
    expect(evidence.integrityChecks).toEqual([{ name: "@corpus/leaf", version: "1.0.0", ok: true }]);
  });
});

describe("CorpusRegistry in pinned mode", () => {
  it("refuses packument access by name, rather than resolving quietly", async () => {
    const registry = await registryFor("pinned");
    const error = await expectRegistryError(() => registry.packument("@corpus/leaf"), "PACKUMENT_FORBIDDEN_IN_PINNED_MODE");
    expect(error.message).toContain("lockfile");
    expect(registry.evidence().refusals).toEqual([
      { code: "PACKUMENT_FORBIDDEN_IN_PINNED_MODE", subject: "@corpus/leaf" },
    ]);
  });

  it("still serves tarballs by URL, which is all a pinned install needs", async () => {
    const registry = await registryFor("pinned");
    const bytes = await registry.tarball(corpusTarballUrl("@corpus/chain", "1.0.0"));
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(registry.evidence().packumentRequests).toEqual([]);
  });
});

describe("typed refusals", () => {
  it("refuses an unknown package with PACKAGE_NOT_FOUND", async () => {
    const registry = await registryFor("resolution");
    const error = await expectRegistryError(() => registry.packument("@corpus/absent"), "PACKAGE_NOT_FOUND");
    expect(error.message).toContain("@corpus/absent");
    expect(registry.evidence().refusals[0]?.code).toBe("PACKAGE_NOT_FOUND");
  });

  it("refuses a malformed name with INVALID_PACKAGE_NAME", async () => {
    const registry = await registryFor("resolution");
    for (const bad of ["leaf", "@corpus", "@corpus/", "../@corpus/leaf", "is-odd"]) {
      await expectRegistryError(() => registry.packument(bad), "INVALID_PACKAGE_NAME");
    }
  });

  it("refuses an unknown tarball URL with TARBALL_NOT_FOUND", async () => {
    const registry = await registryFor("resolution");
    await expectRegistryError(
      () => registry.tarball("https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz"),
      "TARBALL_NOT_FOUND",
    );
  });

  it("refuses bytes that do not match the corpus integrity before serving them", async () => {
    const { registry, corrupt } = await fabricatedRegistry([{ name: "@corpus/leaf", version: "1.0.0" }]);
    corrupt();
    await expectRegistryError(() => registry.tarball(corpusTarballUrl("@corpus/leaf", "1.0.0")), "INTEGRITY_MISMATCH");
    expect(registry.evidence().integrityChecks).toEqual([{ name: "@corpus/leaf", version: "1.0.0", ok: false }]);
    expect(registry.evidence().tarballReads).toEqual([]);
  });
});

describe("the negative namespace", () => {
  it("is unreachable by name when the registry is built the ordinary way", async () => {
    const registry = await registryFor("resolution");
    const error = await expectRegistryError(
      () => registry.packument("@corpus-broken/missing-edge"),
      "PACKAGE_NOT_FOUND",
    );
    expect(error.message).toContain("negative tests");

    // And by URL, which is the other way in.
    await expectRegistryError(
      () => registry.tarball(corpusTarballUrl("@corpus-broken/missing-edge", "1.0.0")),
      "TARBALL_NOT_FOUND",
    );
  });

  it("becomes reachable only when a test asks for it explicitly", async () => {
    const registry = await registryFor("resolution", { allowNegative: true });
    const packument = await registry.packument("@corpus-broken/missing-edge");
    expect(packument.versions["1.0.0"]?.dependencies).toEqual({ "@corpus/absent": "^1.0.0" });
  });
});

describe("validation before use", () => {
  it("refuses a manifest with a duplicated identity instead of building a registry", async () => {
    const document = JSON.parse(manifestText) as { packages: unknown[] };
    document.packages.push(document.packages[0]);
    await expect(
      loadCorpusRegistry({
        root: CORPUS_ROOT,
        manifestText: JSON.stringify(document),
        mode: "resolution",
        read: readCorpus,
        listFiles: () => listFiles(corpusRoot),
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PACKAGE" });
  });

  it("builds a working registry from the committed corpus when it is valid", async () => {
    const loaded = await loadCorpusRegistry({
      root: CORPUS_ROOT,
      manifestText,
      mode: "resolution",
      read: readCorpus,
      listFiles: () => listFiles(corpusRoot),
    });
    expect(loaded.corpus.packages).toHaveLength(10);
    const bytes = await loaded.registry.tarball(corpusTarballUrl("@corpus/esm", "1.0.0"));
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("no network fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls fetch, including when a package is missing", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const registry = await registryFor("resolution");
    await registry.packument("@corpus/chain");
    await registry.tarball(corpusTarballUrl("@corpus/chain", "1.0.0"));
    await expectRegistryError(() => registry.packument("@corpus/absent"), "PACKAGE_NOT_FOUND");
    await expectRegistryError(() => registry.tarball(`${CORPUS_ORIGIN}/@corpus/absent/1.0.0.tgz`), "TARBALL_NOT_FOUND");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CORPUS_ORIGIN.endsWith(".invalid")).toBe(true);
  });
});

describe("the construction boundary", () => {
  /** A corpus that satisfies the interface and has never been near a verifier. */
  const forged = (): VerifiedCorpus =>
    ({ manifest: { formatVersion: 1, packages: [] }, packages: [], unlisted: [] }) as VerifiedCorpus;

  it("refuses a corpus whose shape matches but which verification never minted", () => {
    expect(() =>
      CorpusRegistry.fromVerifiedCorpus({ corpus: forged(), read: () => new Uint8Array(), mode: "resolution" }),
    ).toThrowError(/UNVERIFIED_CORPUS/);
  });

  it("refuses even when a caller casts around the private modifier", () => {
    // `private` is compile-time only, so the runtime check is what a production caller actually meets.
    const Forged = CorpusRegistry as unknown as new (options: unknown) => unknown;
    expect(() => new Forged({ corpus: forged(), read: () => new Uint8Array(), mode: "resolution" })).toThrowError(
      /UNVERIFIED_CORPUS/,
    );
  });

  it("accepts only what verification produced, and carries no forgeable marker in its JSON", async () => {
    const loaded = await loadCorpusRegistry({
      root: CORPUS_ROOT,
      manifestText,
      mode: "resolution",
      read: readCorpus,
      listFiles: () => listFiles(corpusRoot),
    });
    expect(loaded.registry).toBeInstanceOf(CorpusRegistry);
    expect(await loaded.registry.packument("@corpus/leaf")).toMatchObject({ name: "@corpus/leaf" });

    // Non-enumerable, so a serialised corpus cannot be edited into a verified one.
    expect(JSON.stringify(loaded.corpus)).not.toContain("corpus.verified");
    const roundTripped = JSON.parse(JSON.stringify(loaded.corpus)) as VerifiedCorpus;
    expect(() =>
      CorpusRegistry.fromVerifiedCorpus({ corpus: roundTripped, read: readCorpus, mode: "resolution" }),
    ).toThrowError(/UNVERIFIED_CORPUS/);
  });

  it("yields no registry at all when the corpus fails validation", async () => {
    const document = JSON.parse(manifestText) as { packages: unknown[] };
    document.packages.push(document.packages[0]);
    let built: CorpusRegistry | undefined;
    await expect(
      (async () => {
        built = (
          await loadCorpusRegistry({
            root: CORPUS_ROOT,
            manifestText: JSON.stringify(document),
            mode: "resolution",
            read: readCorpus,
            listFiles: () => listFiles(corpusRoot),
          })
        ).registry;
      })(),
    ).rejects.toMatchObject({ code: "DUPLICATE_PACKAGE" });
    expect(built).toBeUndefined();
  });
});
