/**
 * What the supervisor can tell you about a program after it ran.
 *
 * Two questions are asked here, both of which the fixture harness needs and neither of which the project snapshot can answer:
 * what a program wrote to the VFS, and what a server it started answers over the preview gateway.
 */

import { describe, expect, it } from "vitest";

import { RuntimeSupervisor } from "../../src/browser/runtime-supervisor.js";
import { previewRequestUrl } from "../../src/harness/preview-target.js";

const run = (supervisor: RuntimeSupervisor, files: Record<string, string | Uint8Array>, entry: string, timeoutMs = 5_000) =>
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
  it("hands a program the exact bytes a snapshot carries", async () => {
    // The other half of the binary path: the container test proves the bytes survive staging, and this proves they survive seeding into the VFS
    // a program actually reads. Both halves are needed, because either decode alone produces the same unloadable module.
    const supervisor = new RuntimeSupervisor();
    const blob = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80]);
    const files = {
      "/blob.wasm": blob,
      "/index.js": `const bytes = require("fs").readFileSync("/blob.wasm");
console.log(Array.from(bytes).join(","));`,
    };

    const result = await run(supervisor, files, "/index.js");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe([...blob].join(","));
  });

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

/**
 * Pushing a save into a runtime that is already running.
 *
 * This is the shape the preview actually needs. A run mirrors the whole project because a run is the authoritative snapshot; an editor's save has
 * no run behind it, so until this channel existed the bytes stayed in the page while a dev server kept serving the old ones. The last test here is
 * the load-bearing one: it fetches from a server that is already listening and expects the new bytes, which is the only version of the question a
 * user would recognise.
 */
describe("RuntimeSupervisor file sync", () => {
  it("says so when no runtime is loaded, instead of pretending a preview was updated", async () => {
    const supervisor = new RuntimeSupervisor();

    expect(await supervisor.syncFiles({ projectId: "test", files: { "/a.txt": "a" } })).toEqual({
      live: false,
      written: [],
      removed: [],
    });
    supervisor.dispose();
  });

  it("refuses to push a different project's files into the loaded runtime", async () => {
    // The runtime holds one project's VFS. Answering `live: true` for another project would write A's file into B's tree.
    const supervisor = new RuntimeSupervisor();
    await run(supervisor, { "/index.js": `console.log("built");` }, "/index.js");

    expect(await supervisor.syncFiles({ projectId: "other", files: { "/a.txt": "a" } })).toEqual({
      live: false,
      written: [],
      removed: [],
    });
    expect(supervisor.readRuntimeFile("/a.txt")).toBeNull();
    supervisor.dispose();
  });

  it("writes what differs, removes only what it was told, and leaves the rest alone", async () => {
    const supervisor = new RuntimeSupervisor();
    await run(
      supervisor,
      {
        "/index.js": `console.log("built");`,
        "/src/kept.js": "kept",
        "/src/changed.js": "before",
        "/src/gone.js": "remove me",
      },
      "/index.js",
    );

    const report = await supervisor.syncFiles({
      projectId: "test",
      files: { "/src/changed.js": "after", "/src/kept.js": "kept", "/src/added.js": "new" },
      removed: ["/src/gone.js"],
    });

    // Three files were named and one of them already matched. Writing it again is not a change, and a report that says otherwise turns every save
    // into three.
    expect(report.live).toBe(true);
    expect(report.written).toEqual(["/src/changed.js", "/src/added.js"]);
    expect(report.removed).toEqual(["/src/gone.js"]);
    // The point of a partial push: silence about a path means nothing. If a save were treated as authoritative, the dev server's own build output
    // and everything under node_modules would be deleted on every keystroke.
    expect(supervisor.readRuntimeFile("/src/kept.js")).toBe("kept");
    expect(supervisor.readRuntimeFile("/src/changed.js")).toBe("after");
    expect(supervisor.readRuntimeFile("/src/added.js")).toBe("new");
    expect(supervisor.readRuntimeFile("/src/gone.js")).toBeNull();
    expect(supervisor.readRuntimeFile("/index.js")).not.toBeNull();
    supervisor.dispose();
  });

  it("reaches a server that is already listening, which is what an edited preview needs", async () => {
    const supervisor = new RuntimeSupervisor();
    const pending = run(
      supervisor,
      {
        "/server.js": `require("http").createServer((request, response) => {
  response.end(require("fs").readFileSync("/src/data.txt", "utf8"));
}).listen(4322);`,
        "/src/data.txt": "before",
      },
      "/server.js",
    ).catch(() => undefined);

    await until(() => supervisor.processes().some((process) => process.ports.includes(4322)));
    const fetchBody = async (): Promise<string> => {
      const response = await supervisor.handleTransport({
        method: "GET",
        url: previewRequestUrl("http://localhost:4322/"),
        headers: { host: "localhost:4322" },
        body: new Uint8Array(0),
      });
      return new TextDecoder().decode(response.body);
    };

    expect(await fetchBody()).toBe("before");

    // The save. No command is started, no run is created: the file changes under a program that is already serving.
    const report = await supervisor.syncFiles({ projectId: "test", files: { "/src/data.txt": "after" } });
    expect(report.written).toEqual(["/src/data.txt"]);

    // The handler reads the file per request, so a stale answer here means the write never reached the VFS the program sees.
    expect(await fetchBody()).toBe("after");

    supervisor.dispose();
    await pending;
  });
});
