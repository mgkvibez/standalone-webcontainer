/**
 * `package.json` "exports": the subpath and condition rules, pinned against real Node.
 *
 * Every expectation in this file was measured first. The table below was produced by running the same package through node v20.20.2 with
 * `require()` and `import()`, and the runtime has to answer the same way:
 *
 *   require root      = cjs-root
 *   require ./sub     = cjs-sub
 *   require ./dist/a  = dist-a
 *   require ./blocked THREW ERR_PACKAGE_PATH_NOT_EXPORTED ("Package subpath './blocked' is not defined by "exports" in <path>")
 *   require ./nope    THREW ERR_PACKAGE_PATH_NOT_EXPORTED
 *   require.resolve   = <pkg>/cjs/sub/index.js
 *   import root       = esm-root
 *   import ./sub      = esm-sub
 *   import ./dist/a   = dist-a
 *
 * A related gap, recorded rather than hidden: `import()` inside a CommonJS module is not wired yet (the compiled body runs where Node wants an
 * `importModuleDynamically` callback, and this loader passes none), so it fails with "A dynamic import callback was not specified". ES modules use
 * the transformed async path and work. Nothing in this file depends on the CommonJS form.
 *
 * The reason this matters beyond one package: vite's chunk resolves `rollup/parseAst`, whose map is
 * `{ types, import: "./dist/es/parseAst.js", require: "./dist/parseAst.js" }`, so the map decides WHICH file loads. Guessing wrong loads the
 * CommonJS build into an ESM graph and breaks at a much later, less obvious point.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

const DEMO_MANIFEST = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  exports: {
    ".": { types: "./index.d.ts", import: "./esm/index.mjs", require: "./cjs/index.js" },
    "./sub": { types: "./sub.d.ts", import: "./esm/sub/index.mjs", require: "./cjs/sub/index.js" },
    "./dist/*": "./dist/*.js",
    "./blocked": null,
  },
});

const demoFiles = (): Record<string, string> => ({
  "/app/node_modules/demo/package.json": DEMO_MANIFEST,
  "/app/node_modules/demo/cjs/index.js": 'module.exports = "cjs-root";',
  "/app/node_modules/demo/esm/index.mjs": 'export const marker = "esm-root";',
  "/app/node_modules/demo/cjs/sub/index.js": 'module.exports = "cjs-sub";',
  "/app/node_modules/demo/esm/sub/index.mjs": 'export const marker = "esm-sub";',
  "/app/node_modules/demo/dist/a.js": 'module.exports = "dist-a";',
  // Present on disk and deliberately not in the map: Node makes the map authoritative, so this must stay unreachable.
  "/app/node_modules/demo/private.js": 'module.exports = "private";',
});

const run = async (extra: Record<string, string>, entry = "main.js") => {
  const files = { ...demoFiles(), ...extra };
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return new InProcessRuntime(vfs).run(`/app/${entry}`);
};

describe("package exports", () => {
  it("picks the require condition for require(), and the wildcard target for a deep subpath", async () => {
    const result = await run({
      "/app/main.js": [
        'console.log(require("demo"));',
        'console.log(require("demo/sub"));',
        'console.log(require("demo/dist/a"));',
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["cjs-root", "cjs-sub", "dist-a"]);
  });

  it("picks the import condition for a dynamic import(), which is a different file", async () => {
    // The whole point of the condition set: the same specifier names a different file for each edge, and Node loads the one that matches. The entry
    // is an ES module here because that is where `import()` is transformed into this loader's async path; a CommonJS module's `import()` is a
    // separate capability (see the note below), and testing the condition through it would have measured the wrong thing.
    const result = await run({
      "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
      "/app/main.js": 'const mod = await import("demo/sub");\nconsole.log(mod.marker);',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("esm-sub");
  });

  it("resolves through the map for require.resolve, so the reported path is the one that loads", async () => {
    const result = await run({
      "/app/main.js": 'console.log(require("module").createRequire("/app/main.js").resolve("demo/sub"));',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/app/node_modules/demo/cjs/sub/index.js");
  });

  it("refuses a subpath the map does not list, with Node's code and wording", async () => {
    const result = await run({ "/app/main.js": 'require("demo/nope");' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(result.stderr).toContain(`Package subpath './nope' is not defined by "exports" in /app/node_modules/demo/package.json`);
  });

  it("refuses a file that exists on disk but is not exported", async () => {
    // This is the case that separates an exports implementation from a file probe: private.js is right there and still unreachable.
    const result = await run({ "/app/main.js": 'require("demo/private");' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(result.stdout).not.toContain("private");
  });

  it("honours a null target as explicitly not exported", async () => {
    const result = await run({ "/app/main.js": 'require("demo/blocked");' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("falls back to the ordinary file walk for a package with no exports map", async () => {
    // The legacy path must not be bypassed for the majority of packages, which still have no map at all.
    const result = await run({
      "/app/node_modules/legacy/package.json": JSON.stringify({ name: "legacy", main: "lib/entry.js" }),
      "/app/node_modules/legacy/lib/entry.js": 'module.exports = "legacy";',
      "/app/node_modules/legacy/extra.js": 'module.exports = "legacy-extra";',
      "/app/main.js": ['console.log(require("legacy"));', 'console.log(require("legacy/extra"));'].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["legacy", "legacy-extra"]);
  });
});
