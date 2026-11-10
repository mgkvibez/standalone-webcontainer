/**
 * Install a real package from the live registry, through the real installer.
 *
 * A **manual measurement**, never part of `verify` and never part of CI: it needs the network, and the whole point of the corpus
 * lane is that the gate does not. Use it to answer "does the pipeline handle real bytes", to find the gap that synthetic packages
 * cannot expose, and later to seed the frozen snapshot.
 *
 *   npx vite-node tools/npm-live-probe.ts express 4.21.2
 */
import { createHttpRegistryClient, installDependencies } from "../src/npm/install.js";

const [name, range] = [process.argv[2] ?? "is-odd", process.argv[3] ?? "3.0.1"];
const registry = createHttpRegistryClient();
const staged = new Map<string, string>();
let bytes = 0;
const counting = {
  async packument(n: string) {
    const p = await registry.packument(n);
    return p;
  },
  async tarball(url: string) {
    const b = await registry.tarball(url);
    bytes += b.byteLength;
    return b;
  },
};

const startedAt = Date.now();
try {
  const report = await installDependencies(
    { name: "probe", version: "0.0.0", dependencies: { [name]: range } },
    {
      registry: counting,
      root: "/",
      lockfile: null,
      requireLockfile: false,
      includeDev: false,
      writeLockfile: true,
      vfs: {
        mkdirSync: () => undefined,
        writeFileSync: (path, data) => staged.set(path, typeof data === "string" ? data : new TextDecoder().decode(data)),
      },
    },
  );
  const files = [...staged.keys()];
  console.log("OK", JSON.stringify({
    packages: report.packages.length,
    names: report.packages.map((p) => `${p.name}@${p.version}`).slice(0, 12),
    warnings: report.warnings,
    tarballBytes: bytes,
    filesStaged: files.length,
    lockfile: staged.has("/package-lock.json"),
    ms: Date.now() - startedAt,
  }, null, 1));
} catch (error) {
  console.log("FAILED", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}
