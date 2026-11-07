/**
 * The synthetic dependency corpus, defined once and built from here.
 *
 * Two rules shape this file. First, every package is explicitly synthetic and lives in a scoped namespace, so no result
 * it produces can be mistaken for evidence about the real package of a similar name. Second, the corpus is committed as
 * bytes: this module regenerates those bytes, it is not consulted at install time. A corpus generated at load would pin
 * integrity to whichever zlib built it, which is not a property of the corpus.
 *
 * The catalog is small on purpose. Each package exists to exercise exactly one resolution or execution behaviour, and a
 * package that no longer earns its place should be deleted rather than kept for company.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { makePackageTarball, makeTar, type WriteEntry } from "./lib/tar.js";

/** Where the committed artifacts live, relative to the repository root. */
export const CORPUS_ROOT = "fixtures/registry";

/** The manifest's format version. A reader that does not know this number must refuse the corpus, not guess. */
export const CORPUS_FORMAT_VERSION = 1;

export interface CorpusPackageDefinition {
  readonly name: string;
  readonly version: string;
  /** Extra `package.json` fields beyond name and version: `main`, `type`, `bin`, `exports`, `dependencies`. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** Package-relative file paths and their contents. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Replaces the normal `package/`-prefixed archive. Only for a negative package whose archive must be malformed in a
   * way the standard builder cannot express.
   */
  readonly rawEntries?: readonly WriteEntry[];
  /** True for `@corpus-broken/*`: negative-test only, and forbidden to fixtures. */
  readonly negative?: boolean;
}

const MIT = { license: "MIT", private: true } as const;

/**
 * The catalog.
 *
 * `leaf` has two published versions so that `version-conflict` can force a nested second copy without inventing a
 * separate package for it: nesting is about the same name at two versions, and that is what the tree has to contain.
 */
