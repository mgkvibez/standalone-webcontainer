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

const registryFor = (mode: "resolution" | "pinned", extra: { allowNegative?: boolean } = {}): CorpusRegistry =>
  new CorpusRegistry({ corpus: verified, read: readCorpus, mode, ...extra });

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

/** A throwaway corpus, for cases the committed one is not shaped for. */
async function fabricated(
  packages: readonly { name: string; version: string; dependencies?: Record<string, string>; tamper?: boolean }[],
): Promise<{ corpus: VerifiedCorpus; read: (path: string) => Uint8Array }> {
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
      entry: {
        name: item.name,
        version: item.version,
        tarball,
        integrity,
        negative: item.name.startsWith("@corpus-broken/"),
        contents: ["package.json", "index.js"],
        ...(item.dependencies === undefined ? {} : { dependencies: item.dependencies }),
        main: "index.js",
      },
      byteLength: bytes.byteLength,
      integrity,
    });
  }
  return {
    corpus: { manifest: { formatVersion: 1, packages: entries.map((item) => item.entry) }, packages: entries, unlisted: [] },
    read: (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`ENOENT ${path}`);
      return bytes;
    },
  };
}

describe("CorpusRegistry in resolution mode", () => {
  it("serves every published version of a name, with dist-tags pointing at the highest", async () => {
    const registry = registryFor("resolution");
    const packument = await registry.packument("@corpus/leaf");

    expect(Object.keys(packument.versions).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(packument["dist-tags"]).toEqual({ latest: "2.0.0" });

    const entry = verified.packages.find((item) => item.entry.name === "@corpus/leaf" && item.entry.version === "2.0.0");
    expect(packument.versions["2.0.0"]?.dist.integrity).toBe(entry?.entry.integrity);
    expect(packument.versions["2.0.0"]?.dist.tarball).toBe(corpusTarballUrl("@corpus/leaf", "2.0.0"));
  });

  it("carries dependencies through, so resolution can walk an edge", async () => {
    const registry = registryFor("resolution");
    const packument = await registry.packument("@corpus/chain");
    expect(packument.versions["1.0.0"]?.dependencies).toEqual({ "@corpus/leaf": "^1.0.0" });
  });

  it("records the request and the hit separately", async () => {
    const registry = registryFor("resolution");
    await registry.packument("@corpus/deep");
    const evidence = registry.evidence();
    expect(evidence.packumentRequests).toEqual(["@corpus/deep"]);
    expect(evidence.packumentHits).toEqual(["@corpus/deep"]);
    expect(evidence.refusals).toEqual([]);
  });

  it("serves tarball bytes that hash to the recorded integrity, and says so", async () => {
    const registry = registryFor("resolution");
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
    const registry = registryFor("pinned");
    const error = await expectRegistryError(() => registry.packument("@corpus/leaf"), "PACKUMENT_FORBIDDEN_IN_PINNED_MODE");
    expect(error.message).toContain("lockfile");
    expect(registry.evidence().refusals).toEqual([
      { code: "PACKUMENT_FORBIDDEN_IN_PINNED_MODE", subject: "@corpus/leaf" },
    ]);
  });

  it("still serves tarballs by URL, which is all a pinned install needs", async () => {
    const registry = registryFor("pinned");
    const bytes = await registry.tarball(corpusTarballUrl("@corpus/chain", "1.0.0"));
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(registry.evidence().packumentRequests).toEqual([]);
  });
});

describe("typed refusals", () => {
  it("refuses an unknown package with PACKAGE_NOT_FOUND", async () => {
    const registry = registryFor("resolution");
    const error = await expectRegistryError(() => registry.packument("@corpus/absent"), "PACKAGE_NOT_FOUND");
    expect(error.message).toContain("@corpus/absent");
    expect(registry.evidence().refusals[0]?.code).toBe("PACKAGE_NOT_FOUND");
  });

  it("refuses a malformed name with INVALID_PACKAGE_NAME", async () => {
    const registry = registryFor("resolution");
    for (const bad of ["leaf", "@corpus", "@corpus/", "../@corpus/leaf", "is-odd"]) {
      await expectRegistryError(() => registry.packument(bad), "INVALID_PACKAGE_NAME");
    }
  });

  it("refuses an unknown tarball URL with TARBALL_NOT_FOUND", async () => {
    const registry = registryFor("resolution");
    await expectRegistryError(
      () => registry.tarball("https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz"),
      "TARBALL_NOT_FOUND",
    );
  });

  it("refuses bytes that do not match the corpus integrity before serving them", async () => {
    const built = await fabricated([{ name: "@corpus/leaf", version: "1.0.0" }]);
    const registry = new CorpusRegistry({
      corpus: built.corpus,
      mode: "resolution",
      read: () => new Uint8Array([1, 2, 3]),
    });
    await expectRegistryError(() => registry.tarball(corpusTarballUrl("@corpus/leaf", "1.0.0")), "INTEGRITY_MISMATCH");
    expect(registry.evidence().integrityChecks).toEqual([{ name: "@corpus/leaf", version: "1.0.0", ok: false }]);
    expect(registry.evidence().tarballReads).toEqual([]);
  });
});

describe("the negative namespace", () => {
  it("is unreachable by name when the registry is built the ordinary way", async () => {
    const registry = registryFor("resolution");
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
    const registry = registryFor("resolution", { allowNegative: true });
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

    const registry = registryFor("resolution");
    await registry.packument("@corpus/chain");
    await registry.tarball(corpusTarballUrl("@corpus/chain", "1.0.0"));
    await expectRegistryError(() => registry.packument("@corpus/absent"), "PACKAGE_NOT_FOUND");
    await expectRegistryError(() => registry.tarball(`${CORPUS_ORIGIN}/@corpus/absent/1.0.0.tgz`), "TARBALL_NOT_FOUND");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CORPUS_ORIGIN.endsWith(".invalid")).toBe(true);
  });
});
