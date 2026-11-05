/**
 * The manifest contract.
 *
 * Each case here is a way a committed corpus goes wrong in practice: a hand-edited hash, a package replaced without
 * updating its manifest, a stray tarball left by an experiment, an identity claimed twice, a negative package that
 * drifted out of its namespace. All of them are refused at load, by code, with the package named.
 */

import { describe, expect, it } from "vitest";

import { buildCorpus } from "../../tools/corpus.js";
import { makePackageTarball } from "../helpers/tarball.js";
import {
  CorpusError,
  installablePackages,
  parseCorpusManifest,
  verifyCorpus,
  type CorpusErrorCode,
} from "../../src/registry/corpus-manifest.js";

const built = buildCorpus();

/** An in-memory corpus: path -> bytes, plus the file listing the verifier would see. */
function memoryCorpus(overrides: { extra?: Record<string, Uint8Array>; drop?: readonly string[] } = {}) {
  const files = new Map<string, Uint8Array>();
  for (const pkg of built.packages) files.set(pkg.tarball, pkg.bytes);
  for (const [path, bytes] of Object.entries(overrides.extra ?? {})) files.set(path, bytes);
  for (const path of overrides.drop ?? []) files.delete(path);
  return {
    files,
    read: (path: string): Uint8Array => {
      const bytes = files.get(path.replace(/^corpus\//, ""));
      if (bytes === undefined) throw new Error(`ENOENT ${path}`);
      return bytes;
    },
    listFiles: (): string[] => [...files.keys()],
  };
}

function expectCorpusError(run: () => unknown, code: CorpusErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusError);
    expect((error as CorpusError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

async function expectVerifyError(
  options: Parameters<typeof verifyCorpus>[0],
  code: CorpusErrorCode,
): Promise<void> {
  try {
    await verifyCorpus(options);
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusError);
    expect((error as CorpusError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

const manifestWith = (mutate: (document: Record<string, unknown>) => void): string => {
  const document = JSON.parse(built.manifestText) as Record<string, unknown>;
  mutate(document);
  return JSON.stringify(document, null, 2);
};

const entryOf = (document: Record<string, unknown>, index: number): Record<string, unknown> => {
  const packages = document["packages"] as Record<string, unknown>[];
  const entry = packages[index];
  if (entry === undefined) throw new Error("no entry at that index");
  return entry;
};

describe("parseCorpusManifest", () => {
  it("accepts the generated manifest", () => {
    const manifest = parseCorpusManifest(built.manifestText);
    expect(manifest.packages).toHaveLength(10);
    expect(manifest.formatVersion).toBe(1);
  });

  it("refuses a format version it does not know rather than guessing", () => {
    expectCorpusError(() => parseCorpusManifest(manifestWith((d) => (d["formatVersion"] = 2))), "UNSUPPORTED_FORMAT");
  });

  it("refuses malformed JSON and a non-object document", () => {
    expectCorpusError(() => parseCorpusManifest("{"), "INVALID_MANIFEST");
    expectCorpusError(() => parseCorpusManifest("[]"), "INVALID_MANIFEST");
    expectCorpusError(() => parseCorpusManifest("{}"), "INVALID_MANIFEST");
  });

  it("refuses an empty package list", () => {
    expectCorpusError(() => parseCorpusManifest(manifestWith((d) => (d["packages"] = []))), "INVALID_MANIFEST");
  });

  it("refuses a duplicate package identity", () => {
    expectCorpusError(
      () =>
        parseCorpusManifest(
          manifestWith((d) => {
            const packages = d["packages"] as Record<string, unknown>[];
            packages.push({ ...entryOf(d, 0) });
          }),
        ),
      "DUPLICATE_PACKAGE",
    );
  });

  it("refuses a name outside the corpus namespaces", () => {
    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["name"] = "is-odd"))),
      "INVALID_MANIFEST",
    );
  });

  it("refuses a tarball path that does not follow from the identity", () => {
    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["tarball"] = "@corpus/leaf/9.9.9.tgz"))),
      "INVALID_MANIFEST",
    );
  });

  it("refuses a tarball path that escapes the corpus root", () => {
    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["tarball"] = "../outside.tgz"))),
      "INVALID_MANIFEST",
    );
  });

  it("refuses an integrity value that is not a sha512 base64 digest", () => {
    for (const bad of ["sha1-abc", "sha512-", "sha512-tooshort==", "md5-abc"]) {
      expectCorpusError(
        () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["integrity"] = bad))),
        "INVALID_MANIFEST",
      );
    }
  });

  it("refuses a version that is not an exact x.y.z", () => {
    for (const bad of ["^1.0.0", "1.0", "latest"]) {
      expectCorpusError(
        () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["version"] = bad))),
        "INVALID_MANIFEST",
      );
    }
  });

  it("refuses a negative flag that disagrees with the namespace, in both directions", () => {
    // The catalog sorts the negative namespace first, so the indexes are looked up by flag rather than assumed.
    const packages = built.manifest["packages"] as readonly { negative: boolean }[];
    const positiveIndex = packages.findIndex((entry) => !entry.negative);
    const negativeIndex = packages.findIndex((entry) => entry.negative);
    expect(positiveIndex).toBeGreaterThanOrEqual(0);
    expect(negativeIndex).toBeGreaterThanOrEqual(0);

    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, positiveIndex)["negative"] = true))),
      "NAMESPACE_POLICY",
    );
    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, negativeIndex)["negative"] = false))),
      "NAMESPACE_POLICY",
    );
  });

  it("refuses declared contents without package.json, or with a duplicate path", () => {
    expectCorpusError(
      () => parseCorpusManifest(manifestWith((d) => (entryOf(d, 0)["contents"] = ["index.js"]))),
      "INVALID_MANIFEST",
    );
    expectCorpusError(
      () =>
        parseCorpusManifest(
          manifestWith((d) => (entryOf(d, 0)["contents"] = ["package.json", "package.json"])),
        ),
      "INVALID_MANIFEST",
    );
  });
});

