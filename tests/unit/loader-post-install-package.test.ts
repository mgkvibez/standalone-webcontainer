/**
 * A bare package that no install installed.
 *
 * Measured need (docs/audit/vite-config-bare-import.md): Vite loads `vite.config.js` by bundling it with esbuild and externalizing every bare
 * import, so the config's own `import plugin from "local-plugin"` is resolved by the project's process before any request exists. The plugin
 * package in that measurement was written into the project's `node_modules` AFTER `npm install`, which is the interesting shape: if anything
 * froze the install's file list into the resolver, a package that arrives later would be invisible to it and a config would fail to load for a
 * reason no error message would suggest.
 *
 * The importer is named like the file Vite actually creates beside the config (`vite.config.js.timestamp-<n>-<hash>.mjs`), because a resolver
 * that mishandles the dots, dashes or the double extension in that name would fail only in this path.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

/** The shape Vite leaves behind, dots and all: the entry every case here runs, unless a case names its own. */
const CONFIG_NAME = "vite.config.js.timestamp-1794403207722-450d2c8a5a945.mjs";
const CONFIG = `/app/${CONFIG_NAME}`;

const run = async (files: Record<string, string>, entry = CONFIG_NAME) => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return new InProcessRuntime(vfs).run(`/app/${entry}`);
};

const plugin = (marker: string): Record<string, string> => ({
  "/app/node_modules/local-plugin/package.json": JSON.stringify({ name: "local-plugin", version: "1.0.0", main: "index.js" }),
  "/app/node_modules/local-plugin/index.js": `module.exports = ${JSON.stringify(marker)};`,
});

describe("a package written after install", () => {
  it("resolves and loads from a config-shaped file beside it", async () => {
    const result = await run({
      ...plugin("loaded"),
      [CONFIG]: 'import { createRequire } from "node:module";\nconsole.log(createRequire(import.meta.url)("local-plugin"));\n',
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("loaded");
  });

  it("resolves from an ES module's own import too, not just require", async () => {
    const result = await run({
      ...plugin("esm-loaded"),
      [CONFIG]: 'import plugin from "local-plugin";\nconsole.log(plugin);\n',
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("esm-loaded");
  });

  it("prefers the nearest node_modules, as Node does", async () => {
    // Two copies exist and the subdirectory's wins. A resolver that took the first match it found would pick the root's.
    const result = await run({
      ...plugin("from-root"),
      "/app/sub/node_modules/local-plugin/package.json": JSON.stringify({ name: "local-plugin", version: "2.0.0", main: "index.js" }),
      "/app/sub/node_modules/local-plugin/index.js": 'module.exports = "from-sub";',
      "/app/sub/config.mjs": 'import plugin from "local-plugin";\nconsole.log(plugin);\n',
    }, "sub/config.mjs");

    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("from-sub");
  });

  it("still refuses a name nothing provides, and names the importer", async () => {
    const result = await run({ [CONFIG]: 'import plugin from "absent-plugin";\nconsole.log(plugin);\n' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("absent-plugin");
  });
});
