import { describe, expect, it } from "vitest";

import { RuntimeSupervisor } from "../../src/browser/runtime-supervisor.js";
import type { RuntimeRunRequest } from "../../src/container/types.js";

const runRequest = (
  projectId: string,
  files: Readonly<Record<string, string>>,
  entry: string,
): RuntimeRunRequest => ({
  projectId,
  files,
  entry,
  argv: ["node", entry],
  cwd: "/",
  env: { PWD: "/" },
  timeoutMs: 1_000,
  onOutput: () => undefined,
});

describe("RuntimeSupervisor", () => {
  it("keeps the project VFS and a listening server alive across commands", async () => {
    const supervisor = new RuntimeSupervisor();
    const files = {
      "/server.js": [
        'const http = require("http");',
        'http.createServer((request, response) => { response.end("served:" + request.url); }).listen(3080);',
        'require("fs").writeFileSync("/generated.txt", "persists");',
      ].join("\n"),
      "/read.js": 'console.log(require("fs").readFileSync("/generated.txt", "utf8"));',
    };

    const started = await supervisor.run(runRequest("project-a", files, "/server.js"));
    expect(started.previewPorts).toEqual([3080]);
    expect(supervisor.processes()).toMatchObject([{ id: 1, entry: "/server.js", state: "running", ports: [3080] }]);

    const response = await supervisor.handleTransport({
      method: "GET",
      url: "/preview/3080/hello?from=port",
      headers: {},
      body: new Uint8Array(),
    });
    expect(response.statusCode).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("served:/hello?from=port");

    const next = await supervisor.run(runRequest("project-a", files, "/read.js"));
    expect(next.stdout).toBe("persists\n");
    expect(next.previewPorts).toEqual([]);
    expect(supervisor.processes()).toMatchObject([
      { id: 1, state: "running", ports: [3080] },
      { id: 2, state: "exited", ports: [] },
    ]);
    expect(supervisor.stopServers(started.previewPorts ?? [])).toEqual([3080]);
    expect(supervisor.processes()[0]).toMatchObject({ id: 1, state: "stopped", ports: [] });
  });

  it("replaces the runtime and its listening ports when the active project changes", async () => {
    const supervisor = new RuntimeSupervisor();
    const first = await supervisor.run(runRequest("project-a", {
      "/server.js": 'require("http").createServer((_request, response) => response.end("first")).listen(3081);',
    }, "/server.js"));
    expect(first.previewPorts).toEqual([3081]);

    await supervisor.run(runRequest("project-b", { "/index.js": 'console.log("second project");' }, "/index.js"));
    expect(supervisor.processes()).toMatchObject([{ id: 2, entry: "/index.js", state: "exited", ports: [] }]);
    const response = await supervisor.handleTransport({
      method: "GET",
      url: "/preview/3081/",
      headers: {},
      body: new Uint8Array(),
    });
    expect(response.statusCode).toBe(404);
    expect(new TextDecoder().decode(response.body)).toContain("No preview server is listening");
  });

  it("returns a service-unavailable response before a project is loaded", async () => {
    const response = await new RuntimeSupervisor().handleTransport({
      method: "GET",
      url: "/preview/3080/",
      headers: {},
      body: new Uint8Array(),
    });
    expect(response.statusCode).toBe(503);
  });
});
