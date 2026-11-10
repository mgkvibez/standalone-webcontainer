/**
 * Native esbuild versus the substituted esbuild-wasm, compared byte for byte.
 *
 * The compatibility claim this exists to make is "identical bytes", not "looks like it works". Both sides run the same jobs at the same version:
 * native esbuild from this repo's own node_modules (a Node process spawning a platform binary), and esbuild-wasm inside the container through the
 * substitution table (WebAssembly, in-thread, no child process). Any difference in the produced code is a failure, and every future esbuild bump is
 * then checked for free.
 *
 * A tool rather than a test for the honest reason: it needs 12 MB of wasm from the registry. The mechanisms it exercises are pinned hermetically in
 * tests/unit/npm.substitutions.test.ts and the init-hook tests.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { createHttpRegistryClient, installDependencies } from "../src/npm/install.js";
import { InProcessRuntime } from "../src/runtime/in-process.js";
import { FileSystem } from "../src/vfs/index.js";

const require = createRequire(import.meta.url);

/** One job, expressed as data so the same list drives both sides instead of two hand-written copies drifting apart. */
interface Job {
  readonly name: string;
  readonly kind: "transform" | "build";
  /** The input: handed to transform(), or written to a real file for build(). */
  readonly source: string;
  readonly options: Record<string, unknown>;
  readonly virtual?: boolean;
  /**
   * A build job hands the entry's SOURCE to the compiler through `onLoad`, the way Vite's dependency optimizer does, and never lets the Go side read
   * the file itself.
   *
   * That is not a shortcut around the host adapter, it is the only reachable route. `esbuild-wasm`'s in-thread service replaces `fs.read` with a
   * stdin-only implementation AFTER the host object is installed, so the Go side can learn a file's metadata and never its bytes. Measured with
   * `npx tsx tools/measure-esbuild-wasm.ts --build`, which reproduces esbuild's own `panic: JavaScript error: Bad read` from
   * `bundler.runOnLoadPlugins -> FSCache.ReadFile -> os.ReadFile -> syscall.Read`.
   */
  readonly pluginEntry: boolean;
  /**
   * A real package the entry imports by bare specifier, which needs `node_modules` present on both sides.
   *
   * This is the shape Vite's dependency optimizer works in, and the one the host adapter cannot serve alone: esbuild's own resolver reads a package's
   * `package.json` BYTES, and bytes cannot cross into the Go side. Measured with `measure-esbuild-wasm.ts --deps`, which panics with
   * `Bad read ... while parsing "app/entry.ts"` for the bare import and builds cleanly for the relative one. So the plugin resolves in JavaScript.
   */
  readonly imports?: string;
}

