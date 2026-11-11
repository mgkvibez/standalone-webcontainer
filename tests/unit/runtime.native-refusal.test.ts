/**
 * `NATIVE_PROCESS_EXEC_REFUSED`: the second member of the closed refusal set, and where it fires.
 *
 * This file has now pinned three versions of one boundary, and the third is the one that matches Node. First the loader reported
 * `Cannot find module 'child_process'`, which reads as a defect in this loader. Then it refused at load time with a typed refusal, which was
 * honest about the capability but wrong about the moment: vite's dependency chunk begins `import require$$2$1 from 'child_process'` and stopped
 * there without any code having asked to spawn. Node has the builtin, so importing it is legal and the refusal belongs to the call, where the
 * command is known.
 *
 * Still deliberately NOT wired to fixture-01: a refusal there would book the Vite failure as a legitimate classification, and Vite is the failure
 * worth keeping visible until it boots.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

const run = async (files: Record<string, string>, entry: string) => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return new InProcessRuntime(vfs).run(`/app/${entry}`);
};

describe("native process spawn", () => {
  it("lets a module import child_process, because Node has it", async () => {
    // The exact shape vite's dependency chunk has: an import at module scope. Nothing is spawned by importing, so nothing is refused.
    const result = await run(
      { "/app/main.js": ['const cp = require("child_process");', "console.log(typeof cp.execSync);"].join("\n") },
      "main.js",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("function");
    expect(result.refusal).toBeUndefined();
  });

  it("refuses the spawn by code, naming the command", async () => {
    const result = await run(
      { "/app/main.js": 'require("child_process").execSync("esbuild --version");' },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    // The code lives on the refusal, where a program can branch on it, rather than only inside prose.
    expect(result.refusal?.code).toBe("NATIVE_PROCESS_EXEC_REFUSED");
    // A person reading this needs to know WHAT was refused. "Cannot load child_process" made the reader hunt for the caller.
    expect(result.stderr).toContain('Cannot execSync("esbuild --version")');
    expect(result.stderr).toContain("cannot spawn a native process");
    expect(result.stderr).toContain("WASM build");
    // A missing-module error would be the wrong story, so the message must not read like one.
    expect(result.stderr).not.toContain("Cannot find module 'child_process'");
  });

  it("names the owning package and carries the frame", async () => {
    const result = await run(
      {
        "/app/node_modules/needs-proc/package.json": JSON.stringify({ name: "needs-proc", version: "1.0.0", main: "index.js" }),
        "/app/node_modules/needs-proc/index.js": 'module.exports = require("child_process").spawnSync("esbuild", ["--version"]);',
        "/app/main.js": 'require("needs-proc");',
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    // The owner is what a person needs in order to act: which dependency asked for this. The frame comes from the CALL now, so it names the line
    // that spawned rather than the line that imported.
    expect(result.stderr).toContain("which needs-proc needs");
    expect(result.stderr).toMatch(/index\.js:\d+/);
  });

  it("stays a catchable refusal, so a program may handle it and continue", async () => {
    // This is what a package with a WASM fallback does: try the native path, catch, carry on.
    const result = await run(
      {
        "/app/main.js": [
          'try { require("child_process").spawn("esbuild"); } catch (error) { console.log(error.name + ":" + error.refusal.code); }',
          'console.log("still running");',
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ProcessRefusal:NATIVE_PROCESS_EXEC_REFUSED\nstill running\n");
  });
});
