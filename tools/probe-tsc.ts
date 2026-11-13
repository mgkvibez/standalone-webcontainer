/** Why did `npx tsc -p tsconfig.json` exit 1? Prints the compiler's own words, not a verdict about them. */
import { readFileSync } from "node:fs";
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";
import { createHttpRegistryClient } from "../src/npm/install.js";

const definition = JSON.parse(readFileSync("fixtures/definitions/fixture-12.json", "utf8")) as { files: Record<string, string> };
const client = new InProcessClient();
const container = new Container({ runtime: client, files: new MapFiles(definition.files), registry: createHttpRegistryClient() });
const session = container.createSession("probe-tsc");
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const take = (): string => {
  const text = session.scrollback.map((line) => line.text).join("").replace(ANSI, "");
  session.scrollback.length = 0;
  return text;
};

await container.execute(session.id, "npm install");
console.log(`INSTALL exit=${container.lastExitCode} :: ${take().slice(-140)}`);
await container.execute(session.id, "npx tsc -p tsconfig.json");
console.log(`TSC exit=${container.lastExitCode} :: ${take().slice(-1200)}`);
process.exit(0);
