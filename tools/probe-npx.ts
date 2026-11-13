/**
 * `npx` after implementation: does an INSTALLED binary run through it, and is a fetch-shaped request refused with a reason?
 *
 * Fixtures 12, 14 and 03 all invoke their subject through `npx`, so this is the difference between three verdicts and three refusals.
 */
import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";
import { createHttpRegistryClient } from "../src/npm/install.js";

const files = {
  "package.json": JSON.stringify({ name: "probe-npx", version: "0.0.0", dependencies: { cowsay: "1.6.0" } }),
};
const client = new InProcessClient();
const container = new Container({ runtime: client, files: new MapFiles(files), registry: createHttpRegistryClient() });
const session = container.createSession("probe-npx");
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const take = (): string => {
  const text = session.scrollback.map((line) => line.text).join("").replace(ANSI, "");
  session.scrollback.length = 0;
  return text;
};

await container.execute(session.id, "npm install");
console.log(`INSTALL exit=${container.lastExitCode} :: ${take().slice(-120)}`);
await container.execute(session.id, "npx --no-install cowsay hello");
console.log(`LOCAL exit=${container.lastExitCode} :: ${take().slice(-400)}`);
await container.execute(session.id, "npx --yes shadcn@latest add button");
console.log(`FETCH exit=${container.lastExitCode} :: ${take().slice(-300)}`);
process.exit(0);
