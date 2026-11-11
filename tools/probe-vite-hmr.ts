/**
 * Probe: what happens to a websocket handshake aimed at `vite dev` through the preview gateway?
 *
 * Nothing in the corpus opens a websocket, and the http shim says so: it implements request/response and keep-alive, "not TLS/HTTP2 and not
 * the `upgrade` event, which is why websockets in the browser lane are a later, separate problem". This probe measures that gap instead of
 * trusting the comment, because Vite's whole dev experience (hot update, error overlay, full reload) rides on one socket.
 *
 * A handshake is an ordinary GET with `Connection: Upgrade`, so the question has a measurable answer: does the preview answer 101, or does it
 * answer like a plain GET and leave the client to retry forever?
 *
 * Run: `npx vite-node tools/probe-vite-hmr.ts`
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
    { name: "probe-hmr", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>hmr</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `document.getElementById("root").textContent = "hmr probe";\n`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");

await container.execute(session.id, "npm install");
await container.execute(session.id, "npm run dev -- --port 3302 --host 127.0.0.1");
const devProcess = container.processes().at(-1);
console.log(`dev process: ${devProcess?.state} ports=${(devProcess?.previewPorts ?? []).join(",")}`);

const page = await runtime.probe("http://localhost:3302/");
console.log(`GET / -> ${page.status}, mentions /@vite/client: ${page.body.includes("/@vite/client")}`);

const client = await runtime.probe("http://localhost:3302/@vite/client");
console.log(`GET /@vite/client -> ${client.status}, ${client.body.length} bytes`);
// What the client will dial, straight out of the injected config: this is the socket the page will open.
const dial = /__HMR_(?:HOSTNAME|HOST|PORT|PROTOCOL)__/.test(client.body) ? "unreplaced placeholders" : "config injected";
console.log(`  client hmr config: ${dial}`);

const handshake = await runtime.probeWith("http://localhost:3302/", {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
  "sec-websocket-protocol": "vite-hmr",
});
console.log(`UPGRADE / -> ${handshake.status} (a real dev server answers 101), ${handshake.body.length} bytes`);
console.log(`  answered like a plain GET: ${handshake.body.includes("<div id=\"root\">")}`);
console.log(`  mentions 101 or upgrade in body: ${/101|upgrade/i.test(handshake.body)}`);

console.log(`--- dev stdout\n${devProcess?.stdout ?? ""}`);
console.log(`--- dev stderr\n${devProcess?.stderr ?? ""}`);
