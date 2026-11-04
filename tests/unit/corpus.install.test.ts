/**
 * The corpus registry driving the real installer.
 *
 * Nothing here re-implements installation: every case runs the installer through the runtime facade, so a pass means the
 * existing resolution queue, hoisting, nesting, integrity verification and lockfile writing behave correctly against a
 * corpus. The ten distinctions the milestone asks for are one test each.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CORPUS_ROOT } from "../../tools/corpus.js";
import { computeIntegrity } from "../../src/npm/digest.js";
import type { RegistryClient } from "../../src/npm/install.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import {
  CorpusRegistry,
  CorpusRegistryError,
  loadCorpusRegistry,
} from "../../src/registry/corpus.js";
import { verifyCorpus, type VerifiedCorpus } from "../../src/registry/corpus-manifest.js";
import { FileSystem } from "../../src/vfs/index.js";
import { makePackageTarball } from "../helpers/tarball.js";

const ROOT = "/app";
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
const readCorpus = (path: string): Uint8Array => new Uint8Array(readFileSync(join(corpusRoot, path)));

const verified: VerifiedCorpus = await verifyCorpus({
  root: CORPUS_ROOT,
  manifestText,
  read: (path) => readFileSync(join(root, path)),
  listFiles: (path) => listFiles(join(root, path)),
});

const resolutionRegistry = (): CorpusRegistry =>
  new CorpusRegistry({ corpus: verified, read: readCorpus, mode: "resolution" });
const pinnedRegistry = (): CorpusRegistry =>
  new CorpusRegistry({ corpus: verified, read: readCorpus, mode: "pinned" });

/** A project with a package.json, and optionally a lockfile already on disk. */
function project(dependencies: Record<string, string>, lockfile?: string): FileSystem {
  const vfs = new FileSystem();
  vfs.mkdirSync(ROOT, { recursive: true });
  vfs.writeFileSync(`${ROOT}/package.json`, JSON.stringify({ name: "corpus-project", version: "1.0.0", dependencies }));
  if (lockfile !== undefined) vfs.writeFileSync(`${ROOT}/package-lock.json`, lockfile);
  return vfs;
}

const text = (vfs: FileSystem, path: string): string => {
  const raw = vfs.readFileSync(path) as Uint8Array | string;
  return typeof raw === "string" ? raw : new TextDecoder().decode(raw);
};

const exists = (vfs: FileSystem, path: string): boolean => {
  try {
    vfs.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Every file under `directory` with its contents, so two installs can be compared without trusting either. */
function tree(vfs: FileSystem, directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = vfs.readdirSync(current).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const child = `${current}/${name}`;
      if (vfs.statSync(child).kind === "dir") walk(child);
      else out[relative(directory, child)] = text(vfs, child);
    }
  };
  walk(directory);
  return out;
}

const install = (vfs: FileSystem, registry: RegistryClient) =>
  new InProcessRuntime(vfs).install({ registry, root: ROOT });

describe("lockfile-pinned installation", () => {
  it("installs from a lockfile with zero packument requests", async () => {
    const first = project({ "@corpus/deep": "^1.0.0" });
    const resolved = await install(first, resolutionRegistry());
    const lockfile = text(first, `${ROOT}/package-lock.json`);
    expect(resolved.packages.map((item) => `${item.name}@${item.version}`).sort()).toEqual([
      "@corpus/chain@1.0.0",
      "@corpus/deep@1.0.0",
      "@corpus/leaf@1.0.0",
    ]);

    const registry = pinnedRegistry();
    const second = project({ "@corpus/deep": "^1.0.0" }, lockfile);
    const pinned = await install(second, registry);

    expect(pinned.usedLockfile).toBe(true);
    expect(registry.evidence().packumentRequests).toEqual([]);
    expect(registry.evidence().tarballReads).toHaveLength(3);
    expect(registry.evidence().integrityChecks.every((check) => check.ok)).toBe(true);
    expect(Object.keys(tree(second, `${ROOT}/node_modules`)).sort()).toEqual(
      Object.keys(tree(first, `${ROOT}/node_modules`)).sort(),
    );
  });

  it("refuses a lockfile gap in pinned mode instead of resolving it silently", async () => {
    const first = project({ "@corpus/deep": "^1.0.0" });
    await install(first, resolutionRegistry());
    const document = JSON.parse(text(first, `${ROOT}/package-lock.json`)) as { packages: Record<string, unknown> };
    // Remove the middle of the chain, so the lockfile covers deep and leaf but not chain.
    delete document.packages["node_modules/@corpus/chain"];

    const second = project({ "@corpus/deep": "^1.0.0" }, JSON.stringify(document, null, 2));
    await expect(install(second, pinnedRegistry())).rejects.toMatchObject({
      code: "PACKUMENT_FORBIDDEN_IN_PINNED_MODE",
    });
    expect(exists(second, `${ROOT}/node_modules/@corpus/chain`)).toBe(false);
  });
});

