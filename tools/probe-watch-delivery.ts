/**
 * Probe: does a *host* write reach a program that is watching, in the lane the fixtures use?
 *
 * `tools/probe-watch.ts` showed that a short program cannot observe an event: its own clock is simulated and the watcher polls real time, so the
 * program's whole life finishes before the first poll. That is a fact about the instrument. This probe keeps the program alive and lets the host
 * make the write, which is exactly the editor's shape:
 *
 *   1. start a program whose only job is to print the events its watcher sees;
 *   2. while it runs, push a file into the runtime the way an editor's save does;
 *   3. read what it printed.
 *
 * Run: `npx vite-node tools/probe-watch-delivery.ts`
 */
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const watcherProgram = `const fs = require("node:fs");
const watcher = fs.watch("/src", (eventType, filename) => {
  console.log("event " + eventType + " " + filename);
  watcher.close();
});
console.log("ready");
`;

const files = new MapFiles({
  "package.json": JSON.stringify({ name: "probe-watch-delivery", private: true, version: "0.0.0" }, null, 2),
  "watch.js": watcherProgram,
  "src/a.txt": "original\n",
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, timeoutMs: 5_000 });
const session = container.createSession("probe-watch-delivery");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const running = container.execute(session.id, "node watch.js");
await sleep(250);

const sync = await container.syncFiles({ "/src/a.txt": "changed\n" });
console.log(`host pushed /src/a.txt: ${JSON.stringify(sync)}`);

const finished = await Promise.race([running.then(() => true), sleep(2_000).then(() => false)]);
const record = container.processes().at(-1);
console.log(`program ${finished ? "ended" : "still running after 2 s"} (state ${record?.state})`);
console.log(`--- stdout\n${record?.stdout ?? "(none)"}`);
console.log(`--- stderr\n${record?.stderr ?? "(none)"}`);
console.log(`--- VFS /src/a.txt now: ${JSON.stringify(runtime.readFile("/src/a.txt"))}`);
process.exit(0);
