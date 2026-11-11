/**
 * Probe: does a program that keeps running keep its timers?
 *
 * `probe-vite-invalidate` shows a dev server created by a program has a real FSWatcher but never emits `ready` and never sees a change, while the
 * plain watch probe sees an event fine. The difference between those two programs is that the watcher in the plain one was registered by the entry
 * script itself, and chokidar's scan is driven by timers *after* the entry script returns. So the question underneath is not about Vite or chokidar
 * at all: once a program's entry script has finished and the program stays alive on a listening socket, do its timers still run?
 *
 * A dev server is exactly that shape, and so is every watcher, debounce and retry anyone writes.
 *
 * Run: `npx vite-node tools/probe-live-timers.ts`
 */
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const program = `const http = require("node:http");
http.createServer((request, response) => response.end("alive")).listen(4310, "127.0.0.1", () => console.log("listening"));
setTimeout(() => console.log("timeout 100"), 100);
setTimeout(() => console.log("timeout 1000"), 1000);
setImmediate(() => console.log("immediate"));
let ticks = 0;
const interval = setInterval(() => console.log("interval " + (++ticks)), 250);
setTimeout(() => { clearInterval(interval); console.log("interval cleared"); }, 1200);
Promise.resolve().then(() => console.log("microtask"));
`;

const files = new MapFiles({ "package.json": JSON.stringify({ name: "probe-timers", private: true, version: "0.0.0" }, null, 2), "server.js": program });
const runtime = new InProcessClient();
const container = new Container({ runtime, files });
const session = container.createSession("probe-timers");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const running = container.execute(session.id, "node server.js");
await sleep(300);

// The run resolves when the entry script's turn is over, exactly as an ordinary program's does. Everything printed after that point is the only
// evidence that a live program kept scheduling.
console.log(`--- at +300 ms\n${container.processes().at(-1)?.stdout ?? "(none)"}`);
await sleep(2_500);
console.log(`--- at +2800 ms\n${container.processes().at(-1)?.stdout ?? "(none)"}`);
const answer = await runtime.probe("http://localhost:4310/");
console.log(`--- server still answering: ${answer.status} ${answer.body}`);
void running;
process.exit(0);
