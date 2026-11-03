/**
 * End-to-end: user code in the VFS requires `http`, listens, and a preview request reaches it.
 *
 * This is the first test where nothing is called directly from the test: the script fetches the module
 * through the real loader, the server binds into the runtime's registry, and the request arrives through
 * the gateway the way a service worker would deliver it. If any of those three seams is wrong, this fails.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

const decoder = new TextDecoder();

function boot(files: Readonly<Record<string, string>>): { vfs: FileSystem; root: string } {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return { vfs, root: "/app" };
}

function preview(url: string): { method: string; url: string; headers: Record<string, string>; body: Uint8Array } {
  return { method: "GET", url, headers: {}, body: new Uint8Array() };
}

describe("user code serving a preview", () => {
  it("serves a request through require('http') and the gateway", async () => {
    const { vfs, root } = boot({
      "/app/server.js": [
        'const http = require("http");',
        "const server = http.createServer(function (req, res) {",
        '  res.setHeader("content-type", "text/plain");',
        '  res.end("served:" + req.url);',
        "});",
        'server.listen(3000, function () { console.log("listening"); });',
        'console.log("bound:" + server.address().port);',
      ].join("\n"),
    });

    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run(`${root}/server.js`);

    expect(result.exitCode).toBe(0);
    // address() is readable synchronously after listen(), which is what a script that logs its port needs.
    expect(result.stdout).toContain("bound:3000");
    expect(runtime.ports.has("http", 3000)).toBe(true);

    const response = await runtime.gateway.handle(preview("/preview/3000/hello?x=1"));
    expect(response.statusCode).toBe(200);
    expect(decoder.decode(response.body)).toBe("served:/hello?x=1");
  });

  it("resolves node:http as well as http", async () => {
    const { vfs, root } = boot({
      "/app/server.js": [
        'const http = require("node:http");',
        'const server = http.createServer((_req, res) => res.end("node-prefixed"));',
        "server.listen(3010);",
      ].join("\n"),
    });

    const runtime = new InProcessRuntime(vfs);
    await runtime.run(`${root}/server.js`);
    const response = await runtime.gateway.handle(preview("/preview/3010/"));
    expect(decoder.decode(response.body)).toBe("node-prefixed");
  });

  it("reads a request body written by user code", async () => {
    const { vfs, root } = boot({
      "/app/server.js": [
        'const http = require("http");',
        "http.createServer(function (req, res) {",
        "  let body = '';",
        '  req.setEncoding("utf8");',
        '  req.on("data", (chunk) => { body += chunk; });',
        '  req.on("end", () => res.end("echo:" + body));',
        "}).listen(3020);",
      ].join("\n"),
    });

    const runtime = new InProcessRuntime(vfs);
    await runtime.run(`${root}/server.js`);

    const response = await runtime.gateway.handle({
      method: "POST",
      url: "/preview/3020/submit",
      headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode("payload"),
    });
    expect(decoder.decode(response.body)).toBe("echo:payload");
  });

  it("gives user code an EventEmitter that behaves like Node's", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        'const { EventEmitter } = require("events");',
        "const emitter = new EventEmitter();",
        'emitter.once("tick", (value) => console.log("once:" + value));',
        'emitter.on("tick", (value) => console.log("on:" + value));',
        'emitter.emit("tick", 1);',
        'emitter.emit("tick", 2);',
      ].join("\n"),
    });

    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run(`${root}/main.js`);
    expect(result.exitCode).toBe(0);
    // once fires for the first emit only; on fires for both.
    expect(result.stdout).toBe("once:1\non:1\non:2\n");
  });

  it("keeps two runtimes' ports separate", async () => {
    const script = [
      'const http = require("http");',
      'http.createServer((_req, res) => res.end("other-runtime")).listen(3000);',
    ].join("\n");

    const first = boot({ "/app/server.js": script });
    const second = boot({ "/app/server.js": script });

    const a = new InProcessRuntime(first.vfs);
    const b = new InProcessRuntime(second.vfs);
    await a.run(`${first.root}/server.js`);
    // The same port in a different runtime must not collide, or one embedded app would break another.
    await expect(b.run(`${second.root}/server.js`)).resolves.toMatchObject({ exitCode: 0 });

    expect(decoder.decode((await a.gateway.handle(preview("/preview/3000/"))).body)).toBe("other-runtime");
    expect(decoder.decode((await b.gateway.handle(preview("/preview/3000/"))).body)).toBe("other-runtime");
  });

  it("reports a script that listens twice as an error the script can see", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        'const http = require("http");',
        "http.createServer().listen(3030);",
        "http.createServer().listen(3030);",
      ].join("\n"),
    });

    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run(`${root}/main.js`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("EADDRINUSE");
  });
});
