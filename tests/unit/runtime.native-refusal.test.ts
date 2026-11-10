/**
 * `NATIVE_PROCESS_EXEC_REFUSED`: the second member of the closed refusal set, added as a capability on its own.
 *
 * The distinction this pins is the one the briefing asked for: a package that needs to spawn a binary gets an explained refusal naming
 * the package and the frame, not `Cannot find module 'child_process'`, which reads as a defect in this loader. It is deliberately NOT
 * wired to fixture-01: a refusal there would book the Vite failure as a legitimate classification, and Vite is the failure worth keeping
 * visible until it boots.
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
  it("is refused by code, and the message explains rather than accuses", async () => {
    const result = await run({ "/app/main.js": 'require("child_process");' }, "main.js");

    expect(result.exitCode).toBe(1);
    // The code lives on the refusal, where a program can branch on it, rather than only inside prose.
    expect(result.refusal?.code).toBe("NATIVE_PROCESS_EXEC_REFUSED");
    expect(result.stderr).toContain("cannot spawn a native process");
    expect(result.stderr).toContain("WASM build");
    // A missing-module error would be the wrong story, so the message must not read like one.
    expect(result.stderr).not.toContain("Cannot find module 'child_process'");
  });

  it("names the owning package and carries the frame", async () => {
    const result = await run(
      {
        "/app/node_modules/needs-proc/package.json": JSON.stringify({ name: "needs-proc", version: "1.0.0", main: "index.js" }),
        "/app/node_modules/needs-proc/index.js": 'module.exports = require("child_process");',
        "/app/main.js": 'require("needs-proc");',
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    // The owner is what a person needs in order to act: which dependency asked for this.
    expect(result.stderr).toContain("which needs-proc needs");
    // And the frame, so the report points at a line instead of a package.
    expect(result.stderr).toMatch(/index\.js:\d+/);
  });

  it("stays a catchable refusal, so a program may handle it and continue", async () => {
    const result = await run(
      {
        "/app/main.js": [
          'try { require("child_process"); } catch (error) { console.log(error.name + ":" + error.refusal.code); }',
          'console.log("still running");',
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ProcessRefusal:NATIVE_PROCESS_EXEC_REFUSED\nstill running\n");
  });
});