export const CATALOG: readonly CorpusPackageDefinition[] = [
  {
    name: "@corpus/leaf",
    version: "1.0.0",
    manifest: { main: "index.js", ...MIT, description: "Baseline package: CommonJS, main entry, no dependencies." },
    files: {
      "index.js": [
        "// @corpus/leaf 1.0.0: the smallest thing that can be required.",
        'module.exports = { package: "@corpus/leaf", version: "1.0.0", leaf: 1 };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/leaf",
    version: "2.0.0",
    manifest: { main: "index.js", ...MIT, description: "The other half of a version conflict." },
    files: {
      "index.js": [
        "// @corpus/leaf 2.0.0: same shape, different value, so a resolved tree can be told apart by behaviour.",
        'module.exports = { package: "@corpus/leaf", version: "2.0.0", leaf: 2 };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/chain",
    version: "1.0.0",
    manifest: {
      main: "index.js",
      dependencies: { "@corpus/leaf": "^1.0.0" },
      ...MIT,
      description: "One transitive dependency.",
    },
    files: {
      "index.js": [
        'const leaf = require("@corpus/leaf");',
        "// Reads the dependency rather than re-exporting it: a tree that installs the edge but not its target fails here.",
        'module.exports = { package: "@corpus/chain", version: "1.0.0", leafVersion: leaf.version, total: leaf.leaf + 10 };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/deep",
    version: "1.0.0",
    manifest: {
      main: "index.js",
      dependencies: { "@corpus/chain": "^1.0.0" },
      ...MIT,
      description: "Three levels: deep to chain to leaf.",
    },
    files: {
      "index.js": [
        'const chain = require("@corpus/chain");',
        'module.exports = { package: "@corpus/deep", version: "1.0.0", chainTotal: chain.total, total: chain.total + 100 };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/version-conflict",
    version: "2.0.0",
    manifest: {
      main: "index.js",
      dependencies: { "@corpus/leaf": "^2.0.0" },
      ...MIT,
      description: "Requires the other version of leaf, forcing a nested copy under this package.",
    },
    files: {
      "index.js": [
        'const leaf = require("@corpus/leaf");',
        "// A flat tree that hoisted leaf@1 over this package's leaf@2 prints 1 here instead of 2, which is the point.",
        'module.exports = { package: "@corpus/version-conflict", version: "2.0.0", leafVersion: leaf.version, total: leaf.leaf + 20 };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/esm",
    version: "1.0.0",
    manifest: { type: "module", main: "./index.js", ...MIT, description: "ES module package: named and default export." },
    files: {
      "index.js": [
        'export const marker = "@corpus/esm";',
        "export function greet(name) {",
        "  return `hello ${name} from @corpus/esm`;",
        "}",
        'export default { marker: "@corpus/esm", version: "1.0.0" };',
        "",
      ].join("\n"),
    },
  },
  {
    name: "@corpus/bin",
    version: "1.0.0",
    manifest: {
      main: "index.js",
      bin: { "corpus-bin": "./cli.js" },
      ...MIT,
      description: "A package binary with a shebang, for bin resolution.",
    },
    files: {
      "cli.js": [
        "#!/usr/bin/env node",
        "// The shebang is part of the test: the loader has to strip it rather than hand it to a parser.",
        'const args = process.argv.slice(2);',
        'console.log(["corpus-bin", ...args].join(" ").trim());',
        "",
      ].join("\n"),
      "index.js": ['module.exports = { package: "@corpus/bin", version: "1.0.0", bin: "corpus-bin" };', ""].join("\n"),
    },
  },
  {
    name: "@corpus/exports-map",
    version: "1.0.0",
    manifest: {
      // No `main`: Node resolves this package through `exports` alone, to ./lib/real.js.
      exports: { ".": "./lib/real.js" },
      ...MIT,
      description: "Entry point declared by exports map only, with a decoy index.js that Node never chooses.",
    },
    files: {
      "lib/real.js": ['module.exports = { entry: "exports", file: "lib/real.js", version: "1.0.0" };', ""].join("\n"),
      // This file exists so that a silent fallback is visible: anything that loads index.js is not implementing exports.
      "index.js": ['module.exports = { entry: "decoy-index", file: "index.js", version: "1.0.0" };', ""].join("\n"),
    },
  },
  {
    name: "@corpus-broken/missing-edge",
    version: "1.0.0",
    manifest: {
      main: "index.js",
      dependencies: { "@corpus/absent": "^1.0.0" },
      ...MIT,
      description: "Depends on a package the corpus does not serve. Negative tests only.",
    },
    files: {
      "index.js": [
        "// Unreachable in practice: the install must fail before this is ever evaluated.",
        'module.exports = { package: "@corpus-broken/missing-edge", version: "1.0.0" };',
        "",
      ].join("\n"),
    },
    negative: true,
  },
  {
    name: "@corpus-broken/tar-hostile",
    version: "1.0.0",
    manifest: {
      main: "index.js",
      ...MIT,
      description: "Archive containing a path escape. The tar reader must refuse it. Negative tests only.",
    },
    files: {},
    // Hand-built: one entry climbs out of the package directory entirely.
    rawEntries: [
      { path: "package/", type: "directory" },
      {
        path: "package/package.json",
        data: JSON.stringify({ name: "@corpus-broken/tar-hostile", version: "1.0.0", main: "index.js" }, null, 2),
      },
      { path: "package/index.js", data: 'module.exports = "hostile";\n' },
      { path: "../../escape.js", data: "// This file must never reach the VFS.\n" },
    ],
    negative: true,
  },
];

export interface BuiltCorpusPackage {
  readonly name: string;
  readonly version: string;
  /** Path relative to CORPUS_ROOT, e.g. `@corpus/leaf/1.0.0.tgz`. */
  readonly tarball: string;
  readonly integrity: string;
  readonly bytes: Uint8Array;
  readonly negative: boolean;
}

export interface BuiltCorpus {
  readonly packages: readonly BuiltCorpusPackage[];
  /** The manifest document, ready to serialize. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** The manifest as it is written to disk: two-space JSON plus a trailing newline. */
  readonly manifestText: string;
}

/** The tarball path for a package: scoped names keep their scope as a directory, as npm does. */
export function tarballPath(name: string, version: string): string {
  return `${name}/${version}.tgz`;
}

/** The package-relative paths inside a well-formed archive, in the order the archive holds them. */
function contentsOf(definition: CorpusPackageDefinition): readonly string[] | null {
  if (definition.rawEntries !== undefined) return null;
  return ["package.json", ...Object.keys(definition.files)];
}

function buildOne(definition: CorpusPackageDefinition): BuiltCorpusPackage {
  const packageJson = { name: definition.name, version: definition.version, ...definition.manifest };
  const bytes =
    definition.rawEntries !== undefined
      ? new Uint8Array(gzipSync(makeTar(definition.rawEntries)))
      : makePackageTarball(definition.files, packageJson);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return {
    name: definition.name,
    version: definition.version,
    tarball: tarballPath(definition.name, definition.version),
    integrity,
    bytes,
    negative: definition.negative === true,
  };
}

/**
 * Build every package and the manifest that describes them.
 *
 * Deterministic by construction: fixed entry order, zero timestamps, fixed modes, and the version-sorted catalog below
 * means the same input produces the same bytes on every run.
 */
export function buildCorpus(): BuiltCorpus {
  const packages = [...CATALOG]
    .sort((left, right) => (left.name === right.name ? left.version.localeCompare(right.version) : left.name.localeCompare(right.name)))
    .map(buildOne);

  const entries = packages.map((built) => {
    const definition = CATALOG.find((item) => item.name === built.name && item.version === built.version);
    if (definition === undefined) throw new Error(`no definition for ${built.name}@${built.version}`);
    const contents = contentsOf(definition);
    return {
      name: built.name,
      version: built.version,
      tarball: built.tarball,
      integrity: built.integrity,
      negative: built.negative,
      ...(contents === null ? {} : { contents }),
      ...(definition.manifest["dependencies"] === undefined
        ? {}
        : { dependencies: definition.manifest["dependencies"] }),
      ...(definition.manifest["main"] === undefined ? {} : { main: definition.manifest["main"] }),
      ...(definition.manifest["type"] === undefined ? {} : { type: definition.manifest["type"] }),
      ...(definition.manifest["bin"] === undefined ? {} : { bin: definition.manifest["bin"] }),
      ...(definition.manifest["exports"] === undefined ? {} : { exports: definition.manifest["exports"] }),
    };
  });

  const manifest = {
    formatVersion: CORPUS_FORMAT_VERSION,
    generatedBy: "tools/build-corpus.ts",
    note:
      "Synthetic dependency corpus. `@corpus/*` is normal-test only; `@corpus-broken/*` is negative-test only and may " +
      "not be referenced by any fixture. Integrity values are sha512 of the committed tarball bytes, and the bytes are " +
      "the artifact: regenerating them is a separate, reviewable change.",
    packages: entries,
  };

  return { packages, manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n` };
}

export interface CorpusWriteResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly drifted: readonly string[];
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/**
 * Write the corpus, or check it.
 *
 * `check` compares bytes rather than trusting the manifest, because a manifest that agrees with a stale tarball is
 * exactly the failure this has to catch. Drift is reported per package, so the message says which artifact changed.
 */
export async function runCorpusBuild(
  args: readonly string[],
  root: string,
  io: {
    readonly mkdir: (path: string) => void;
    readonly write: (path: string, bytes: Uint8Array) => void;
    readonly read: (path: string) => Uint8Array | string;
    readonly exists: (path: string) => boolean;
  },
): Promise<CorpusWriteResult> {
  const check = args.includes("--check");
  const built = buildCorpus();
  const lines: string[] = [];
  const written: string[] = [];
  const unchanged: string[] = [];
  const drifted: string[] = [];

  const manifestPath = `${root}/${CORPUS_ROOT}/manifest.json`;

  for (const pkg of built.packages) {
    const path = `${root}/${CORPUS_ROOT}/${pkg.tarball}`;
    if (check) {
      if (!io.exists(path)) {
        drifted.push(pkg.tarball);
        lines.push(`${pkg.name}@${pkg.version}: tarball missing at ${CORPUS_ROOT}/${pkg.tarball}`);
        continue;
      }
      const onDisk = io.read(path);
      const diskBytes = typeof onDisk === "string" ? new TextEncoder().encode(onDisk) : onDisk;
      const same = diskBytes.byteLength === pkg.bytes.byteLength && diskBytes.every((byte, index) => byte === pkg.bytes[index]);
      (same ? unchanged : drifted).push(pkg.tarball);
      if (!same) lines.push(`${pkg.name}@${pkg.version}: committed tarball differs from a fresh build`);
      continue;
    }
    const directory = path.slice(0, path.lastIndexOf("/"));
    io.mkdir(directory);
    io.write(path, pkg.bytes);
    written.push(pkg.tarball);
  }

  if (check) {
    if (io.exists(manifestPath)) {
      const onDisk = io.read(manifestPath);
      const text = typeof onDisk === "string" ? onDisk : new TextDecoder().decode(onDisk);
      if (text !== built.manifestText) drifted.push("manifest.json");
      if (text !== built.manifestText) lines.push("manifest.json differs from the generated manifest");
    } else {
      drifted.push("manifest.json");
      lines.push("manifest.json is missing");
    }
  } else {
    io.mkdir(`${root}/${CORPUS_ROOT}`);
    io.write(manifestPath, new TextEncoder().encode(built.manifestText));
    written.push("manifest.json");
  }

  const summary = check
    ? `${built.packages.length} corpus package(s): ${unchanged.length} unchanged, ${drifted.length} drifted`
    : `${built.packages.length} corpus package(s) written, manifest.json written`;
  return {
    written,
    unchanged,
    drifted,
    lines: [summary, ...lines],
    exitCode: check && drifted.length > 0 ? 1 : 0,
  };
}
