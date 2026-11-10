import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { computeIntegrity } from "../../src/npm/digest.js";
import { installDependencies } from "../../src/npm/install.js";
import {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotError,
  SnapshotRegistry,
  loadSnapshotRegistry,
  parseSnapshotManifest,
  type SnapshotManifest,
} from "../../src/registry/snapshot.js";
import { createFsShim } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";
import { makePackageTarball } from "../helpers/tarball.js";

/**
 * The snapshot lane exists so a compatibility verdict is about real bytes and still costs no network. These tests hold it to that:
 * a frozen set that only answers for what it holds, integrity checked on the way out, and an install that never reaches fetch.
 */

const alphaTar = makePackageTarball({ "index.js": "module.exports = 'alpha';" }, { name: "alpha", version: "1.0.0", dependencies: { beta: "^2.0.0" } });
const betaTar = makePackageTarball({ "index.js": "module.exports = 'beta';" }, { name: "beta", version: "2.1.0" });
const betaOldTar = makePackageTarball({ "index.js": "module.exports = 'beta old';" }, { name: "beta", version: "2.0.0" });

const files = new Map<string, Uint8Array>([
  ["snapshot/tarballs/alpha-1.0.0.tgz", alphaTar],
  ["snapshot/tarballs/beta-2.1.0.tgz", betaTar],
  ["snapshot/tarballs/beta-2.0.0.tgz", betaOldTar],
]);

const read = (path: string): Uint8Array => {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`no such file in the fixture: ${path}`);
  return bytes;
};

const manifestWith = async (overrides: Partial<SnapshotManifest> = {}): Promise<SnapshotManifest> => {
  const [alphaIntegrity, betaIntegrity, betaOldIntegrity] = await Promise.all([
    computeIntegrity(alphaTar),
    computeIntegrity(betaTar),
    computeIntegrity(betaOldTar),
  ]);
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    source: "registry.npmjs.org",
    capturedAt: "2026-11-10T00:00:00.000Z",
    requested: ["alpha"],
    packages: {
      alpha: [
        {
          version: "1.0.0",
          integrity: alphaIntegrity as string,
          tarball: "tarballs/alpha-1.0.0.tgz",
          dependencies: { beta: "^2.0.0" },
        },
      ],
      beta: [
        { version: "2.0.0", integrity: betaOldIntegrity as string, tarball: "tarballs/beta-2.0.0.tgz" },
        { version: "2.1.0", integrity: betaIntegrity as string, tarball: "tarballs/beta-2.1.0.tgz" },
      ],
    },
    ...overrides,
  };
};

const registryWith = async (manifest: SnapshotManifest, overrides: { read?: (path: string) => Uint8Array } = {}): Promise<SnapshotRegistry> =>
  new SnapshotRegistry({ slug: "fixture", manifest, read: overrides.read ?? read, root: "snapshot" });

describe("a snapshot manifest is validated field by field", () => {
  it("accepts the shape the builder writes", async () => {
    const parsed = parseSnapshotManifest(await manifestWith());
    expect(Object.keys(parsed.packages)).toEqual(["alpha", "beta"]);
    expect(parsed.packages["beta"]?.length).toBe(2);
  });

  it("refuses a format version it does not understand", async () => {
    const manifest = await manifestWith();
    expect(() => parseSnapshotManifest({ ...manifest, formatVersion: 2 })).toThrow(/unsupported formatVersion 2/);
  });

  it("refuses an entry with no sha512, because an unpinned tarball is not a snapshot", async () => {
    const manifest = await manifestWith();
    const broken = {
      ...manifest,
      packages: { alpha: [{ version: "1.0.0", integrity: "md5-abc", tarball: "tarballs/alpha-1.0.0.tgz" }] },
    };
    expect(() => parseSnapshotManifest(broken)).toThrow(/must carry a sha512 integrity/);
  });

  it("refuses a tarball path that escapes the snapshot directory", async () => {
    const manifest = await manifestWith();
    const broken = {
      ...manifest,
      packages: { alpha: [{ version: "1.0.0", integrity: "sha512-abc", tarball: "../outside.tgz" }] },
    };
    expect(() => parseSnapshotManifest(broken)).toThrow(/relative path inside the snapshot/);
  });

  it("refuses a duplicated version rather than serving whichever wins", async () => {
    const manifest = await manifestWith();
    const entry = { version: "1.0.0", integrity: "sha512-abc", tarball: "tarballs/a.tgz" };
    expect(() => parseSnapshotManifest({ ...manifest, packages: { alpha: [entry, entry] } })).toThrow(/appears twice/);
  });

  it("names the failing field when a dependency map is not strings", async () => {
    const manifest = await manifestWith();
    const broken = {
      ...manifest,
      packages: { alpha: [{ version: "1.0.0", integrity: "sha512-abc", tarball: "tarballs/a.tgz", dependencies: { beta: 2 } }] },
    };
    expect(() => parseSnapshotManifest(broken)).toThrow(/alpha@1.0.0.dependencies.beta must be a string/);
  });
});

