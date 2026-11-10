/**
 * Which Node builtins do a real dependency graph's packages actually need?
 *
 * Same reason as the range bug: a synthetic corpus names the builtins its author thought of. This walks the real installed tree and
 * reports, per builtin, how many packages need it and which ones, so the shim work is ordered by evidence.
 *
 * Both module systems are scanned. The first version only matched `require('x')`, which is fine for express's CommonJS graph and
 * useless for Vite's: every `import { performance } from 'node:perf_hooks'` was invisible, so the audit for the front-end lane would
 * have reported a gap of zero while the fixture failed on the first import it reached.
 *
 * "have" is not a hand-kept list either. It is read out of the runtime's own builtin table, so a shim that exists cannot be
 * reported missing and one that was removed cannot be reported present.
 */
import { readFileSync } from "node:fs";
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

/**
 * The runtime's own builtin table, read from the source that defines it.
 *
 * The top-level keys of that object are indented eight spaces; nested object keys are deeper, so this cannot pick up a method name.
 * If the literal is ever reformatted the list comes back SHORT, which errs toward reporting a shim missing when it exists: the
 * harmless direction. A stale "have" would hide a real gap, which is the direction worth engineering against.
 */
function runtimeBuiltins(): Set<string> {
  const source = readFileSync(new URL("../src/runtime/in-process.ts", import.meta.url), "utf8");
  const start = source.indexOf("builtins: {");
  if (start === -1) return new Set();
  const end = source.indexOf("\n      },", start);
  const body = source.slice(start, end === -1 ? source.length : end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    // Two spellings, because the table uses both: `zlib,` is the shorthand the identifier-shaped shims use, and
    // `http: {...}` is what a facade needs. A shorthand line has no colon at all, which is exactly why the first version of
    // this function reported nine builtins missing that the runtime already had.
    const match = /^ {8}([A-Za-z_$][\w$]*)\s*(?::|,)/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1].replace(/^node:/, ""));
  }
  return names;
}

const implemented = runtimeBuiltins();
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const users = new Map<string, Set<string>>();

for (const [path, contents] of staged) {
  if (!path.includes("/node_modules/") || !/\.(c|m)?js$/.test(path)) continue;
  const owner = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1] ?? "?";
  // Every spelling a package can use to reach a builtin: CJS require, static ESM import/re-export, and dynamic import. The
  // specifier is captured in either quote style because a graph mixes them freely.
  const specifiers = [
    ...contents.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
    ...contents.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...contents.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ];
  for (const match of specifiers) {
    const specifier = (match[1] ?? "").replace(/^node:/, "");
    if (!builtins.has(specifier)) continue;
    const set = users.get(specifier) ?? new Set<string>();
    set.add(owner);
    users.set(specifier, set);
  }
}
const rows = [...users.entries()].sort((a, b) => b[1].size - a[1].size);
console.log(`${name}@${range}: ${report.packages.length} packages, ${staged.size} files\n`);
for (const [mod, owner] of rows) {
  console.log(`${implemented.has(mod) ? "have " : "MISS "} ${mod.padEnd(14)} ${String(owner.size).padStart(3)}  ${[...owner].slice(0, 6).join(", ")}`);
}
