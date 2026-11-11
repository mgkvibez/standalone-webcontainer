/**
 * Probe: does `fs.watch` inside the runtime deliver an event on a write, and does the program end when it closes the watcher?
 *
 * ADR-0024 amendment 1 says a trustworthy invalidation signal comes before the host-driven reload, and records one observation it
 * could not explain: a probe program that watched a directory, wrote a file and closed the watcher after 1 200 ms never finished
 * inside a 300 s budget. "Never finished" is a fact about the probe, not about the watcher, so this asks the question in pieces so
 * each answer is separate evidence:
 *
 *   1. does `fs.watch()` return at all (registration reaches the kernel)?
 *   2. does an event arrive on a write, and with which `(eventType, filename)`?
 *   3. does a program whose only remaining handles are a closed watcher end by itself?
 *
 * Run: `npx vite-node tools/probe-watch.ts`
 */
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const program = `const fs = require("node:fs");

const seen = [];
console.log("start");
const watcher = fs.watch("/src", (eventType, filename) => {
  seen.push([eventType, filename]);
  console.log("event " + JSON.stringify([eventType, filename]));
});
console.log("watching " + typeof watcher.close);

setTimeout(() => {
  console.log("writing");
  fs.writeFileSync("/src/a.txt", "changed\\n");
}, 100);

setTimeout(() => {
  console.log("closing");
  watcher.close();
  console.log("seen " + JSON.stringify(seen));
}, 900);
`;

const files = new MapFiles({
  "package.json": JSON.stringify({ name: "probe-watch", private: true, version: "0.0.0" }, null, 2),
  "watch.js": program,
  "src/a.txt": "original\n",
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, timeoutMs: 20_000 });
const session = container.createSession("probe-watch");

const started = Date.now();
await container.execute(session.id, "node watch.js");
const record = container.processes().at(-1);

console.log(`--- wall clock ${Date.now() - started} ms`);
console.log(`state: ${record?.state}`);
console.log(`--- stdout\n${record?.stdout ?? "(none)"}`);
console.log(`--- stderr\n${record?.stderr ?? "(none)"}`);
console.log(`--- VFS /src/a.txt: ${JSON.stringify(runtime.readFile("/src/a.txt"))}`);
