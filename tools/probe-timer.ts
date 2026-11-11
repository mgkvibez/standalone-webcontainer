import { Container } from "../src/container/container.js";
import { InProcessClient, MapFiles } from "../tools/harness/fixture-executor.js";
import { pendingAsyncWork } from "../src/runtime/async-work.js";

const files = new MapFiles({
  "server.mjs": `import { createServer } from "node:http";

const server = createServer((request, response) => {
  const wait = Number(new URL(request.url, "http://x").searchParams.get("wait") ?? "10");
  setTimeout(() => {
    response.end("timer-ok after " + wait + "ms");
  }, wait);
});
server.listen(3311, "127.0.0.1");
console.log("listening");
`,
});
const runtime = new InProcessClient();
const container = new Container({ runtime, files });
const session = container.createSession("probe");
await container.execute(session.id, "node server.mjs");
const record = container.processes().at(-1);
console.log("process:", record?.state, "ports:", record?.previewPorts?.join(",") ?? "none");
console.log("stdout:", (record?.stdout ?? "").trim(), "| stderr:", (record?.stderr ?? "").trim());

const attempt = async (path: string, ms: number): Promise<string> => {
  const raced = await Promise.race([
    runtime.probe(`http://localhost:3311${path}`).then((r) => `${r.status} ${r.body.slice(0, 80)}`),
    new Promise<string>((resolve) => setTimeout(() => resolve(`<client gave up after ${ms}ms>`), ms)),
  ]);
  return raced;
};
console.log("GET /?wait=10 ->", await attempt("/?wait=10", 6000));
console.log("GET /?wait=0  ->", await attempt("/?wait=0", 6000));
console.log("pendingAsyncWork:", pendingAsyncWork());
