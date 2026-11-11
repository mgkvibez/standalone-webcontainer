/**
 * Probe: what does Vite's own watcher look like inside this runtime, and does it survive creation?
 *
 * `tools/probe-vite-watch.ts` measured that an editor's save reaches the runtime, and instrumenting the kernel's watch registry showed Vite
 * registers no file watch at all. That rules out the invalidations being lost on our side of the boundary; the question moves to what Vite built
 * for itself. So this probe asks Vite directly: create a dev server, then inspect `server.watcher` — its constructor, its options, and whether it
 * is the no-op watcher Vite substitutes when a real one cannot be created. Then edit a file and see whether the module graph notices.
 *
 * Run: `npx vite-node tools/probe-vite-watcher.ts`
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

const program = `const { createServer } = require("vite");

const describe = (value) => {
  if (value === null || value === undefined) return String(value);
  const name = value.constructor === undefined ? "?" : value.constructor.name;
  const keys = Object.keys(value).slice(0, 12).join(",");
  return name + " {" + keys + "}";
};

(async () => {
  console.log("chokidar resolvable from the program: " + (() => {
    try { require("chokidar"); return "yes"; } catch (error) { return error.code; }
  })());
  const server = await createServer({
    root: "/",
    logLevel: "silent",
    server: { port: 3311, host: "127.0.0.1", watch: {} },
  });
  console.log("watcher: " + describe(server.watcher));
  console.log("watcher.on is " + typeof server.watcher.on);
  const events = [];
  server.watcher.on("change", (path) => { events.push(path); console.log("watcher saw change: " + path); });
  server.watcher.on("all", (event, path) => { events.push(event + ":" + path); });
  server.watcher.on("error", (error) => { console.log("watcher error: " + error.message); });
  console.log("watcher.getWatched keys before: " + Object.keys(server.watcher.getWatched ? server.watcher.getWatched() : {}).slice(0, 10).join(","));
  globalThis.__probeServer = server;
  globalThis.__probeEvents = events;
})().catch((error) => {
  console.log("createServer failed: " + error.message);
});
`;

const files = new MapFiles({
  "package.json": JSON.stringify(
    { name: "probe-watcher", private: true, version: "0.0.0", type: "module", devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
  "src/main.js": `document.getElementById("root").textContent = "before-edit";\n`,
  "probe.js": program,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe-watcher");

await container.execute(session.id, "npm install");
await container.execute(session.id, "node probe.js");
const record = container.processes().at(-1);
console.log(`--- probe stdout\n${record?.stdout ?? "(none)"}`);
console.log(`--- probe stderr\n${record?.stderr ?? "(none)"}`);
