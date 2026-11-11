/**
 * Probe: does `define` reach the code in `vite build`, where vite's own source says it is applied?
 *
 * Reading vite 5.4.21's shipped source answers the dev question (see docs/audit/vite-config-bare-import.md): the `vite:define` plugin returns
 * early in dev (`if (!ssr && !isBuild) return;`), so a user `define` is NOT substituted into dev-served source, and nothing in this runtime
 * failed when it came back unreplaced. Build is the other branch, and there the substitution is real work: esbuild receives `define` and
 * rewrites the constant. So the honest follow-up question is whether it happens here, through esbuild-wasm, with the output written to disk.
 *
 * Run: `npx vite-node tools/probe-vite-define.ts`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Container } from "../src/container/container.js";
import { loadSnapshotRegistry } from "../src/registry/snapshot.js";
import { repoRoot, InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const directory = "fixtures/snapshots/vite";
const root = join(repoRoot, directory);
const registry = loadSnapshotRegistry({
  slug: "vite",
  root,
  manifestText: readFileSync(join(root, "snapshot.json"), "utf8"),
  read: (path) => new Uint8Array(readFileSync(path)),
});

const files = new MapFiles({
  "package.json": JSON.stringify(
    { name: "probe-define", private: true, version: "0.0.0", type: "module", scripts: { build: "vite build" }, devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>define</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `document.getElementById("root").textContent = __DEFINED_VALUE__;\nconsole.log(__DEFINED_VALUE__);\n`,
  "vite.config.js": `export default { define: { __DEFINED_VALUE__: JSON.stringify("define-worked") } };\n`,
  // A program is the only place that can read the built output, and reading it is the measurement.
  "inspect.mjs": `import { readdirSync, readFileSync } from "node:fs";

const dir = "/dist/assets";
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".js")) continue;
  const body = readFileSync(dir + "/" + name, "utf8");
  console.log(name + " " + body.length + " bytes");
  console.log("  contains define-worked: " + body.includes("define-worked"));
  console.log("  still contains __DEFINED_VALUE__: " + body.includes("__DEFINED_VALUE__"));
}
`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");

await container.execute(session.id, "npm install");
console.log(`install ok: vite in vfs ${runtime.readFile("/node_modules/vite/package.json") === null ? "no" : "yes"}`);

await container.execute(session.id, "npm run build");
console.log(session.scrollback.map((line) => line.text).join("\n").split("\n").slice(-6).join("\n"));

await container.execute(session.id, "node inspect.mjs");
console.log(session.scrollback.map((line) => line.text).join("\n").split("\n").slice(-4).join("\n"));