describe("corpus-based version resolution", () => {
  it("resolves a range against the published versions and picks the highest match", async () => {
    const vfs = project({ "@corpus/leaf": "^1.0.0" });
    const registry = resolutionRegistry();
    const report = await install(vfs, registry);

    expect(report.packages.map((item) => `${item.name}@${item.version}`)).toEqual(["@corpus/leaf@1.0.0"]);
    expect(registry.evidence().packumentRequests).toEqual(["@corpus/leaf"]);
    expect(text(vfs, `${ROOT}/node_modules/@corpus/leaf/index.js`)).toContain('"1.0.0"');
  });

  it("does not substitute a version when nothing published satisfies the range", async () => {
    const vfs = project({ "@corpus/leaf": "^3.0.0" });
    await expect(install(vfs, resolutionRegistry())).rejects.toMatchObject({ code: "NO_MATCHING_VERSION" });
    expect(exists(vfs, `${ROOT}/node_modules/@corpus/leaf`)).toBe(false);
  });
});

describe("transitive dependency installation", () => {
  it("installs the whole chain flat when nothing conflicts", async () => {
    const vfs = project({ "@corpus/deep": "^1.0.0" });
    const registry = resolutionRegistry();
    const report = await install(vfs, registry);

    expect(report.packages.map((item) => `${item.name}@${item.version}`).sort()).toEqual([
      "@corpus/chain@1.0.0",
      "@corpus/deep@1.0.0",
      "@corpus/leaf@1.0.0",
    ]);
    for (const name of ["deep", "chain", "leaf"]) {
      expect(exists(vfs, `${ROOT}/node_modules/@corpus/${name}/package.json`), name).toBe(true);
      expect(exists(vfs, `${ROOT}/node_modules/@corpus/${name}/node_modules`), `${name} nested`).toBe(false);
    }
    expect([...registry.evidence().packumentRequests].sort()).toEqual(["@corpus/chain", "@corpus/deep", "@corpus/leaf"]);
    expect(registry.evidence().tarballReads).toHaveLength(3);
  });
});

describe("nested version conflict", () => {
  it("keeps the root copy flat and nests the conflicting one under its dependent", async () => {
    const vfs = project({ "@corpus/leaf": "^1.0.0", "@corpus/version-conflict": "^2.0.0" });
    const report = await install(vfs, resolutionRegistry());

    expect(report.packages.map((item) => `${item.name}@${item.version}`).sort()).toEqual([
      "@corpus/leaf@1.0.0",
      "@corpus/leaf@2.0.0",
      "@corpus/version-conflict@2.0.0",
    ]);

    expect(text(vfs, `${ROOT}/node_modules/@corpus/leaf/index.js`)).toContain('"1.0.0"');
    expect(text(vfs, `${ROOT}/node_modules/@corpus/version-conflict/node_modules/@corpus/leaf/index.js`)).toContain(
      '"2.0.0"',
    );
    expect(exists(vfs, `${ROOT}/node_modules/@corpus/version-conflict/node_modules/@corpus/version-conflict`)).toBe(
      false,
    );
  });
});

describe("missing packages", () => {
  it("fails with PACKAGE_NOT_FOUND for a package the corpus does not publish", async () => {
    const vfs = project({ "@corpus/absent": "^1.0.0" });
    const registry = resolutionRegistry();
    await expect(install(vfs, registry)).rejects.toMatchObject({ code: "PACKAGE_NOT_FOUND" });
    expect(exists(vfs, `${ROOT}/node_modules/@corpus/absent`)).toBe(false);
    expect(registry.evidence().refusals).toEqual([{ code: "PACKAGE_NOT_FOUND", subject: "@corpus/absent" }]);
  });

  it("fails with PACKAGE_NOT_FOUND when a transitive edge is unavailable", async () => {
    // A purpose-built corpus: one package whose dependency nobody publishes.
    const bytes = makePackageTarball(
      { "index.js": "module.exports = 1;\n" },
      { name: "@corpus/orphan", version: "1.0.0", main: "index.js", dependencies: { "@corpus/absent": "^1.0.0" } },
    );
    const integrity = await computeIntegrity(bytes);
    if (integrity === null) throw new Error("no crypto");
    const entry = {
      name: "@corpus/orphan",
      version: "1.0.0",
      tarball: "@corpus/orphan/1.0.0.tgz",
      integrity,
      negative: false,
      contents: ["package.json", "index.js"],
      dependencies: { "@corpus/absent": "^1.0.0" },
      main: "index.js",
    };
    const corpus: VerifiedCorpus = {
      manifest: { formatVersion: 1, packages: [entry] },
      packages: [{ entry, byteLength: bytes.byteLength, integrity }],
      unlisted: [],
    };
    const registry = new CorpusRegistry({ corpus, mode: "resolution", read: () => new Uint8Array(bytes) });

    const vfs = project({ "@corpus/orphan": "^1.0.0" });
    const error = await install(vfs, registry).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CorpusRegistryError);
    expect((error as CorpusRegistryError).code).toBe("PACKAGE_NOT_FOUND");
    expect((error as Error).message).toContain("@corpus/absent");
    expect(exists(vfs, `${ROOT}/node_modules/@corpus/orphan`)).toBe(false);
  });

  it("cannot install a negative-namespace package even when it is asked for directly", async () => {
    for (const broken of ["@corpus-broken/missing-edge", "@corpus-broken/tar-hostile"]) {
      const vfs = project({ [broken]: "^1.0.0" });
      const registry = resolutionRegistry();
      const error = await install(vfs, registry).catch((thrown: unknown) => thrown);
      expect(error, broken).toBeInstanceOf(CorpusRegistryError);
      expect((error as CorpusRegistryError).code, broken).toBe("PACKAGE_NOT_FOUND");
      expect(exists(vfs, `${ROOT}/node_modules/${broken}`), broken).toBe(false);
      // Nothing was even served for it: no tarball read, no integrity check.
      expect(registry.evidence().tarballReads, broken).toEqual([]);
    }
  });

  it("refuses an identity it cannot resolve rather than inventing one", async () => {
    const vfs = project({ "@corpus/leaf": "workspace:*" });
    await expect(install(vfs, resolutionRegistry())).rejects.toMatchObject({ code: "UNSUPPORTED_SPEC" });
  });
});

