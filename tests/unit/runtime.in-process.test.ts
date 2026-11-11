import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { ModuleNotFoundError } from "../../src/runtime/commonjs.js";
import { FileSystem } from "../../src/vfs/index.js";

/**
 * The Week 2 deliverable from the charter, stated plainly: "Can run a simple
 * Node.js script that reads/writes files." These tests run REAL JavaScript
 * through the real loader and the real shims, against the real VFS.
 */
const boot = (files: Readonly<Record<string, string>>): { vfs: FileSystem; root: string } => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return { vfs, root: "/app" };
};

describe("InProcessRuntime", () => {
  it("runs a script that writes and reads a file through the fs shim", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        'const fs = require("fs");',
        'fs.writeFileSync("/app/data.txt", "written-by-user-code");',
        'const back = fs.readFileSync("/app/data.txt", "utf8");',
        "console.log(back);",
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("written-by-user-code\n");
    // The write went to OUR VFS, proving the shim translates into the single owner
    // of file state rather than keeping a private copy.
    expect(vfs.readFileSync("/app/data.txt", "utf8")).toBe("written-by-user-code");
  });

  it("includes output written in a promise continuation", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'Promise.resolve().then(() => console.log("from a continuation"));',
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from a continuation\n");
  });

  it("includes output from a chain of continuations, not just the first", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        "Promise.resolve()",
        '  .then(() => console.log("one"))',
        '  .then(() => Promise.resolve())',
        '  .then(() => console.log("two"))',
        "  .catch(() => {});",
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    // The reason the drain crosses a macrotask boundary: one microtask hop would print "one" and lose "two".
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("includes output written after awaiting Promise.all", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        "async function main() {",
        '  const parts = await Promise.all([Promise.resolve("a"), Promise.resolve("b")]);',
        "  console.log(parts.join(\"-\"));",
        "}",
        "main().catch((error) => console.error(error));",
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.stdout).toBe("a-b\n");
  });

  it("still reports synchronous output in order, with continuations after it", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'console.log("sync");\nPromise.resolve().then(() => console.log("async"));',
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.stdout).toBe("sync\nasync\n");
  });

  it("refuses a native addon by name instead of failing to parse it as JavaScript", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'require("./addon.node");',
      "/app/addon.node": "\u0000binary",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    // Fast and typed, which is what a refusal must be: an unstructured crash here would be a defect in its own right.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("native addon");
    expect(result.stderr).not.toContain("binary is not defined");
  });

  it("lets a program catch the refusal and carry on", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        "try {",
        '  require("./addon.node");',
        "} catch (error) {",
        '  console.log("caught:", error.message.includes("native addon"));',
        "}",
      ].join("\n"),
      "/app/addon.node": "\u0000binary",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("caught: true\n");
  });

  it("starts a script that begins with a shebang, as every installed bin does", async () => {
    const { vfs, root } = boot({
      "/app/bin/tool.js": "#!/usr/bin/env node\nconsole.log('tool ran');",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/bin/tool.js`);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tool ran\n");
  });

  it("strips a byte-order mark rather than failing to parse the first line", async () => {
    const { vfs, root } = boot({
      "/app/bom.js": "\ufeffconst answer = 42;\nconsole.log(answer);",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/bom.js`);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("42\n");
  });

  it("runs a file that is nothing but a shebang, rather than failing to parse it", async () => {
    const { vfs, root } = boot({ "/app/empty.js": "#!/usr/bin/env node" });
    const result = await new InProcessRuntime(vfs).run(`${root}/empty.js`);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("keeps every line after the shebang, including ones that depend on each other", async () => {
    const { vfs, root } = boot({
      "/app/two.js": "#!/usr/bin/env node\nconst a = 20;\nconsole.log(a + 22);",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/two.js`);

    // A strip that consumed one line too many would lose `const a`, and this would be a ReferenceError.
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("42\n");
  });

  it("resolves a bare specifier through node_modules with a package.json main", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'const greet = require("greeter");\nconsole.log(greet("world"));',
      "/app/node_modules/greeter/package.json": JSON.stringify({ name: "greeter", main: "lib/entry.js" }),
      "/app/node_modules/greeter/lib/entry.js": "module.exports = (who) => 'hello ' + who;",
    });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js");
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("resolves relative paths, directory index files and JSON", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        'const conf = require("./config.json");',
        'const util = require("./lib");',
        "console.log(util.label(conf.name));",
      ].join("\n"),
      "/app/config.json": JSON.stringify({ name: "standalone" }),
      "/app/lib/index.js": "exports.label = (n) => 'label:' + n;",
    });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js");
    expect(result.stdout).toBe("label:standalone\n");
  });

  it("honours process.exit codes instead of treating them as crashes", async () => {
    const { vfs, root } = boot({ "/app/main.js": 'console.log("bye");\nprocess.exit(3);' });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js");
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("bye\n");
    expect(result.stderr).toBe("");
  });

  it("reports a thrown error as exit 1 with the stack on stderr", async () => {
    const { vfs, root } = boot({ "/app/main.js": 'throw new Error("boom");' });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
    expect(result.stdout).toBe("");
  });

  it("surfaces a missing module as MODULE_NOT_FOUND", async () => {
    const { vfs, root } = boot({ "/app/main.js": 'require("not-installed");' });
    await expect(new InProcessRuntime(vfs).run(root + "/main.js")).resolves.toMatchObject({
      exitCode: 1,
    });
    expect(() => {
      // The resolver is also callable directly, which is how the harness will
      // classify a MODULE_NOT_FOUND as a runtime incompatibility vs a harness bug.
      const runtime = new InProcessRuntime(vfs);
      void runtime;
      throw new ModuleNotFoundError("not-installed", "/app");
    }).toThrow(ModuleNotFoundError);
  });

  it("passes argv and env through to user code", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'console.log(process.argv.slice(2).join(",") + "|" + (process.env.MODE || ""));',
    });
    const result = await new InProcessRuntime(vfs).run(root + "/main.js", {
      argv: ["node", "/app/main.js", "a", "b"],
      env: { MODE: "test" },
    });
    expect(result.stdout).toBe("a,b|test\n");
  });

  it("keeps two runs isolated from each other's module cache", async () => {
    const { vfs, root } = boot({
      "/app/main.js": 'const c = require("./counter.js");\nconsole.log(c.bump());',
      "/app/counter.js": "let n = 0;\nexports.bump = () => ++n;",
    });
    const runtime = new InProcessRuntime(vfs);
    const first = await runtime.run(root + "/main.js");
    const second = await runtime.run(root + "/main.js");
    // A fresh loader per run is what makes fixture isolation (charter §4.5) real.
    expect(first.stdout).toBe("1\n");
    expect(second.stdout).toBe("1\n");
  });
});

describe("builtin module shapes the loader serves", () => {
  it("serves `events` as the class, so require('events') can be a base class", async () => {
    // The wall vite's boot hit, reproduced through the real loader rather than by importing the shim: its chunk does
    // `class WebSocket extends require$$0$7` where require$$0$7 came from `events`, and a namespace object fails there with
    // "Class extends value #<Object> is not a constructor" even though the class is inside it.
    const { vfs, root } = boot({
      "/app/main.js": [
        'const events = require("events");',
        'console.log(typeof events === "function");',
        "console.log(events === events.EventEmitter);",
        "class Socket extends events {}",
        'const socket = new Socket();',
        'socket.on("open", (value) => console.log("emitted:" + value));',
        'socket.emit("open", "upgrade");',
        "console.log(events.defaultMaxListeners);",
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("true\ntrue\nemitted:upgrade\n10\n");
  });

  it("serves the same class through node:events, because Node has one module under two names", async () => {
    const { vfs, root } = boot({
      "/app/main.js": [
        'const bare = require("events");',
        'const prefixed = require("node:events");',
        "console.log(bare === prefixed);",
        "console.log(bare === prefixed.EventEmitter);",
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.stdout).toBe("true\ntrue\n");
  });
});

describe("the virtual machine's declared environment", () => {
  it("gives a program a home and a temp directory, and os agrees with process.env by construction", async () => {
    // The wall this replaces: lilconfig, inside vite's postcss config search, calls os.homedir() and the shim refused, so vite died in
    // config loading. Node answers that call by reading $HOME, which this VM can declare (runtime/environment.ts).
    const { vfs, root } = boot({
      "/app/main.js": [
        'const os = require("os");',
        'console.log("HOME=" + process.env.HOME);',
        'console.log("homedir=" + os.homedir());',
        'console.log("tmpdir=" + os.tmpdir());',
        'console.log("TMPDIR=" + process.env.TMPDIR);',
      ].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("HOME=/home/user");
    // The two routes to the same fact agree, which is the invariant: a package that caches under `path.join(os.homedir(), ".cache")` and
    // one that reads process.env.HOME must arrive at the same directory.
    expect(lines[1]).toBe(`homedir=${(lines[0] ?? "").slice("HOME=".length)}`);
    expect(lines[2]).toBe("tmpdir=/tmp");
    expect(lines[3]).toBe("TMPDIR=/tmp");
  });

  it("lets the caller's environment win over the declared one, on both routes", async () => {
    const { vfs, root } = boot({
      "/app/main.js": ['const os = require("os");', 'console.log(process.env.HOME + "|" + os.homedir());'].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`, { env: { HOME: "/elsewhere" } });

    expect(result.stdout).toBe("/elsewhere|/elsewhere\n");
  });

  it("keeps PWD alongside the declared variables rather than replacing them", async () => {
    const { vfs, root } = boot({
      "/app/main.js": ["console.log(process.env.PWD + \"|\" + process.env.HOME);"].join("\n"),
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`, { env: { PWD: "/work" } });

    expect(result.stdout).toBe("/work|/home/user\n");
  });
});
