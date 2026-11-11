/**
 * Probe: does an esbuild build that writes to disk actually produce files here?
 *
 * `vite`'s dependency optimizer is `esbuild.context({ outdir })` plus a rebuild, and esbuild writes the result itself. Nothing else in our fixtures
 * did that: every build so far used `write: false` and read `outputFiles`. So this probe asks the narrow question first, without vite in the way:
 * one build, one output file, and then a look at the runtime VFS from the outside.
 *
 * Three facts, each printed:
 *   1. whether the build resolved at all (a hang and a refusal need different fixes);
 *   2. whether esbuild reported an output file;
 *   3. whether that file exists in the VFS afterwards, and what it contains.
 *
 * Run: `npx vite-node tools/probe-esbuild-write.ts`
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
    { name: "probe-esbuild-write", private: true, version: "0.0.0", devDependencies: { vite: "^5.4.0" } },
    null,
    2,
  ),
  "entry.ts": 'import { twice } from "./dep";\nexport const answer: number = twice(21);\n',
  "dep.ts": "export const twice = (value: number): number => value * 2;\n",
  // The program under measurement. Written as a file rather than passed as a string because it is run by the container, exactly as a project's own
  // script would be.
  "write.mjs": `import { build } from "esbuild";

const started = Date.now();
try {
  const result = await build({
    absWorkingDir: "/",
    entryPoints: ["/entry.ts"],
    bundle: true,
    format: "esm",
    outdir: "/out",
    write: true,
    logLevel: "silent",
  });
  console.log("BUILD_OK:" + JSON.stringify(result.outputFiles ?? null) + " in " + (Date.now() - started) + "ms");
} catch (error) {
  console.log("BUILD_FAILED:" + (error && (error.message || String(error))));
}
`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");

await container.execute(session.id, "npm install");
console.log(`esbuild installed: ${runtime.readFile("/node_modules/esbuild/esbuild.wasm") === null ? "no" : "yes"}`);

const started = Date.now();
await container.execute(session.id, "node write.mjs");
const scrollback = session.scrollback.map((line) => line.text).join("\n");
console.log(`run: ${Date.now() - started} ms`);
console.log(scrollback.split("\n").slice(-6).join("\n"));

const written = runtime.readFile("/out/entry.js");
console.log(`/out/entry.js: ${written === null ? "ABSENT" : `${written.length} bytes`}`);
if (written !== null) console.log(written.slice(0, 300));