describe("integrity verification before extraction", () => {
  it("installs nothing when the packument advertises a digest the bytes do not have", async () => {
    const honest = resolutionRegistry();
    const lying: RegistryClient = {
      packument: async (name) => {
        const packument = await honest.packument(name);
        const versions = Object.fromEntries(
          Object.entries(packument.versions).map(([version, entry]) => [
            version,
            { ...entry, dist: { ...entry.dist, integrity: `sha512-${"A".repeat(86)}==` } },
          ]),
        );
        return { ...packument, versions };
      },
      tarball: (url) => honest.tarball(url),
    };

    const vfs = project({ "@corpus/leaf": "^1.0.0" });
    await expect(install(vfs, lying)).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    // Verification happens before extraction, so nothing reached the VFS.
    expect(tree(vfs, `${ROOT}/node_modules`)).toEqual({});
  });
});

describe("network fallback prevention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes a full resolution install without calling fetch", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const vfs = project({ "@corpus/deep": "^1.0.0" });
    const report = await install(vfs, resolutionRegistry());
    expect(report.packages).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still calls nothing when the install fails for a missing package", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const vfs = project({ "@corpus/absent": "^1.0.0" });
    await expect(install(vfs, resolutionRegistry())).rejects.toMatchObject({ code: "PACKAGE_NOT_FOUND" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("repeated installation", () => {
  it("produces the same tree twice and leaves the corpus untouched", async () => {
    const manifestBefore = readFileSync(join(corpusRoot, "manifest.json"));
    const tarballBefore = readFileSync(join(corpusRoot, "@corpus/version-conflict/2.0.0.tgz"));

    const run = async () => {
      const vfs = project({ "@corpus/leaf": "^1.0.0", "@corpus/version-conflict": "^2.0.0" });
      await install(vfs, resolutionRegistry());
      return { tree: tree(vfs, `${ROOT}/node_modules`), lockfile: text(vfs, `${ROOT}/package-lock.json`) };
    };

    const first = await run();
    const second = await run();

    expect(second.tree).toEqual(first.tree);
    expect(second.lockfile).toBe(first.lockfile);

    expect(readFileSync(join(corpusRoot, "manifest.json")).equals(manifestBefore)).toBe(true);
    expect(readFileSync(join(corpusRoot, "@corpus/version-conflict/2.0.0.tgz")).equals(tarballBefore)).toBe(true);
  });
});

describe("observable evidence", () => {
  it("keeps packuments, tarballs and integrity checks in separate buckets during an install", async () => {
    const registry = resolutionRegistry();
    const vfs = project({ "@corpus/chain": "^1.0.0" });
    await install(vfs, registry);

    const evidence = registry.evidence();
    expect([...evidence.packumentRequests].sort()).toEqual(["@corpus/chain", "@corpus/leaf"]);
    expect(evidence.tarballReads.map((item) => item.name).sort()).toEqual(["@corpus/chain", "@corpus/leaf"]);
    expect(evidence.integrityChecks).toHaveLength(2);
    expect(evidence.integrityChecks.every((check) => check.ok)).toBe(true);
    expect(evidence.refusals).toEqual([]);
    expect(evidence.tarballReads.every((item) => item.byteLength > 0)).toBe(true);
  });

  it("validates the corpus before the registry exists at all", async () => {
    const loaded = await loadCorpusRegistry({
      root: CORPUS_ROOT,
      manifestText,
      mode: "resolution",
      read: readCorpus,
      listFiles: () => listFiles(corpusRoot),
    });
    expect(loaded.corpus.packages).toHaveLength(10);
    expect(loaded.registry.mode).toBe("resolution");
  });
});
