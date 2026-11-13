import { describe, expect, it } from "vitest";
import { InProcessClient } from "../../tools/harness/in-process-client.js";
import { Container } from "../../src/container/container.js";
import { MapFiles } from "../../tools/harness/fixture-executor.js";

/**
 * W-28: a dev-server step must SETTLE, and its port must be observable while it still serves.
 *
 * The measured defect: `Container.execute("npm run dev")` never resolved, because this client never reported the port a program bound
 * and never applied the hold-open rule the kernel applies (`ProcessHost.holdOpen`). A fixture then spent its whole run budget and
 * ended as a TIMEOUT while vite was answering requests. This is that path, in the lane the fixtures actually use.
 */

const SERVER = [
  `const http = require("http");`,
  `http.createServer((request, response) => { response.end("ready"); }).listen(3301);`,
  `console.log("listening 3301");`,
].join("\n");

/**
 * A program that binds a port and then keeps scheduling work: still inside the runtime's queue when the body has settled.
 *
 * This one settles with or without the hold-open rule (the scheduler ends the loop at body settle), so it is coverage of the
 * reporting path rather than proof of the fix. The case below it is the one that hangs, and the mutation check lives there.
 */
const BUSY_SERVER = [
  `const http = require("http");`,
  `http.createServer((request, response) => { response.end("ready"); }).listen(3302);`,
  `console.log("listening 3302");`,
  `setInterval(() => {}, 50);`,
].join("\n");

/**
 * The mechanism behind vite's hang: an open stdin keeps the loop alive, so the run waits for work that will never arrive.
 *
 * Vite's CLI resumes stdin when it is not running under CI, and that open handle is a ref'd one under Node's rules: the process stays
 * alive because it is still reading. This runtime counts a live stdin the same way, which is why the body settles and the run does not.
 */
const STDIN_SERVER = [
  `const http = require("http");`,
  `http.createServer((request, response) => { response.end("ready"); }).listen(3303);`,
  `console.log("listening 3303");`,
  `process.stdin.resume();`,
].join("\n");

const files = (): MapFiles =>
  new MapFiles({
    "package.json": `{"name":"hold","version":"1.0.0"}`,
    "server.js": SERVER,
    "busy.js": BUSY_SERVER,
    "stdin.js": STDIN_SERVER,
  });

function wire(): { client: InProcessClient; container: Container; session: string; events: number[][] } {
  const client = new InProcessClient();
  const container = new Container({ runtime: client, files: files() });
  const events: number[][] = [];
  client.onPorts((_pid, ports) => events.push([...ports]));
  return { client, container, session: container.createSession("test").id, events };
}

describe("a step that leaves a server listening", () => {
  it("settles instead of running out its budget, and reports the port it bound", async () => {
    const { container, session } = wire();

    // The point of the whole defect: this promise used to stay pending until the harness timed the step out.
    const settled = await Promise.race([
      container.execute(session, "node server.js").then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);

    expect(settled).toBe("settled");
    const ports = container.processes().flatMap((process) => process.previewPorts ?? []);
    expect(ports).toContain(3301);
    // Still RUNNING, which is the state that lets it be previewed, probed and killed.
    expect(container.processes().some((process) => process.state === "running")).toBe(true);
  });

  it("settles a server that keeps scheduling work after it binds, and reports its port", async () => {
    const { client, container, session, events } = wire();

    const settled = await Promise.race([
      container.execute(session, "node busy.js").then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);

    expect(settled).toBe("settled");
    expect(events.flat()).toContain(3302);
    expect(container.processes().flatMap((process) => process.previewPorts ?? [])).toContain(3302);
    // And it is genuinely serving, not merely reported: the base URL answers through the gateway.
    expect((await client.probe("http://localhost:3302/")).body).toBe("ready");
    client.stopServers();
  });

  it("settles a server whose program is still waiting on its terminal, which is how a dev server stays alive", async () => {
    const { client, container, session, events } = wire();

    const settled = await Promise.race([
      container.execute(session, "node stdin.js").then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);

    expect(settled).toBe("settled");
    expect(events.flat()).toContain(3303);
    expect((await client.probe("http://localhost:3303/")).body).toBe("ready");
    client.stopServers();
  });

  it("reports the port through onPorts, the channel the preview list reads", async () => {
    const { container, session, events } = wire();
    await container.execute(session, "node server.js");

    expect(events.flat()).toContain(3301);
  });

  it("answers a real request while it is held open, and stops answering once the servers are closed", async () => {
    const { client, container, session } = wire();
    await container.execute(session, "node server.js");

    const whileRunning = await client.probe("http://localhost:3301/");
    expect(whileRunning.status).toBe(200);
    expect(whileRunning.body).toBe("ready");

    // Deterministic shutdown, and the release is reported rather than assumed.
    const released = client.stopServers();
    expect(released).toContain(3301);

    const afterClose = await client.probe("http://localhost:3301/");
    expect(afterClose.status).toBe(404);
    expect(client.boundPorts()).not.toContain(3301);
  });

  it("prints what the program printed before it settled", async () => {
    const { container, session } = wire();
    await container.execute(session, "node server.js");

    const process = container.processes()[0];
    expect(process?.stdout ?? "").toContain("listening 3301");
  });
});