describe("a snapshot answers only for what it froze", () => {
  it("synthesises a packument whose versions are exactly the frozen set", async () => {
    const registry = await registryWith(await manifestWith());
    const packument = await registry.packument("beta");
    expect(Object.keys(packument.versions).sort()).toEqual(["2.0.0", "2.1.0"]);
    // `latest` means the newest version IN THE SNAPSHOT, which is the whole point: it cannot move tomorrow.
    expect(packument["dist-tags"]?.["latest"]).toBe("2.1.0");
  });

  it("says so by name when asked for a package it does not hold, instead of reaching out", async () => {
    const registry = await registryWith(await manifestWith());
    await expect(registry.packument("express")).rejects.toBeInstanceOf(SnapshotError);
    await expect(registry.packument("express")).rejects.toThrow(/SNAPSHOT_MISSING/);
  });

  it("verifies sha512 on the way out, so a corrupted checkout fails loudly", async () => {
    const manifest = await manifestWith();
    const tampered = (path: string): Uint8Array => {
      const bytes = new Uint8Array(read(path));
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      return bytes;
    };
    const registry = await registryWith(manifest, { read: tampered });
    await expect(registry.tarball("tarballs/beta-2.1.0.tgz")).rejects.toThrow(/SNAPSHOT_INTEGRITY/);
  });

  it("refuses a tarball path the manifest does not describe", async () => {
    const registry = await registryWith(await manifestWith());
    await expect(registry.tarball("tarballs/unknown.tgz")).rejects.toThrow(/SNAPSHOT_MISSING/);
  });
});

describe("installing from a snapshot needs no network at all", () => {
  it("resolves the tree, writes the packages and never calls fetch", async () => {
    const registry = await registryWith(await manifestWith());
    const vfs = new FileSystem();
    const fetchSpy = vi.fn(() => {
      throw new Error("the snapshot lane must not touch the network");
    });
    const originalFetch = globalThis.fetch;
    // Assigned through `globalThis` rather than only stubbed on the client, because the claim under test is that nothing in this path
    // reaches out: a client that quietly fell back to the real registry would fail here.
    Object.defineProperty(globalThis, "fetch", { value: fetchSpy, configurable: true, writable: true });
    try {
      const report = await installDependencies(
        { name: "project", version: "1.0.0", dependencies: { alpha: "latest" } },
        { registry, vfs: createFsShim(vfs), root: "/project" },
      );
      expect(report.packages.map((pkg) => `${pkg.name}@${pkg.version}`).sort()).toEqual(["alpha@1.0.0", "beta@2.1.0"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.readFileSync("/project/node_modules/beta/package.json", "utf8")).toContain("\"beta\"");
      const lockfile = vfs.readFileSync("/project/package-lock.json", "utf8") as string;
      expect(lockfile).toContain("node_modules/beta");
    } finally {
      Object.defineProperty(globalThis, "fetch", { value: originalFetch, configurable: true, writable: true });
    }
  });
});

describe("loading from disk", () => {
  it("reports invalid JSON as a snapshot problem rather than as a crash", () => {
    expect(() =>
      loadSnapshotRegistry({ slug: "bad", root: "snapshot", manifestText: "{ not json", read }),
    ).toThrow(/not valid JSON/);
  });

  it("loads a well-formed file and reports how many names it pinned", async () => {
    const manifest = await manifestWith();
    const registry = loadSnapshotRegistry({
      slug: "fixture",
      root: "snapshot",
      manifestText: JSON.stringify(manifest),
      read,
    });
    expect(registry.packageCount).toBe(2);
    expect(registry.origin).toContain("2 pinned packages");
  });
});

describe("every committed snapshot is intact", () => {
  for (const slug of readdirSync(join(process.cwd(), "fixtures", "snapshots"))) {
    it(`serves every tarball ${slug} claims, matching the pinned integrity`, async () => {
    // Guards the committed data rather than the code: regenerating a tarball without regenerating the manifest is exactly the kind of
    // drift a frozen lane must refuse, and this test runs in the ordinary suite where it costs 68 digests.
      const root = join(process.cwd(), "fixtures", "snapshots", slug);
      const registry = loadSnapshotRegistry({
        slug,
      root,
        manifestText: readFileSync(join(root, "snapshot.json"), "utf8"),
        read: (path) => new Uint8Array(readFileSync(path)),
      });
      expect(registry.packageCount).toBeGreaterThan(0);
      let verified = 0;
      for (const entries of Object.values(registry.manifest.packages)) {
        for (const entry of entries) {
          const bytes = await registry.tarball(entry.tarball);
          expect(bytes.byteLength).toBeGreaterThan(0);
          verified += 1;
        }
      }
      expect(verified).toBe(registry.packageCount);
    });
  }
});
