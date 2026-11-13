/**
 * W-28, measured rather than inferred: the life of a server in the harness lane.
 *
 * The six stages the owner asked for, each printed with the time it took, so a claim about readiness is a number on a line:
 *   1 start      2 the program binds a port      3 the registry records it      4 the harness sees it
 *   5 a real HTTP request is answered            6 shutdown leaves nothing listening
 *
 * No fixture, no budget: this probe is not scored and never touches `.evidence/`. If a stage does not happen, the line says
 * `no` and the probe still exits 0 — the measurement is the output, not the status code.
 */

import { InProcessClient } from "./harness/in-process-client.js";
import { Container } from "../src/container/container.js";
import { MapFiles } from "./harness/fixture-executor.js";

const program = [
  `const http = require("http");`,
  `http.createServer((request, response) => { response.end("ready"); }).listen(3301);`,
  `console.log("listening 3301");`,
].join("\n");

const started = Date.now();
const at = (): string => `+${Date.now() - started}ms`;

const client = new InProcessClient();
const files = new MapFiles({ "package.json": `{"name":"probe","version":"1.0.0"}`, "server.js": program });
const container = new Container({ runtime: client, files });
const session = container.createSession("probe");

const ports: number[][] = [];
client.onPorts?.((_pid, bound) => ports.push([...bound]));

const outcome = await Promise.race([
  container.execute(session.id, "node server.js").then(() => "settled"),
  new Promise<string>((resolve) => setTimeout(() => resolve("still running after 8s"), 8000)),
]);
console.log(`1-2 start/bind   ${at()} execute=${outcome}`);
console.log(`3   registry     ${at()} containerPorts=[${(container.processes()[0]?.previewPorts ?? []).join(",")}] events=${JSON.stringify(ports)}`);

let answered = "no";
try {
  const probe = await client.probe("http://localhost:3301/");
  answered = `${probe.status} body=${JSON.stringify(probe.body)}`;
} catch (error) {
  answered = `probe threw: ${error instanceof Error ? error.message : String(error)}`;
}
console.log(`5   real request ${at()} ${answered}`);

const stopped = container.processes();
// Stop the servers this runtime started, deliberately, before anything else: this is the cleanup a fixture runs after its assertions.
const closed = client.stopServers();
for (const process of stopped) container.terminate(process.pid);
const after = await client.probe("http://localhost:3301/").then(
  (probe) => `${probe.status}`,
  (error) => `refused (${error instanceof Error ? error.message : String(error)})`,
);
console.log(`6   shutdown     ${at()} pids=[${stopped.map((process) => process.pid).join(",")}] closed=[${closed.join(",")}] then=${after}`);
