/**
 * Captures a snapshot: run a real install against the real registry, then write down exactly what it used.
 *
 * The point is not to mirror npm. It is to make a *fixture verdict* reproducible without a network: the same tarball bytes, the
 * same resolved versions, the same integrity, so a CI run measures the packages and not the registry's mood.
 *
 * The capture is driven by the real installer rather than by a hand-written dependency walk, deliberately: whatever the installer
 * resolves is what the snapshot holds, so the frozen lane and the product lane cannot drift apart in what they mean.
 *
 * Usage:
 *   npm run snapshot:build -- --slug express --out fixtures/snapshots/express express
 *   npm run snapshot:build -- --slug esm-tools is-odd@3.0.1 react@18.3.1
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { createFsShim } from "../../src/shims/fs.js";
import {
  createHttpRegistryClient,
  installDependencies,
  type InstallReport,
  type Packument,
  type RegistryClient,
} from "../../src/npm/install.js";
import { parseInstallSpec } from "../../src/npm/spec.js";
import { SNAPSHOT_FORMAT_VERSION, type SnapshotEntry, type SnapshotManifest } from "../../src/registry/snapshot.js";
import { FileSystem } from "../../src/vfs/index.js";

interface Captured {
  readonly packuments: Map<string, Packument>;
  readonly tarballs: Map<string, Uint8Array>;
}

/** Wraps a client and records every packument and tarball that passes through it. */
const recordingClient = (inner: RegistryClient, captured: Captured): RegistryClient => ({
  ...(inner.origin === undefined ? {} : { origin: inner.origin }),
  async packument(name: string): Promise<Packument> {
    const packument = await inner.packument(name);
    captured.packuments.set(name, packument);
    return packument;
  },
  async tarball(url: string): Promise<Uint8Array> {
    const bytes = await inner.tarball(url);
    captured.tarballs.set(url, bytes);
    return bytes;
  },
});

const fileStem = (name: string, version: string): string => `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const specs = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1]?.startsWith("--") !== true);
  const slug = value("--slug") ?? "snapshot";
  const out = value("--out") ?? `fixtures/snapshots/${slug}`;
  const registryUrl = value("--from") ?? "https://registry.npmjs.org";

  if (specs.length === 0) {
    console.error("usage: npm run snapshot:build -- --slug <name> [--out <dir>] [--from <registry>] <spec>...");
    return 2;
  }

  // A bare name means `latest`, exactly as `npm install express` does, so the capture describes the same install a user gets.
  const dependencies: Record<string, string> = {};
  for (const spec of specs) {
    const parsed = parseInstallSpec(spec);
    dependencies[parsed.name] = parsed.range;
  }

  const vfs = new FileSystem();
  const captured: Captured = { packuments: new Map(), tarballs: new Map() };
  const client = recordingClient(createHttpRegistryClient({ baseUrl: registryUrl }), captured);

  const started = Date.now();
  console.log(`capturing ${specs.join(", ")} from ${registryUrl}`);
  const report: InstallReport = await installDependencies(
    { name: slug, version: "0.0.0", dependencies },
    {
      registry: client,
      vfs: createFsShim(vfs),
      root: "/project",
      // A snapshot must contain the bytes the tree needs, so a lockfile from another install must not shortcut the capture.
      writeLockfile: false,
    },
  );

  const packages: Record<string, SnapshotEntry[]> = {};
  for (const installed of report.packages) {
    const packument = captured.packuments.get(installed.name);
    const version = packument?.versions[installed.version];
    if (packument === undefined || version === undefined) {
      // The installer got this package from somewhere other than a packument it fetched, which for a from-scratch capture means the
      // capture is incomplete: say so rather than write a snapshot with a hole in it.
      throw new Error(`captured no packument entry for ${installed.name}@${installed.version}`);
    }
    const url = version.dist.tarball;
    const bytes = captured.tarballs.get(url);
    if (bytes === undefined) throw new Error(`captured no tarball for ${installed.name}@${installed.version} (${url})`);
    const integrity = version.dist.integrity;
    if (integrity === undefined || !integrity.startsWith("sha512-")) {
      throw new Error(`${installed.name}@${installed.version} publishes no sha512 integrity, so it cannot be pinned`);
    }
    const entry: SnapshotEntry = {
      version: installed.version,
      integrity,
      tarball: `tarballs/${fileStem(installed.name, installed.version)}`,
      ...(version.dependencies === undefined ? {} : { dependencies: version.dependencies }),
      ...(version.optionalDependencies === undefined ? {} : { optionalDependencies: version.optionalDependencies }),
      ...(version.os === undefined ? {} : { os: version.os }),
      ...(version.cpu === undefined ? {} : { cpu: version.cpu }),
    };
    (packages[installed.name] ??= []).push(entry);
    await mkdir(join(out, "tarballs"), { recursive: true });
    await writeFile(join(out, entry.tarball), bytes);
  }

  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    source: new URL(registryUrl).host,
    capturedAt: new Date().toISOString(),
    requested: specs,
    packages,
  };

  await mkdir(out, { recursive: true });
  await writeFile(join(out, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarballCount = Object.values(packages).reduce((sum, entries) => sum + entries.length, 0);
  const bytesOnDisk = [...captured.tarballs.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  console.log(
    `wrote ${tarballCount} package(s) across ${Object.keys(packages).length} name(s) to ${relative(process.cwd(), out)} — ` +
      `${(bytesOnDisk / 1024).toFixed(0)} KB of tarballs in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