const JOBS: readonly Job[] = [
  {
    name: "transform: typescript, es2020",
    kind: "transform",
    source: "let x: number = 1;\nconst f = (a: number): string => String(a);\nexport { x, f };",
    options: { loader: "ts", target: "es2020" },
    pluginEntry: false,
  },
  {
    // The shape a real package produced and a synthetic corpus never would: a module declaring its own exports, colliding with the injected
    // CommonJS binding. Parity is the check that the compiler's own output is untouched by anything the loader does.
    name: "transform: module declaring its own exports binding",
    kind: "transform",
    source: 'const exports = [];\nfunction thing() { return exports.length; }\nmodule.exports = { thing };',
    options: { loader: "js", target: "es2020", format: "cjs" },
    pluginEntry: false,
  },
  {
    name: "transform: jsx automatic runtime",
    kind: "transform",
    source: "const Card = (props: { title: string }) => <section>{props.title}</section>;\nexport default Card;",
    options: { loader: "tsx", jsx: "automatic", target: "es2020" },
    pluginEntry: false,
  },
  {
    name: "build: plugin round trip, minified",
    kind: "build",
    source: 'import value from "virtual:dep";\nconst box = <T,>(_unused: T): T => _unused;\nconsole.log(value, box(1));',
    options: { minify: true, format: "esm" },
    virtual: true,
    pluginEntry: true,
  },
  {
    name: "build: define and tree shaking",
    kind: "build",
    source: 'const flag = process.env.PARITY_FLAG;\nexport function pick(): string { if (flag === "on") return "on"; return "off"; }\nconsole.log(pick());',
    options: { define: { "process.env.PARITY_FLAG": '"on"' }, format: "esm", minify: true },
    pluginEntry: true,
  },
  {
    // The optimizer's shape in miniature: a real package from the registry, resolved by our own resolver, prebundled by esbuild-wasm, and compared
    // against what native esbuild produces when IT resolves the same package from the same bytes.
    name: "build: bare specifier through node_modules",
    kind: "build",
    source: 'import isOdd from "is-odd";\nexport const answer: boolean = isOdd(3);',
    options: { format: "esm", minify: true },
    pluginEntry: true,
    imports: "is-odd",
  },
];

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The program the container runs. No backticks and no template substitutions: this string is itself a template literal. */
function program(): string {
  return [
    'const fs = require("fs");',
    'const esbuild = require("esbuild");',
    'const jobs = JSON.parse(fs.readFileSync("/app/jobs.json", "utf8"));',
    "",
    "// The entry point is NOT resolved by a plugin: it is handed to esbuild as an absolute path and resolved by esbuild itself, which in this embedder",
    "// can only happen through the host fs object. Only the CONTENTS arrive by onLoad, because bytes cannot cross into the Go side at all.",
    "function hostFilesPlugin(job) {",
    "  const resolveFrom = job.imports ? require(\"module\").createRequire(job.entry + \".js\").resolve : null;",
    "  return {",
    '    name: "host-files",',
    "    setup(build) {",
    "      if (resolveFrom) {",
    "        // A bare specifier is resolved by the runtime's own resolver, exactly as Vite's dependency plugin resolves with Vite's. esbuild cannot do it",
    "        // here at all: its resolver reads package.json BYTES, and the Go side can never receive a file's bytes.",
    '        build.onResolve({ filter: /^[^./]/ }, (args) => ({ path: resolveFrom(args.path), namespace: "file" }));',
    "      }",
    '      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => ({',
    '        contents: fs.readFileSync(args.path, "utf8"),',
    '        loader: /\\.tsx$/.test(args.path) ? "tsx" : "js",',
    "      }));",
    "      if (!job.virtual) return;",
    '      build.onResolve({ filter: /^virtual:dep$/ }, () => ({ path: "virtual:dep", namespace: "virt" }));',
    '      build.onLoad({ filter: /.*/, namespace: "virt" }, () => ({ contents: "export default 1", loader: "js" }));',
    "    },",
    "  };",
    "}",
    "",
    "function run(job) {",
    '  if (job.kind === "transform") return esbuild.transform(job.source, job.options).then((r) => r.code);',
    "  const options = Object.assign({ entryPoints: [job.entry], write: false, bundle: true }, job.options);",
    "  options.plugins = [hostFilesPlugin(job)];",
    "  return esbuild.build(options).then((r) => r.outputFiles[0].text);",
    "}",
    "",
    "let chain = Promise.resolve();",
    "jobs.forEach((job, index) => {",
    "  chain = chain",
    "    .then(() => run(job))",
    '    .then((out) => { console.log("R" + index + ":" + JSON.stringify(out)); },',
    '          (error) => { console.log("E" + index + ":" + JSON.stringify(String(error && error.message))); });',
    "});",
    'chain.then(() => console.log("DONE"));',
  ].join("\n");
}

/**
 * The same plugin the container runs, expressed once so neither side can drift into a shape the other does not compile.
 *
 * On this side the entry's contents are read from the temp file with Node's own `fs`, which is what the container program does with the runtime's
 * shim: both sides read the real bytes in JavaScript and hand them to the compiler, so the comparison is of the compiler alone. The entry PATH is
 * still resolved by esbuild on both sides, which on the wasm side means the host fs object is what answers.
 */
const hostFilesPlugin = (virtual: boolean) => ({
  name: "host-files",
  setup(build: {
    onResolve: (options: { filter: RegExp }, callback: () => { path: string; namespace: string }) => void;
    onLoad: (options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => { contents: string; loader: string }) => void;
  }) {
    build.onLoad({ filter: /.*/, namespace: "file" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: /\.tsx$/.test(args.path) ? "tsx" : "js",
    }));
    if (!virtual) return;
    build.onResolve({ filter: /^virtual:dep$/ }, () => ({ path: "virtual:dep", namespace: "virt" }));
    build.onLoad({ filter: /.*/, namespace: "virt" }, () => ({ contents: "export default 1", loader: "js" }));
  },
});

/** Copies a VFS subtree to a real directory: the bytes the container resolves are then the bytes the native compiler resolves. */
function mirror(vfs: FileSystem, from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of vfs.readdirSync(from)) {
    const source = `${from}/${name}`;
    const target = `${to}/${name}`;
    if (vfs.statSync(source).kind === "dir") mirror(vfs, source, target);
    else writeFileSync(target, vfs.readFileSync(source) as Uint8Array);
  }
}

