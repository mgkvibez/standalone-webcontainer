/** Time a real `vite` dev server's start in the container, with no fixture budget: "slow" and "hung" need telling apart. */
import { readFileSync } from "node:fs";
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

import { loadSnapshotRegistry } from "../src/registry/snapshot.js";
import { join } from "node:path";
const definition = JSON.parse(readFileSync("fixtures/definitions/fixture-13.json", "utf8"));
const root = join(process.cwd(), "fixtures/snapshots/vite");
const registry = loadSnapshotRegistry({ slug: "vite", root, manifestText: readFileSync(join(root, "snapshot.json"), "utf8"), read: (path) => new Uint8Array(readFileSync(path)) });
const container = new Container({ runtime: new InProcessClient(), files: new MapFiles(definition.files), registry });
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
const running = container.execute(session.id, "npm run dev -- --port 3300 --host 127.0.0.1");
for (let i = 0; i < 8; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  note(`t${i}`);
  if (/http:\/\/127\.0\.0\.1:\d+\//.test(scrollback())) { note("SERVING"); break; }
}
await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 1000))]);
process.exit(0);
