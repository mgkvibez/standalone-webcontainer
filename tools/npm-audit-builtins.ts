/**
 * Which Node builtins do a real dependency graph's packages actually require?
 *
 * Same reason as the range bug: a synthetic corpus names the builtins its author thought of. This walks the real installed tree and
 * reports, per builtin, how many packages require it and which ones, so the shim work is ordered by evidence.
 */
import { builtinModules } from "node:module";

import { createHttpRegistryClient, installDependencies } from "../src/npm/install.js";

const [name, range] = [process.argv[2] ?? "express", process.argv[3] ?? "4.21.2"];
const staged = new Map<string, string>();
const report = await installDependencies(
  { name: "audit", version: "0.0.0", dependencies: { [name]: range } },
  {
    registry: createHttpRegistryClient(),
    root: "/",
    lockfile: null,
    requireLockfile: false,
    includeDev: false,
    writeLockfile: false,
    vfs: { mkdirSync: () => undefined, writeFileSync: (path, data) => staged.set(path, typeof data === "string" ? data : new TextDecoder().decode(data)) },
  },
);

const implemented = new Set(["fs", "path", "process", "buffer", "events", "stream", "tty", "http", "node:test"]);
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const users = new Map<string, Set<string>>();

for (const [path, contents] of staged) {
  if (!path.includes("/node_modules/") || !/\.(c|m)?js$/.test(path)) continue;
  const owner = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1] ?? "?";
  for (const match of contents.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const bare = (match[1] ?? "").replace(/^node:/, "").replace(/\/.*$/, "");
    if (!builtins.has((match[1] ?? "").replace(/^node:/, ""))) continue;
    if (!builtins.has(bare)) continue;
    const set = users.get(bare) ?? new Set<string>();
    set.add(owner);
    users.set(bare, set);
  }
}
const rows = [...users.entries()].sort((a, b) => b[1].size - a[1].size);
console.log(`${name}@${range}: ${report.packages.length} packages, ${staged.size} files\n`);
for (const [mod, owner] of rows) {
  console.log(`${implemented.has(mod) ? "have " : "MISS "} ${mod.padEnd(14)} ${String(owner.size).padStart(3)}  ${[...owner].slice(0, 6).join(", ")}`);
}