async function nativeResults(nativeEsbuild: typeof import("esbuild"), jobs: readonly Job[]): Promise<string[]> {
  const results: string[] = [];
  for (const job of jobs) {
    if (job.kind === "transform") {
      const out = await nativeEsbuild.transform(job.source, job.options as never);
      results.push(out.code);
      continue;
    }
    // A real file on both sides, handed over as contents by the plugin rather than read by the compiler, which is the only shape the wasm side can
    // reach. Writing it first and reading it back keeps the native side honest about where the bytes come from.
    const dir = mkdtempSync(join(tmpdir(), "parity-"));
    const entry = join(dir, "entry.tsx");
    writeFileSync(entry, job.source);
    if (job.imports !== undefined) {
      // Installed by the same installer the container uses, then mirrored, so the comparison is of resolution and compilation and not of two
      // different downloads.
      const scratch = new FileSystem();
      await installDependencies({ dependencies: { [job.imports]: "^3.0.1" } }, { registry: createHttpRegistryClient(), vfs: scratch, root: "/proj" });
      mirror(scratch, "/proj/node_modules", join(dir, "node_modules"));
    }
    const out = await nativeEsbuild.build({
      entryPoints: [entry],
      write: false,
      bundle: true,
      ...(job.options as object),
      plugins: [hostFilesPlugin(job.virtual === true)],
    } as never);
    results.push(out.outputFiles[0]?.text ?? "");
  }
  return results;
}

async function containerResults(version: string, passed: readonly Job[]): Promise<string[]> {
  const vfs = new FileSystem();
  const report = await installDependencies(
    // The bare-specifier job needs a real dependency tree in the VFS, which is what makes it the optimizer's shape rather than a virtual one.
    { dependencies: passed.some((job) => job.imports !== undefined) ? { esbuild: version, "is-odd": "^3.0.1" } : { esbuild: version } },
    { registry: createHttpRegistryClient(), vfs, root: "/app", includeDev: false },
  );
  const applied = report.substitutions[0];
  if (applied === undefined) throw new Error(`esbuild@${version} was installed without a substitution; the table did not apply`);
  if (applied.version !== version) {
    throw new Error(`parity needs one version on both sides: native esbuild is ${version}, ${applied.substitute} resolved ${applied.version}`);
  }
  console.log(`container: ${applied.requested}@${applied.version} served by ${applied.substitute} (rule ${applied.rule})`);

  // One entry file per build job: the jobs run in sequence through one program, so a shared path would hand every job the last job's source and
  // report five identical results as agreement.
  const entryFor = (index: number): string => `/app/entries/job-${index}.tsx`;
  const jobs = passed.map((job, index) => ({
    kind: job.kind,
    source: job.source,
    options: job.options,
    entry: entryFor(index),
    virtual: job.virtual === true,
    imports: job.imports ?? null,
  }));
  vfs.writeFileSync("/app/jobs.json", JSON.stringify(jobs));
  passed.forEach((job, index) => {
    if (job.kind === "build") vfs.writeFileSync(entryFor(index), job.source);
  });
  vfs.writeFileSync("/app/main.js", program());

  const run = await new InProcessRuntime(vfs).run("/app/main.js", { timeoutMs: 120_000 });
  if (run.exitCode !== 0) throw new Error(`container run failed: ${run.stderr.trim().split("\n")[0] ?? ""}`);
  const results: string[] = [];
  for (const line of run.stdout.split("\n")) {
    const match = /^R(\d+):(.*)$/.exec(line);
    if (match !== null) results[Number(match[1])] = JSON.parse(match[2] ?? '""') as string;
    const failure = /^E(\d+):(.*)$/.exec(line);
    if (failure !== null) throw new Error(`job ${failure[1]} failed in the container: ${failure[2] ?? ""}`);
  }
  return results;
}

async function main(): Promise<void> {
  const nativeEsbuild = require("esbuild") as typeof import("esbuild");
  const version = (require("esbuild/package.json") as { version: string }).version;
  console.log(`parity: native esbuild ${version} vs substituted esbuild-wasm ${version}`);

  const passed = JOBS;
  const expected = await nativeResults(nativeEsbuild, passed);
  const actual = await containerResults(version, passed);

  let differences = 0;
  for (const [index, job] of passed.entries()) {
    const left = expected[index] ?? "";
    const right = actual[index] ?? "";
    const same = left === right;
    if (!same) differences += 1;
    console.log(
      `${same ? "same" : "DIFF"}  ${job.name.padEnd(46)} native ${String(left.length).padStart(5)} B ${sha(left)}  wasm ${String(right.length).padStart(5)} B ${sha(right)}`,
    );
    if (!same) {
      const at = [...left].findIndex((char, position) => char !== [...right][position]);
      console.log(`      first difference at character ${at}: native ${JSON.stringify(left.slice(Math.max(0, at - 20), at + 40))}`);
      console.log(`      ${" ".repeat(28)}wasm ${JSON.stringify(right.slice(Math.max(0, at - 20), at + 40))}`);
    }
  }
  console.log(differences === 0 ? "PARITY OK: identical bytes on every job" : `PARITY FAILED: ${differences} of ${passed.length} jobs differ`);
  if (differences !== 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("PARITY ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
