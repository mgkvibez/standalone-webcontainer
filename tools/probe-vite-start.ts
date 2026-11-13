/** Time a real `vite` dev server's start in the container, with no fixture budget: "slow" and "hung" need telling apart. */
import { readFileSync } from "node:fs";
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

import { loadSnapshotRegistry } from "../src/registry/snapshot.js";
import { join } from "node:path";
const definition = JSON.parse(readFileSync("fixtures/definitions/fixture-13.json", "utf8"));
const root = join(process.cwd(), "fixtures/snapshots/vite");
const registry = loadSnapshotRegistry({ slug: "vite", root, manifestText: readFileSync(join(root, "snapshot.json"), "utf8"), read: (path) => new Uint8Array(readFileSync(path)) });
const client = new InProcessClient();
const container = new Container({ runtime: client, files: new MapFiles(definition.files), registry });
const portEvents: number[][] = [];
client.onPorts?.((_pid, ports) => portEvents.push([...ports]));
const session = container.createSession("probe");
// Vite colours the port inside the URL, so the escapes sit BETWEEN the colon and the digits; matching the raw transcript fails.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const scrollback = (): string => session.scrollback.map((line) => line.text).join("").replace(ANSI, "");
const note = (label: string): void => {
  // The claim is about TIME, so the note prints the URL as soon as the program names it, not a tail of the transcript.
  const url = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(scrollback());
  const ports = container.processes().flatMap((process) => process.previewPorts ?? []);
  console.log(`${label} +${Date.now() - started}ms url=${url?.[0] ?? "none"} containerPorts=[${ports.join(",")}]`);
};
const started = Date.now();
await container.execute(session.id, "npm install");
note("install");
const devStarted = Date.now();
const running = container.execute(session.id, "npm run dev -- --port 3300 --host 127.0.0.1");
// W-28: does the dev-server step SETTLE now, or does it hang until the fixture budget ends it? Raced explicitly so the answer is a line.
void running.then(
  () => {
    const ports = container.processes().flatMap((process) => process.previewPorts ?? []);
    console.log(`SETTLED +${Date.now() - devStarted}ms containerPorts=[${ports.join(",")}] events=${JSON.stringify(portEvents)}`);
  },
  (error: unknown) => console.log(`REJECTED ${String(error)}`),
);
for (let i = 0; i < 8; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  note(`t${i}`);
  if (/http:\/\/127\.0\.0\.1:\d+\//.test(scrollback())) { note("SERVING"); break; }
}
await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 3000))]);
// And the readiness question, answered by a real request rather than by the banner.
try {
  const probe = await client.probe("http://localhost:3300/");
  console.log(`READY +${Date.now() - devStarted}ms status=${probe.status} bytes=${probe.body.length}`);
} catch (error) {
  console.log(`NOT-READY ${error instanceof Error ? error.message : String(error)}`);
}
const closed = client.stopServers();
const after = await client.probe("http://localhost:3300/").then((p) => String(p.status), () => "refused");
console.log(`CLOSED released=[${closed.join(",")}] then=${after}`);
process.exit(0);
