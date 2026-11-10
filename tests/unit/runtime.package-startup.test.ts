/**
 * Package startup the runtime owes a package its callers never give it.
 *
 * Two mechanisms meet here and both are load-bearing for running esbuild at all: the `browser` entry is the one this runtime should load,
 * and a package that must be initialised with data it ships (a `.wasm` module) is initialised once, by the runtime, the first time its entry
 * file produces exports. The bytes below are a real, empty WebAssembly module, so the assertion is about a genuine `WebAssembly.Module` rather
 * than a stand-in.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

const EMPTY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const run = async (files: Record<string, string | Uint8Array>, entry: string) => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return new InProcessRuntime(vfs).run(`/app/${entry}`);
};

describe("the browser entry", () => {
  it("wins over main, because this runtime is the browser the field describes", async () => {
    const result = await run(
      {
        "/app/node_modules/dual/package.json": JSON.stringify({
          name: "dual",
          version: "1.0.0",
          main: "lib/node.js",
          browser: "lib/browser.js",
        }),
        "/app/node_modules/dual/lib/node.js": 'module.exports = "node build";',
        "/app/node_modules/dual/lib/browser.js": 'module.exports = "browser build";',
        "/app/main.js": 'console.log(require("dual"));',
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("browser build\n");
  });

  it("still uses main when there is no browser field", async () => {
    const result = await run(
      {
        "/app/node_modules/plain/package.json": JSON.stringify({ name: "plain", version: "1.0.0", main: "lib/node.js" }),
        "/app/node_modules/plain/lib/node.js": 'module.exports = "node build";',
        "/app/main.js": 'console.log(require("plain"));',
      },
      "main.js",
    );

    expect(result.stdout).toBe("node build\n");
  });
});

describe("declared startup", () => {
  const packageFiles = (initialise: string): Record<string, string | Uint8Array> => ({
    "/app/node_modules/esbuild/package.json": JSON.stringify({
      name: "esbuild-wasm",
      version: "0.21.5",
      main: "lib/main.js",
      browser: "lib/browser.js",
    }),
    // Present and hostile: if the runtime loads this, the test fails loudly instead of passing for the wrong reason.
    "/app/node_modules/esbuild/lib/main.js": 'module.exports = { entry: "native" }; throw new Error("the native build must never load here");',
    "/app/node_modules/esbuild/lib/browser.js": initialise,
    "/app/node_modules/esbuild/esbuild.wasm": EMPTY_WASM,
  });

  it("runs the hook once, after the entry's exports exist, with the bytes the package ships", async () => {
    const result = await run(
      {
        ...packageFiles(
          [
            "module.exports = {",
            '  entry: "wasm",',
            "  calls: [],",
            "  initialize(options) {",
            "    this.calls.push({ worker: options.worker, isModule: options.wasmModule instanceof WebAssembly.Module });",
            "    return Promise.resolve();",
            "  },",
            "};",
          ].join("\n"),
        ),
        "/app/main.js": 'const e = require("esbuild");\nrequire("esbuild");\nconsole.log(e.entry, JSON.stringify(e.calls));',
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    // The browser entry loaded, and the runtime initialised it exactly once even though it was required twice.
    expect(result.stdout).toBe('wasm [{"worker":false,"isModule":true}]\n');
  });

  it("leaves a package with no declared startup alone", async () => {
    const result = await run(
      {
        "/app/node_modules/solo/package.json": JSON.stringify({ name: "solo", version: "1.0.0", main: "index.js" }),
        "/app/node_modules/solo/index.js": "module.exports = 'untouched';",
        "/app/main.js": 'console.log(require("solo"));',
      },
      "main.js",
    );

    expect(result.stdout).toBe("untouched\n");
  });
});
