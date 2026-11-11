/**
 * Probe: does `vite dev` start when `vite.config.js` imports a BARE package?
 *
 * Vite loads a config by bundling it with esbuild and EXTERNALIZING every bare import, so a config's own `import plugin from "local-plugin"`
 * becomes a resolve-and-load performed by the dev server's process before any request exists. That is a different path from the dependency
 * optimizer's rewrite, which is request-scoped: no request can carry this specifier.
 *
 * The plugin is a package this probe writes into the project's own `node_modules` AFTER `npm install`, so the answer needs no network and the
 * frozen snapshot stays untouched. It also means the package is not in whatever the install recorded, which is exactly the interesting case.
 *
 * Run: `npx vite-node tools/probe-vite-config-plugin.ts`
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
    { name: "probe-config", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>config</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `document.title = __PLUGIN__;\n`,
  "vite.config.js": `import plugin from "local-plugin";

export default {
  plugins: [plugin()],
};
`,
  "make-plugin.mjs": `import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("/node_modules/local-plugin", { recursive: true });
writeFileSync(
  "/node_modules/local-plugin/package.json",
  JSON.stringify({ name: "local-plugin", version: "1.0.0", main: "index.js" }),
);
writeFileSync(
  "/node_modules/local-plugin/index.js",
  "console.log('local-plugin MODULE LOADED');" +
    "module.exports = function localPlugin() {" +
    "  console.log('local-plugin FACTORY CALLED');" +
    "  return {" +
    "    name: 'local-plugin'," +
    "    transform(code, id) {" +
    "      if (!id.endsWith('src/main.js')) return null;" +
    "      console.log('local-plugin TRANSFORMED ' + id);" +
    "      return { code: code.replace('__PLUGIN__', JSON.stringify('local-plugin')), map: null };" +
    "    }," +
    "  };" +
    "};",
);
console.log("plugin written");
`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");
const tail = (count = 2): string =>
  session.scrollback
    .map((line) => line.text)
    .join("\n")
    .split("\n")
    .slice(-count)
    .join("\n");

await container.execute(session.id, "npm install");
console.log(`install: ${tail(1)}`);

await container.execute(session.id, "node make-plugin.mjs");
console.log(`make-plugin: ${tail(2)}`);
console.log(`plugin on disk: ${runtime.readFile("/node_modules/local-plugin/index.js") === null ? "no" : "yes"}`);

await container.execute(session.id, "npm run dev -- --port 3301 --host 127.0.0.1");
const process = container.processes().at(-1);
console.log(`dev process: ${process?.state} ports=${(process?.previewPorts ?? []).join(",")}`);
console.log(`--- stdout\n${process?.stdout ?? ""}`);
console.log(`--- stderr\n${process?.stderr ?? ""}`);

const attempt = async (path: string): Promise<string> =>
  Promise.race([
    runtime.probe(`http://localhost:3301${path}`).then((response) => `${response.status} ${response.body.slice(0, 160).replace(/\n/g, " ")}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("gave up after 8s"), 8000)),
  ]);
console.log("GET / ->", await attempt("/"));
console.log("GET /src/main.js ->", await attempt("/src/main.js"));
