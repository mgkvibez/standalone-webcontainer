/**
 * Probe: does every bare import in ONE response get the SAME optimizer hash?
 *
 * The browser acceptance lane reports `504 Outdated Optimize Dep` for two modules at once, and the two specifiers it was given in a single
 * transform carried DIFFERENT `?v=` hashes (`react` v=0e95e6a6, `react-dom_client` v=b2f6dbb2). Vite gives every pre-bundled file the metadata's
 * one browserHash, so two values in one response means the metadata changed between the two lookups - the optimizer ran, then ran again.
 * A 504 is what a browser gets for asking with the older hash.
 *
 * The offline snapshot probe cannot show this: it holds only one bare-importable package, so there is no second lookup to disagree with the
 * first. This probe therefore installs the same three packages the acceptance lane installs, from the real registry, and asks the same
 * question of the same server - without a browser in the way.
 *
 * Run: `npx vite-node tools/probe-optimizer-hash.ts`
 */
import { Container } from "../src/container/container.js";
import { createNetworkRegistry } from "../src/registry/network.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const files = new MapFiles({
  "package.json": JSON.stringify(
    {
      name: "probe-hash",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { vite: "^5.4.11" },
    },
    null,
    2,
  ),
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>hash</title></head>
<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>
`,
  "src/main.js": `import { createElement } from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")).render(createElement("h1", { id: "greeting" }, "hello-v1"));
`,
});

const runtime = new InProcessClient();
// The real registry, because the browser product installs from it and a snapshot holding no react cannot ask this question at all.
const container = new Container({ runtime, files, registry: createNetworkRegistry() });
const session = container.createSession("probe");

const say = (label: string, value: string): void => console.log(`${label}: ${value}`);
const hashes = (body: string): string[] => [...body.matchAll(/deps\/([A-Za-z0-9_\-./]+)\.js\?v=([0-9a-f]+)/g)].map((m) => `${m[1]}=${m[2]}`);

await container.execute(session.id, "npm install react react-dom vite@^5.4.11");
console.log(session.scrollback.map((line) => line.text).join("\n").split("\n").slice(-4).join("\n"));

await container.execute(session.id, "npm run dev -- --port 3300 --host 127.0.0.1");
const process = container.processes().at(-1);
say("dev process", `${process?.state} ports=${(process?.previewPorts ?? []).join(",")}`);

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const response = await runtime.probe(`http://localhost:3300${path}`);
  return { status: response.status, body: response.body };
};

/** A pause between rounds, so a second optimizer pass has a chance to land between two identical requests. */
const reportPauseMs = 800;

for (const round of [1, 2, 3]) {
  const main = await get("/src/main.js");
  const seen = hashes(main.body);
  say(`round ${round} GET /src/main.js`, `status ${main.status} hashes=${seen.join(" ")}`);
  const distinct = new Set(seen.map((entry) => entry.split("=")[1]));
  say(`round ${round} distinct hashes in one response`, String(distinct.size));
  const specifiers = [...main.body.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string" && value.startsWith("/"));
  for (const specifier of specifiers) {
    const answer = await get(specifier);
    say(`  GET ${specifier}`, `status ${answer.status} ${answer.body.length} bytes`);
  }
  await new Promise((resolve) => setTimeout(resolve, reportPauseMs));
}

// What the optimizer left behind, read from inside a program: the metadata's browserHash is the one every specifier should agree with.
files.write(
  "/inspect.mjs",
  `import { readdirSync, readFileSync, existsSync } from "node:fs";
const dir = "/node_modules/.vite/deps";
console.log("deps dir exists: " + existsSync(dir));
if (existsSync(dir)) {
  console.log("  entries: " + readdirSync(dir).join(", "));
  const meta = dir + "/_metadata.json";
  if (existsSync(meta)) {
    const parsed = JSON.parse(readFileSync(meta, "utf8"));
    console.log("  browserHash: " + parsed.browserHash);
    console.log("  optimized: " + Object.keys(parsed.optimized ?? {}).join(", "));
    console.log("  chunks: " + Object.keys(parsed.chunks ?? {}).join(", "));
  }
}
`,
);
await container.execute(session.id, "node inspect.mjs");
console.log(session.scrollback.map((line) => line.text).join("\n").split("node inspect.mjs").at(-1)?.trim());
