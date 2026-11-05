/**
 * The committed corpus is the artifact under audit here.
 *
 * These tests fail if the bytes on disk drift from the generator, if the manifest stops describing what is committed,
 * or if the corpus silently gains or loses a package. They deliberately do not assert a pass rate or anything about
 * npm: a synthetic corpus proves this runtime's machinery, never ecosystem compatibility.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCorpus, CORPUS_ROOT, tarballPath } from "../../tools/corpus.js";
import { makePackageTarball } from "../helpers/tarball.js";
import { makePackageTarball as toolTarball } from "../../tools/lib/tar.js";
import { installablePackages, parseCorpusManifest, verifyCorpus } from "../../src/registry/corpus-manifest.js";

const root = process.cwd();

/** Every file under `directory`, relative to it, POSIX-style. */
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

const corpusRoot = join(root, CORPUS_ROOT);
const manifestText = readFileSync(join(corpusRoot, "manifest.json"), "utf8");

const verify = () =>
  verifyCorpus({
    root: CORPUS_ROOT,
    manifestText,
    read: (path) => readFileSync(join(root, path)),
    listFiles: (path) => listFiles(join(root, path)),
  });

describe("the committed corpus", () => {
  it("validates: every listed tarball exists, hashes to its recorded integrity, and holds its declared files", async () => {
    const corpus = await verify();
    expect(corpus.packages).toHaveLength(10);
    for (const item of corpus.packages) {
      expect(item.integrity).toBe(item.entry.integrity);
      expect(item.byteLength).toBeGreaterThan(0);
    }
  });

  it("holds exactly the intended inventory", async () => {
    const corpus = await verify();
    const inventory = corpus.packages.map((item) => `${item.entry.name}@${item.entry.version}`).sort();
    expect(inventory).toEqual([
      "@corpus-broken/missing-edge@1.0.0",
      "@corpus-broken/tar-hostile@1.0.0",
      "@corpus/bin@1.0.0",
      "@corpus/chain@1.0.0",
      "@corpus/deep@1.0.0",
      "@corpus/esm@1.0.0",
      "@corpus/exports-map@1.0.0",
      "@corpus/leaf@1.0.0",
      "@corpus/leaf@2.0.0",
      "@corpus/version-conflict@2.0.0",
    ]);
  });

  it("offers exactly eight installable packages, because the two negative ones are unreachable by construction", async () => {
    const corpus = await verify();
    const installable = installablePackages(corpus);
    expect(installable).toHaveLength(8);
    expect(installable.every((entry) => entry.name.startsWith("@corpus/"))).toBe(true);
  });

  it("regenerates to the same bytes: a fresh build equals what is committed", async () => {
    const built = buildCorpus();
    for (const pkg of built.packages) {
      const committed = readFileSync(join(corpusRoot, pkg.tarball));
      expect(committed.equals(Buffer.from(pkg.bytes)), `${pkg.name}@${pkg.version} drifted`).toBe(true);
    }
    expect(built.manifestText).toBe(manifestText);
  });

  it("is deterministic: build twice, compare every byte", () => {
    const first = buildCorpus();
    const second = buildCorpus();
    expect(first.manifestText).toBe(second.manifestText);
    for (let index = 0; index < first.packages.length; index += 1) {
      const left = first.packages[index];
      const right = second.packages[index];
      expect(left?.tarball).toBe(right?.tarball);
      expect(Buffer.from(left?.bytes ?? new Uint8Array()).equals(Buffer.from(right?.bytes ?? new Uint8Array()))).toBe(
        true,
      );
    }
  });

  it("puts every package where its name says, with no unreachable artifact", async () => {
    const corpus = await verify();
    for (const item of corpus.packages) {
      expect(item.entry.tarball).toBe(tarballPath(item.entry.name, item.entry.version));
    }
    const listed = new Set(corpus.packages.map((item) => item.entry.tarball));
    const onDisk = listFiles(corpusRoot).filter((path) => path.endsWith(".tgz"));
    expect(onDisk.sort()).toEqual([...listed].sort());
    expect(corpus.unlisted).toEqual([]);
  });

  it("agrees with the test tarball helper byte for byte", () => {
    // Two writers, one format. The tool-side one exists because a committed artifact generator must not depend on the
    // test suite; this test is what stops the two drifting into producing different archives for the same package.
    const files = { "index.js": 'module.exports = "same";\n', "lib/extra.js": "export const extra = 1;\n" };
    const packageJson = { name: "@corpus/agreement", version: "1.0.0", main: "index.js" };
    const fromHelper = makePackageTarball(files, packageJson);
    const fromTool = toolTarball(files, packageJson);
    expect(Buffer.from(fromTool).equals(Buffer.from(fromHelper))).toBe(true);
  });

  it("declares a format version and refuses nothing about itself", () => {
    const manifest = parseCorpusManifest(manifestText);
    expect(manifest.formatVersion).toBe(1);
  });
});
