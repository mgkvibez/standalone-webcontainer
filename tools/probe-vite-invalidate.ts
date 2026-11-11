/**
 * Probe: once a dev server exists, does a save reach its watcher and change what it serves?
 *
 * The two earlier probes each answered half of this and disagreed about the other half. `probe-vite-watcher` shows a dev server created by a program
 * has a real FSWatcher (chokidar is bundled inside vite, not resolvable separately) watching `/`; `probe-vite-watch` shows `npm run dev` serving
 * the old module three seconds after the save was pushed into the runtime. This probe holds the server in the program that created it, so the
 * watcher, the module graph and the served bytes are all the same object, and logs the watcher's own events next to the answer.
 *
 * Run: `npx vite-node tools/probe-vite-invalidate.ts`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Container } from "../src/container/container.js";
import { loadSnapshotRegistry } from "../src/registry/snapshot.js";
import { repoRoot, InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const root = join(repoRoot, "fixtures/snapshots/vite");
const registry = loadSnapshotRegistry({
  slug: "vite",
  root,
  manifestText: readFileSync(join(root, "snapshot.json"), "utf8"),
  read: (path) => new Uint8Array(readFileSync(path)),
});

const server = `const { createServer } = require("vite");

(async () => {
  const vite = await createServer({ root: "/", logLevel: "silent", server: { port: 3313, host: "127.0.0.1" } });
  vite.watcher.on("change", (path) => console.log("watcher change: " + path));
  vite.watcher.on("add", (path) => console.log("watcher add: " + path));
  vite.watcher.on("all", (event, path) => console.log("watcher all: " + event + " " + path));
  const original = vite.moduleGraph.getModuleById("/src/main.js");
  const before = vite.moduleGraph.getModulesByFile("/src/main.js");
  console.log("module graph before: " + (before === undefined ? "none" : before.size));
  await vite.listen();
  vite.watcher.on("ready", () => console.log("watcher ready"));
})().catch((error) => console.log("failed: " + error.message));
`;

const files = new MapFiles({
  "package.json": JSON.stringify({ name: "probe-invalidate", private: true, version: "0.0.0", type: "module", devDependencies: { vite: "^5.4.0" } }, null, 2),
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
  "src/main.js": `document.getElementById("root").textContent = "before-edit";\n`,
  "server.js": server,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe-invalidate");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await container.execute(session.id, "npm install");
const running = container.execute(session.id, "node server.js");
let ready = false;
for (let waited = 0; waited < 5_000 && !ready; waited += 100) {
  ready = await runtime.probe("http://localhost:3313/index.html").then((answer) => answer.status === 200, () => false);
  if (!ready) await sleep(100);
}
console.log(`listening: ${ready}`);

const fetchModule = async (): Promise<string> => {
  const answer = await runtime.probe("http://localhost:3313/src/main.js");
  return `${answer.status} before=${answer.body.includes("before-edit")} after=${answer.body.includes("after-edit")}`;
};

console.log(`1. GET /src/main.js -> ${await fetchModule()}`);
const sync = await container.syncFiles({ "/src/main.js": `document.getElementById("root").textContent = "after-edit";\n` });
console.log(`2. pushed: ${JSON.stringify(sync)}`);
for (const delay of [200, 1000, 3000]) {
  await sleep(delay);
  console.log(`3. +${delay} ms -> ${await fetchModule()}`);
}

const record = container.processes().at(-1);
console.log(`--- server stdout\n${record?.stdout ?? "(none)"}`);
console.log(`--- server stderr\n${record?.stderr ?? "(none)"}`);
void running;
process.exit(0);
