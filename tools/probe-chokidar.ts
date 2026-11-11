/**
 * Probe: can a program in the runtime resolve `chokidar` at all?
 *
 * `tools/probe-vite-watch.ts` measured that Vite serves the old module after an editor's save reaches the runtime, and a temporary log in the watch
 * registry showed Vite never registers a single file watch. Vite 5 watches with chokidar and the vite fixture installs from an offline snapshot of
 * eight packages, so the honest question is not "why did Vite not invalidate" but "was there a watcher to invalidate it": if the dependency cannot
 * resolve, Vite's createServer has nothing to degrade to except silence.
 *
 * Run: `npx vite-node tools/probe-chokidar.ts`
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

const files = new MapFiles({
  "package.json": JSON.stringify(
    { name: "probe-chokidar", private: true, version: "0.0.0", type: "module", devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "probe.js": `for (const name of ["chokidar", "fsevents"]) {
  try {
    const loaded = require(name);
    console.log(name + " -> loaded (" + Object.keys(loaded).slice(0, 5).join(",") + ")");
  } catch (error) {
    console.log(name + " -> " + error.code + ": " + error.message.split("\\n")[0]);
  }
}
console.log("require.resolve is " + typeof require.resolve);
`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe-chokidar");

await container.execute(session.id, "npm install");
await container.execute(session.id, "node probe.js");
const record = container.processes().at(-1);
console.log(`--- stdout\n${record?.stdout ?? "(none)"}`);
console.log(`--- stderr\n${record?.stderr ?? "(none)"}`);
