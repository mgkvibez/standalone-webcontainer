/**
 * Probe: does a VFS edit reach Vite's own watcher, so the *next* request serves the new transform?
 *
 * ADR-0024 amendment 1 leaves one question open before the host-driven reload is worth building: the dev server served a stale
 * transform after an edit, because nothing invalidated its module graph. `tools/probe-vite-reload.ts` measured that with calls back
 * to back, which gives the watcher no time to act — a poll interval is 20 ms of *real* time and the two requests were microseconds
 * apart. So the earlier answer ("stale, ?t= does not help") is right and says nothing about the watch path.
 *
 * This probe asks the same question with real time in between: serve, edit, wait, serve again. If the second answer is the new file,
 * then the invalidation signal already exists (VFS change -> watch registry -> fs.watch -> chokidar -> module graph) and the work
 * that remains is the reload and nothing else. If it is still stale after seconds, the watch path is broken and must be fixed first,
 * exactly as the amendment orders.
 *
 * Run: `npx vite-node tools/probe-vite-watch.ts`
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
    { name: "probe-watch", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>watch</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `document.getElementById("root").textContent = "before-edit";\n`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe-watch");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await container.execute(session.id, "npm install");
await container.execute(session.id, "npm run dev -- --port 3305 --host 127.0.0.1");
const dev = container.processes().at(-1);
console.log(`dev: ${dev?.state}`);

const url = "http://localhost:3305/src/main.js";
const first = await runtime.probe(url);
console.log(`1. GET /src/main.js -> ${first.status}, before-edit: ${first.body.includes("before-edit")}`);

const edited = 'document.getElementById("root").textContent = "after-edit";\n';
files.write("/src/main.js", edited);
console.log("2. saved /src/main.js in the page's project store");

const sync = await container.syncFiles({ "/src/main.js": edited });
console.log(`3. pushed it into the live runtime: ${JSON.stringify(sync)}`);

for (const wait of [50, 200, 1000, 3000]) {
  await sleep(wait);
  const probe = await runtime.probe(url);
  console.log(
    `4. +${wait} ms -> ${probe.status}, after-edit: ${probe.body.includes("after-edit")}, before-edit: ${probe.body.includes("before-edit")}`,
  );
}

console.log(`--- dev stdout tail\n${(container.processes().at(-1)?.stdout ?? "").split("\n").slice(-12).join("\n")}`);
console.log(`--- dev stderr tail\n${(container.processes().at(-1)?.stderr ?? "").split("\n").slice(-12).join("\n")}`);
