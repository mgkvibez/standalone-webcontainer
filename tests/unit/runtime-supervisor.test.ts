/**
 * What the supervisor can tell you about a program after it ran.
 *
 * Two questions are asked here, both of which the fixture harness needs and neither of which the project snapshot can answer:
 * what a program wrote to the VFS, and what a server it started answers over the preview gateway.
 */

import { describe, expect, it } from "vitest";

import { RuntimeSupervisor } from "../../src/browser/runtime-supervisor.js";
import { previewRequestUrl } from "../../src/harness/preview-target.js";

const run = (supervisor: RuntimeSupervisor, files: Record<string, string>, entry: string, timeoutMs = 5_000) =>
  supervisor.run({
    projectId: "test",
    files,
    entry,
    argv: [],
    cwd: "/",
    env: {},
    timeoutMs,
    onOutput: () => undefined,
  });

const until = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("RuntimeSupervisor readback", () => {
  it("reads a file a program wrote, which the project snapshot cannot show", async () => {
    const supervisor = new RuntimeSupervisor();
    const files = {
      "/index.js": `require("fs").writeFileSync("/out.txt", "written by the program");`,
    };
    const result = await run(supervisor, files, "/index.js");

    expect(result.exitCode).toBe(0);
    expect(supervisor.readRuntimeFile("/out.txt")).toBe("written by the program");
    // The seeded file is in the VFS too, so a `file-exists` assertion on a definition's own file reads something real.
    expect(supervisor.readRuntimeFile("/index.js")).toBe(files["/index.js"]);
    // And a file nobody wrote is null rather than an error, which is what an assertion turns into a failure.
    expect(supervisor.readRuntimeFile("/never-written.txt")).toBeNull();
    supervisor.dispose();
  });

  it("returns null once the runtime is disposed, rather than reading a stale project", async () => {
    const supervisor = new RuntimeSupervisor();
    await run(supervisor, { "/index.js": `require("fs").writeFileSync("/out.txt", "x");` }, "/index.js");
    expect(supervisor.readRuntimeFile("/out.txt")).toBe("x");

    supervisor.dispose();
    expect(supervisor.readRuntimeFile("/out.txt")).toBeNull();
  });
});

describe("RuntimeSupervisor preview transport", () => {
  it("reaches a server a program started, on the port it listened on", async () => {
    const supervisor = new RuntimeSupervisor();
    const pending = run(
      supervisor,
      {
        "/server.js": `require("http").createServer((request, response) => { response.end("hello from a program"); }).listen(4321);`,
      },
      "/server.js",
    ).catch(() => undefined);

    await until(() => supervisor.processes().some((process) => process.ports.includes(4321)));
    const response = await supervisor.handleTransport({
      method: "GET",
      url: previewRequestUrl("http://localhost:4321/"),
      headers: { host: "localhost:4321" },
      body: new Uint8Array(0),
    });

    expect(response.statusCode).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("hello from a program");

    supervisor.dispose();
    await pending;
  });

  it("answers 404 for a port no program listened on, instead of pretending to have probed", async () => {
    const supervisor = new RuntimeSupervisor();
    await run(supervisor, { "/index.js": `console.log("no server here");` }, "/index.js");

    const response = await supervisor.handleTransport({
      method: "GET",
      url: previewRequestUrl("http://localhost:5099/"),
      headers: { host: "localhost:5099" },
      body: new Uint8Array(0),
    });

    expect(response.statusCode).toBe(404);
    supervisor.dispose();
  });
});
