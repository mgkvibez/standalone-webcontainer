/**
 * Probe: if the host reloads the preview after an edit, does the dev server actually serve the new file?
 *
 * ADR-0024 says "edit, then see it" must be host-driven, because the preview carries no server push. A reload is only worth building if the
 * served bytes change, and Vite keeps a transform cache keyed by module id: a file edited behind its back, with no watcher event to invalidate
 * the cache, may still serve the old transform. So this asks the narrow question before any UI work:
 *
 *   1. serve the module, remember its bytes;
 *   2. change the file in the VFS, the way the editor does;
 *   3. request it again, plain and with `?t=`, and see which answer is the new one.
 *
 * Run: `npx vite-node tools/probe-vite-reload.ts`
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
    { name: "probe-reload", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>reload</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `document.getElementById("root").textContent = "before-edit";\n`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");

await container.execute(session.id, "npm install");
await container.execute(session.id, "npm run dev -- --port 3303 --host 127.0.0.1");
console.log(`dev: ${container.processes().at(-1)?.state}`);

const url = "http://localhost:3303/src/main.js";
const first = await runtime.probe(url);
console.log(`GET /src/main.js -> ${first.status}, before-edit: ${first.body.includes("before-edit")}`);

files.write("/src/main.js", 'document.getElementById("root").textContent = "after-edit";\n');
console.log("edited /src/main.js in the VFS");

const plain = await runtime.probe(url);
console.log(`GET /src/main.js (plain)  -> ${plain.status}, after-edit: ${plain.body.includes("after-edit")}, before-edit: ${plain.body.includes("before-edit")}`);

const busted = await runtime.probe(`${url}?t=${Date.now()}`);
console.log(`GET /src/main.js?t=…    -> ${busted.status}, after-edit: ${busted.body.includes("after-edit")}, before-edit: ${busted.body.includes("before-edit")}`);

const fresh = await runtime.probe(`${url}?reload=${Date.now()}`);
console.log(`GET ?reload=…           -> ${fresh.status}, after-edit: ${fresh.body.includes("after-edit")}`);

const page = await runtime.probe("http://localhost:3303/");
console.log(`GET / (html) -> ${page.status}, script src: ${/src="([^"]+)"/.exec(page.body)?.[1] ?? "none"}`);

// Does the server read the file from the VFS on each request at all? A second edit, requested twice, separates "cached transform" from
// "cached file read".
files.write("/src/main.js", 'document.getElementById("root").textContent = "third-edit";\n');
const third = await runtime.probe(url);
console.log(`after a 2nd edit, plain -> ${third.status}, third-edit: ${third.body.includes("third-edit")}`);
console.log(`--- dev stdout tail\n${(container.processes().at(-1)?.stdout ?? "").split("\n").slice(-6).join("\n")}`);
