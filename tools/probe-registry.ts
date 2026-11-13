/**
 * A measurement, not a test: what the product's registry client actually gets from the public npm registry today.
 *
 * Run with `npx vite-node tools/probe-registry.ts`. It prints one line per fact so a reader can paste it into a report, and it exits non-zero on a
 * refusal - which is how a probe differs from a demo.
 */

import { installDependencies } from "../src/npm/install.js";
import { createNetworkRegistry } from "../src/registry/network.js";

const registry = createNetworkRegistry();

const millis = (start: number): string => `${String(Date.now() - start)}ms`;

async function main(): Promise<void> {
  const packumentStart = Date.now();
  const react = await registry.packument("react");
  const reactVersions = Object.keys(react.versions).length;
  const latest = react["dist-tags"]?.["latest"] ?? "none";
  const chosen = react.versions[latest];
  console.log(`react          versions=${String(reactVersions)} latest=${latest} ${millis(packumentStart)}`);
  console.log(`react dist     ${chosen === undefined ? "missing" : `${chosen.dist.tarball} ${chosen.dist.integrity ?? "no integrity"}`}`);

  const scoped = await registry.packument("@vitejs/plugin-react");
  console.log(`@vitejs/plugin-react versions=${String(Object.keys(scoped.versions).length)}`);

  const before = registry.stats();
  const bytes = await registry.tarball("https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz");
  console.log(`is-odd tarball bytes=${String(bytes.byteLength)} after=${millis(packumentStart)}`);

  const again = await registry.tarball("https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz");
  const stats = registry.stats();
  console.log(
    `cache         hit=${String(again.byteLength === bytes.byteLength)} tarballRequests=${String(stats.tarballRequests)} ${String(before.tarballRequests)}`,
  );

  const staged = new Map<string, string | Uint8Array>();
  const installStart = Date.now();
  const report = await installDependencies(
    { name: "probe", version: "0.0.0", dependencies: { "is-odd": "^3.0.0" } },
    {
      registry,
      root: "/",
      writeLockfile: true,
      vfs: { mkdirSync: () => undefined, writeFileSync: (path, data) => staged.set(path, data) },
    },
  );
  console.log(`install        packages=${String(report.packages.length)} files=${String(staged.size)} ${millis(installStart)}`);
  console.log(`install lock   ${String(Object.keys(report.lockfile.packages).length)} entries`);
  const final = registry.stats();
  console.log(
    `stats          metadata=${String(final.metadataRequests)} hits=${String(final.metadataCacheHits)} tarballs=${String(final.tarballRequests)} bytes=${String(final.bytesDownloaded)}`,
  );
}

await main();
