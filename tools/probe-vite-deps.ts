/**
 * Probe: does `vite dev` pre-bundle a bare import (the dependency optimizer)?
 *
 * Every fixture measured so far imports only relative specifiers, so none of them ever reaches `optimizeDeps`. This probe asks the
 * question with a package the frozen vite snapshot already holds, so the answer needs no network: `picocolors` is a dependency of
 * vite itself and is a plain CommonJS module, which is exactly the shape the optimizer has to convert before the browser can
 * import it.
 *
 * The measurement is three facts, not an impression:
 *   1. what `/src/main.js` comes back as — vite rewrites a bare specifier only after the dep has been optimized;
 *   2. whether the rewritten file can be fetched;
 *   3. whether the optimizer's cache directory exists in the runtime VFS.
 *
 * Run: `npx vite-node tools/probe-vite-deps.ts`
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
    {
      name: "probe-deps",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite" },
      devDependencies: { vite: "^5.4.0" },
    },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>deps</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `import pc from "picocolors";
import { double } from "./math.js";

document.title = pc.green(\`double =\`) + double(21);
`,
  "src/math.js": `export const double = (value) => value * 2;\n`,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry });
const session = container.createSession("probe");

const say = (label: string, value: string): void => {
  console.log(`${label}: ${value}`);
};

await container.execute(session.id, "npm install");
const installed = session.scrollback.map((line) => line.text).join("\n");
console.log(installed.split("\n").slice(-3).join("\n"));
console.log(`picocolors in vfs: ${runtime.readFile("/node_modules/picocolors/package.json") === null ? "no" : "yes"}`);

await container.execute(session.id, "npm run dev -- --port 3300 --host 127.0.0.1");
const process = container.processes().at(-1);
say("dev process", `${process?.state} ports=${(process?.previewPorts ?? []).join(",")}`);

/** The gateway is the only client a browser has, so it is the only honest way to ask. */
const get = async (path: string): Promise<{ status: number; body: string }> => {
  const response = await runtime.probe(`http://localhost:3300${path}`);
  return { status: response.status, body: response.body };
};

const main = await get("/src/main.js");
say("GET /src/main.js", `status ${main.status}`);
console.log(main.body.slice(0, 900));

const rewritten = /from\s+"([^"]*picocolors[^"]*)"/.exec(main.body)?.[1] ?? null;
say("picocolors specifier after transform", rewritten ?? "<not rewritten>");

// When does the optimizer's file actually appear? Asked from outside the dev server, without a request in flight, so the number is the
// optimizer's own duration rather than how fast a request-bound pump happened to drive it.
const startedWaiting = Date.now();
let appearedAt: number | null = null;
for (let waited = 0; waited < 60_000; waited += 250) {
  if (runtime.readFile("/node_modules/.vite/deps/picocolors.js") !== null) {
    appearedAt = Date.now() - startedWaiting;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
say("optimizer wrote picocolors.js", appearedAt === null ? "never within 60s" : `after ${appearedAt}ms`);

if (rewritten !== null && rewritten.startsWith("/")) {
  // What a browser does, in order. Vite answers `504 Outdated Optimize Dep` while it is writing the pre-bundled copy, the browser
  // reloads, gets a fresh specifier and asks again. Measuring only the first request would report the reload as a failure, which is
  // how this looked before the optimizer finished at all.
  const startedAt = Date.now();
  const first = await get(rewritten);
  say(`GET ${rewritten}`, `status ${first.status} after ${Date.now() - startedAt}ms`);
  console.log(`  body: ${first.body.slice(0, 120).replace(/\n/g, " | ")}`);

  const reloaded = await get("/src/main.js");
  const fresh = /from\s+"([^"]*picocolors[^"]*)"/.exec(reloaded.body)?.[1] ?? null;
  say("specifier after reload", fresh ?? "<not rewritten>");

  if (fresh !== null) {
    const second = await get(fresh);
    say(`GET ${fresh}`, `status ${second.status}, ${second.body.length} bytes`);
    console.log(second.body.slice(0, 400).replace(/\n/g, "\n  "));
  }
}

// Ask the container, from inside a program, what the optimizer left on disk. The optimizer's cache is a write the runtime has to
// serve, so a directory listing is the measurement, not a guess at a path.
files.write(
  "/inspect.mjs",
  `import { readdirSync, readFileSync, existsSync } from "node:fs";

const dir = "/node_modules/.vite/deps";
console.log("deps dir exists: " + existsSync(dir));
if (existsSync(dir)) {
  for (const name of readdirSync(dir)) {
    const body = readFileSync(dir + "/" + name, "utf8");
    console.log("  " + name + " " + body.length + " bytes");
    if (name.endsWith(".json")) console.log("    " + body.split(String.fromCharCode(10)).join(" "));
  }
}
console.log("project .vite exists: " + existsSync("/node_modules/.vite"));
console.log("install marker: " + existsSync("/node_modules/picocolors/package.json"));
`,
);

await container.execute(session.id, "node inspect.mjs");
const inspect = session.scrollback.filter((line) => line.stream === "stdout").map((line) => line.text).join("\n");
console.log("--- inspect.mjs ---");
console.log(inspect);
const errors = session.scrollback.filter((line) => line.stream === "stderr").map((line) => line.text).join("\n");
if (errors !== "") console.log(`--- inspect stderr ---\n${errors}`);

// What the dev server itself said. An optimizer failure is logged by vite on the server, not returned to the client, so the
// process record is where the reason lives. This is the step that turns "the request hangs" into a cause.
const dev = container.processes().find((entry) => entry.state === "running" && (entry.previewPorts?.length ?? 0) > 0);
console.log("--- dev stdout (tail) ---");
console.log((dev?.stdout ?? "<none>").slice(-2500));
console.log("--- dev stderr (tail) ---");
console.log((dev?.stderr ?? "<none>").slice(-2500));
