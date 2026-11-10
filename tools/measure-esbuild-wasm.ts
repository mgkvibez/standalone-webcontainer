/**
 * One esbuild transform (or one plugin-driven build, with `--plugin`), through the real installer and the real runtime.
 *
 * This is the measurement the substitution exists to make possible: install `esbuild` (which resolves to `esbuild-wasm` through the table),
 * load it through the browser entry, let the runtime initialise it with its own `.wasm`, and transform one TypeScript snippet. It is a tool
 * rather than a test because it needs the network for 12 MB of bytes; the mechanisms it exercises are pinned hermetically in
 * tests/unit/runtime.package-startup.test.ts and tests/unit/npm.substitutions.test.ts.
 *
 * Prints wall-clock timings and the heap cost, so the number decides whether the bundle is worth caching later.
 */

import { createHttpRegistryClient, installDependencies } from "../src/npm/install.js";
import { InProcessRuntime } from "../src/runtime/in-process.js";
import { FileSystem } from "../src/vfs/index.js";

// `--keepalive` appends a chain of timers, which is the cheapest way to ask whether a missing result is a deadlock or the runtime deciding the
// program is finished while a promise is still pending. The two need different fixes, so the tool measures both rather than guessing.
const KEEPALIVE = process.argv.includes("--keepalive")
  ? "\nfor (let tick = 0; tick < 60; tick += 1) setTimeout(() => {}, tick * 25);\n"
  : "";

const TRANSFORM = `
const esbuild = require("esbuild");
esbuild
  .transform("let x: number = 1;\\nconst f = (a: number): string => \\\`\\\${a}\\\`;", { loader: "ts", target: "es2020" })
  .then(
    (result) => { console.log("CODE:" + result.code); },
    (error) => { console.log("FAILED:" + (error && (error.stack || error.message))); },
  );
` + KEEPALIVE;

/**
 * `--plugin` asks the next question in the agreed sequence: the dependency optimizer passes esbuild plugins, and a plugin is a round trip from
 * the compiler back into JavaScript mid-build. Native esbuild makes that round trip through a service process; the WASM build makes it inside
 * the caller, so it is the first thing that can differ because of the substitution rather than because of the runtime.
 */
const PLUGIN = `
const esbuild = require("esbuild");
esbuild
  .build({
    stdin: {
      contents: 'import value from "virtual:dep";console.log(value);',
      resolveDir: "/app",
      sourcefile: "entry.js",
    },
    bundle: true,
    write: false,
    format: "esm",
    plugins: [
      {
        name: "virtual",
        setup(build) {
          build.onResolve({ filter: /^virtual:dep$/ }, () => ({ path: "virtual:dep", namespace: "virt" }));
          build.onLoad({ filter: /.*/, namespace: "virt" }, () => ({ contents: "export default 'from-plugin'", loader: "js" }));
        },
      },
    ],
  })
  .then(
    (result) => { console.log("PLUGIN:" + result.outputFiles[0].text.trim()); },
    (error) => { console.log("FAILED:" + (error && (error.stack || error.message))); },
  );
` + KEEPALIVE;

const PROGRAM = process.argv.includes("--plugin") ? PLUGIN : TRANSFORM;

const heapMb = (): number => Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
const now = (): number => Number(process.hrtime.bigint() / 1000000n);

async function main(): Promise<void> {
  const vfs = new FileSystem();
  const root = "/app";
  const registry = createHttpRegistryClient();
  const before = heapMb();

  console.log("installing esbuild (substituted) from the real registry...");
  const installStarted = now();
  const report = await installDependencies(
    { dependencies: { esbuild: "^0.21.3" } },
    { registry, vfs, root, includeDev: false },
  );
  const installMs = now() - installStarted;

  const substitution = report.substitutions[0];
  console.log(
    `install: ${report.packages.length} package(s) in ${installMs} ms | ` +
      (substitution === undefined
        ? "NO SUBSTITUTION APPLIED"
        : `${substitution.requested} -> ${substitution.substitute}@${substitution.version} (initHook ${substitution.initHook ?? "none"})`),
  );
  console.log(`heap after install: ${heapMb()} MB (+${Math.round((heapMb() - before) * 10) / 10})`);

  const wasm = vfs.readFileSync("/app/node_modules/esbuild/esbuild.wasm");
  const wasmBytes = typeof wasm === "string" ? wasm.length : wasm.byteLength;
  console.log(`esbuild.wasm in the VFS: ${(wasmBytes / 1024 / 1024).toFixed(1)} MB`);

  vfs.writeFileSync("/app/main.js", PROGRAM);
  const runStarted = now();
  const result = await new InProcessRuntime(vfs).run(`${root}/main.js`, { timeoutMs: 120_000 });
  const runMs = now() - runStarted;

  console.log(`run: ${runMs} ms | exit ${result.exitCode}`);
  if (result.stderr !== "") console.log(`stderr: ${result.stderr.trim()}`);
  console.log(result.stdout.trim());
  console.log(`heap after run: ${heapMb()} MB (+${Math.round((heapMb() - before) * 10) / 10} total)`);

  // Two modes, two expectations, and neither is "some output appeared": the transform must have compiled the type away, and the plugin build must
  // have taken the virtual module through both of its callbacks. Checking for the wrong one made this tool report a success as a failure.
  if (process.argv.includes("--plugin")) {
    const bundled = result.stdout.includes("PLUGIN:") ? (result.stdout.split("PLUGIN:")[1] ?? "").trim() : "";
    if (!bundled.includes("from-plugin") || !bundled.includes("console.log(virtual_dep_default)")) {
      console.error("FAILED: no bundled output from the plugin build");
      process.exitCode = 1;
    }
  } else {
    const code = result.stdout.includes("CODE:") ? (result.stdout.split("CODE:")[1] ?? "").trim() : "";
    if (code === "" || !code.includes("let x = 1")) {
      console.error("FAILED: no transform output");
      process.exitCode = 1;
    }
  }
}

await main();
