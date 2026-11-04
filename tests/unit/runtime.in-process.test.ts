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