describe("verifyCorpus", () => {
  it("verifies an intact corpus and re-computes every hash", async () => {
    const corpus = memoryCorpus();
    const verified = await verifyCorpus({ root: "corpus", manifestText: built.manifestText, ...corpus });
    expect(verified.packages).toHaveLength(10);
    for (const item of verified.packages) expect(item.integrity).toBe(item.entry.integrity);
  });

  it("refuses bytes that do not match the recorded integrity", async () => {
    const corpus = memoryCorpus();
    const path = built.packages[0]?.tarball ?? "";
    corpus.files.set(path, new Uint8Array([1, 2, 3]));
    await expectVerifyError({ root: "corpus", manifestText: built.manifestText, ...corpus }, "INTEGRITY_MISMATCH");
  });

  it("refuses a listed package whose tarball is absent", async () => {
    const path = built.packages[0]?.tarball ?? "";
    const corpus = memoryCorpus({ drop: [path] });
    await expectVerifyError({ root: "corpus", manifestText: built.manifestText, ...corpus }, "MISSING_TARBALL");
  });

  it("refuses a stray tarball the manifest does not list", async () => {
    const corpus = memoryCorpus({ extra: { "@corpus/ghost/1.0.0.tgz": new Uint8Array([0]) } });
    await expectVerifyError({ root: "corpus", manifestText: built.manifestText, ...corpus }, "UNEXPECTED_FILE");
  });

  it("refuses an archive whose files disagree with what the manifest declares", async () => {
    // A real, valid tarball for the same identity, with an extra file inside: the hash is updated so only the contents
    // check can catch it, which is the point of checking contents at all.
    const document = JSON.parse(built.manifestText) as {
      packages: { name: string; version: string; tarball: string; integrity: string }[];
    };
    const target = document.packages[0];
    if (target === undefined) throw new Error("empty manifest");
    const sneaky = makePackageTarball(
      { "index.js": 'module.exports = 1;\n', "unexpected.js": 'module.exports = 2;\n' },
      { name: target.name, version: target.version, main: "index.js" },
    );
    const { createHash } = await import("node:crypto");
    target.integrity = `sha512-${createHash("sha512").update(sneaky).digest("base64")}`;
    const corpus = memoryCorpus();
    corpus.files.set(target.tarball, new Uint8Array(sneaky));
    await expectVerifyError(
      { root: "corpus", manifestText: JSON.stringify(document, null, 2), ...corpus },
      "ARCHIVE_MISMATCH",
    );
  });

  it("excludes negative packages from what a fixture may install", async () => {
    const verified = await verifyCorpus({ root: "corpus", manifestText: built.manifestText, ...memoryCorpus() });
    const installable = installablePackages(verified);
    expect(installable).toHaveLength(8);
    expect(installable.some((entry) => entry.name.startsWith("@corpus-broken/"))).toBe(false);
  });
});
