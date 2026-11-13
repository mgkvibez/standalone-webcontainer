/**
 * A measurement: install what the acceptance journey installs, through the real product installer and the real registry, in Node.
 *
 * This exists because a browser spec that hangs tells you nothing about which side hung. The same install here either finishes (and the browser
 * has a different problem) or does not (and the installer does), and either answer is worth more than another five-minute Playwright timeout.
 */

import { installDependencies } from "../src/npm/install.js";
import { createNetworkRegistry } from "../src/registry/network.js";

const registry = createNetworkRegistry();
const files = new Map<string, string | Uint8Array>();
const start = Date.now();

const report = await installDependencies(
  { name: "react-app", version: "0.0.0", dependencies: { react: "latest", "react-dom": "latest", vite: "^5.4.11" } },
  {
    registry,
    root: "/",
    writeLockfile: true,
    vfs: { mkdirSync: () => undefined, writeFileSync: (path, data) => files.set(path, data) },
  },
);

const stats = registry.stats();
console.log(`installed   ${String(report.packages.length)} packages, ${String(files.size)} files in ${String(Date.now() - start)}ms`);
console.log(`roots       ${report.packages.filter((entry) => !entry.path.includes("node_modules/", 3)).map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
console.log(`peers       ${String(report.peers.length)} satisfied: ${report.peers.map((peer) => `${peer.requiredBy}->${peer.name}@${peer.version}`).join(", ")}`);
console.log(`lifecycle   ${String(report.lifecycle.length)} package(s) with install scripts`);
console.log(`warnings    ${report.warnings.length === 0 ? "none" : report.warnings.join(" | ")}`);
console.log(`network     metadata=${String(stats.metadataRequests)} tarballs=${String(stats.tarballRequests)} MB=${(stats.bytesDownloaded / 1_048_576).toFixed(1)}`);
