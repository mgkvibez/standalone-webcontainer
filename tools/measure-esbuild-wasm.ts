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


/**
 * `--syscalls` records what the Go host actually asks of its host object during one real build.
 *
 * The rule this follows: implement the calls observed, not the calls POSIX allows. esbuild's blob builds its global object by defining a live getter
 * for every property of `self`, then guards its own stub block behind `if (!globalThis.fs)`, so supplying `fs` suppresses that whole block. Measured
 * consequence, and the reason this recorder mirrors the stub's shape instead of inventing one: `self.fs = {}` (and any smaller-than-the-stub object)
 * makes the Go runtime panic at `syscall.init`, while the stub's own object boots fine. The object Go receives is a contract, not a bag of names.
 */
/**
 * `--build` runs a real bundle from files on disk and prints what came back.
 *
 * It exists because "the build produced no output" is a result the other modes cannot distinguish from a build that never ran: this mode reports the
 * output file count, the byte length and the full text, or the compiler's own error list.
 */
const BUILD = `
const esbuild = require("esbuild");
esbuild
  .build({ entryPoints: ["/app/entry.ts"], bundle: true, write: false, format: "esm" })
  .then(
    (result) => {
      const files = result.outputFiles || [];
      console.log("BUILD:files=" + files.length + ";bytes=" + files.map((file) => file.text.length).join(","));
      console.log("TEXT:" + JSON.stringify(files.length === 0 ? "" : files[0].text));
    },
    (error) => {
      const errors = error && error.errors ? error.errors.map((item) => item.text) : [String(error)];
      console.log("BUILD_FAILED:" + JSON.stringify(errors));
    },
  );
`;

const SYSCALLS = `
const seen = new Map();
const trace = [];
let traceOn = false;
function note(name, args) {
  const entry = seen.get(name) || { calls: 0, shapes: new Set() };
  entry.calls += 1;
  entry.shapes.add(args.map((arg) => (typeof arg === "number" ? "number" : typeof arg)).join(","));
  seen.set(name, entry);
  if (!traceOn) return -1;
  const shown = args.map((arg) => (typeof arg === "string" ? arg : typeof arg === "number" ? String(arg) : typeof arg));
  trace.push(name + "(" + shown.join(",") + ")");
  return trace.length - 1;
}
function outcome(token, label, error) {
  if (!traceOn || token < 0) return;
  trace[token] = trace[token] + " -> " + (error ? "error " + (error.code || error.message) : label);
}
const enosys = () => {
  const error = new Error("not implemented");
  error.code = "ENOSYS";
  return error;
};
// The same member set esbuild's stub supplies, each one recorded. Behaviour is the stub's: fd 1 and 2 are written through to stdout, everything
// else answers ENOSYS, because this measures the surface rather than pretending to be a filesystem.
let outputBuf = "";
const decoder = new TextDecoder("utf-8");
const fs = {
  constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
  writeSync(fd, buf) {
    note("writeSync", Array.prototype.slice.call(arguments));
    outputBuf += decoder.decode(buf);
    const nl = outputBuf.lastIndexOf("\\n");
    if (nl != -1) {
      console.log(outputBuf.substring(0, nl));
      outputBuf = outputBuf.substring(nl + 1);
    }
    return buf.length;
  },
  write(fd, buf, offset, length, position, callback) {
    const token = note("write", Array.prototype.slice.call(arguments));
    if (offset !== 0 || length !== buf.length || position !== null) {
      callback(enosys());
      return;
    }
    const n = this.writeSync(fd, buf);
    outcome(token, n + " bytes to fd " + fd);
    callback(null, n);
  },
};
// The members a real build needs, implemented just far enough that the build can run to completion: the point is to hear the NEXT requirement from
// the Go host rather than to guess it. Everything else stays ENOSYS, because mirroring the stub's shape is what makes it boot at all.
// (Backticks are banned in this string: it is itself a template literal.)
const shim0 = require("fs");
let traceRequested = false;
try { traceRequested = shim0.existsSync("/app/.trace"); } catch (error) { traceRequested = false; }
traceOn = traceRequested;
const shim = require("fs");
const handles = new Map();
let nextFd = 3;
const toBytes = (value) => (typeof value === "string" ? new TextEncoder().encode(value) : value);
// Node's Stats shape, field for field: Go side setStat reads dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks and the three *Ms values
// with .Int(), so a partial object does not degrade, it panics. mode is the load-bearing one: os.FileInfo.IsDir is mode&S_IFMT == S_IFDIR.
const statsOf = (path) => {
  const stats = shim.statSync(path);
  const directory = stats.isDirectory();
  return {
    dev: 1,
    ino: 1,
    mode: (directory ? 0o040000 : 0o100000) | 0o644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: stats.size,
    blksize: 4096,
    blocks: Math.ceil(stats.size / 512),
    atimeMs: stats.mtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    isDirectory: () => directory,
    isFile: () => !directory,
  };
};
// Go's js Open is not POSIX open: fs_js.go calls open, then fstat(fd), and only asks for readdir when fstat says directory. So a directory must open.
fs.open = function (path, flags, mode, callback) {
  const token = note("open", Array.prototype.slice.call(arguments));
  try {
    const stats = shim.statSync(path);
    const fd = nextFd;
    nextFd += 1;
    handles.set(fd, stats.isDirectory()
      ? { directory: true, path: path, position: 0 }
      : { bytes: toBytes(shim.readFileSync(path)), path: path, position: 0 });
    outcome(token, "fd " + fd + (stats.isDirectory() ? " (directory)" : ""));
    callback(null, fd);
  } catch (error) {
    outcome(token, "", error);
    callback(error);
  }
};
fs.fstat = function (fd, callback) {
  const token = note("fstat", Array.prototype.slice.call(arguments));
  const handle = handles.get(fd);
  if (handle === undefined) { const missing = enosys(); outcome(token, "", missing); callback(missing); return; }
  try {
    const stats = statsOf(handle.path);
    outcome(token, stats.isDirectory() ? "directory" : "file");
    callback(null, stats);
  } catch (error) {
    outcome(token, "", error);
    callback(error);
  }
};
fs.read = function (fd, buffer, offset, length, position, callback) {
  const token = note("read", Array.prototype.slice.call(arguments));
  const handle = handles.get(fd);
  if (handle === undefined || handle.bytes === undefined) { const missing = enosys(); outcome(token, "", missing); callback(missing); return; }
  const from = position === null || position === undefined ? handle.position : position;
  const slice = handle.bytes.subarray(from, Math.min(from + length, handle.bytes.length));
  buffer.set(slice, offset);
  if (position === null || position === undefined) handle.position = from + slice.length;
  outcome(token, slice.length + " bytes");
  callback(null, slice.length, buffer);
};
fs.close = function (fd, callback) {
  const token = note("close", Array.prototype.slice.call(arguments));
  handles.delete(fd);
  outcome(token, "closed");
  callback(null);
};
fs.stat = function (path, callback) {
  const token = note("stat", Array.prototype.slice.call(arguments));
  try {
    const stats = statsOf(path);
    outcome(token, stats.isDirectory() ? "directory" : "file");
    callback(null, stats);
  } catch (error) {
    outcome(token, "", error);
    callback(error);
  }
};
fs.lstat = function (path, callback) {
  const token = note("lstat", Array.prototype.slice.call(arguments));
  try {
    const stats = statsOf(path);
    outcome(token, stats.isDirectory() ? "directory" : "file");
    callback(null, stats);
  } catch (error) {
    outcome(token, "", error);
    callback(error);
  }
};
fs.readdir = function (path, options, callback) {
  const token = note("readdir", Array.prototype.slice.call(arguments));
  const done = typeof options === "function" ? options : callback;
  try {
    const names = shim.readdirSync(path);
    outcome(token, names.length + " entries");
    done(null, names);
  } catch (error) {
    outcome(token, "", error);
    done(error);
  }
};
for (const name of ["chmod", "chown", "fchmod", "fchown", "fsync", "ftruncate", "lchown", "link", "mkdir",
  "readlink", "rename", "rmdir", "symlink", "truncate", "unlink", "utimes"]) {
  fs[name] = function () {
    const args = Array.prototype.slice.call(arguments);
    const token = note(name, args);
    const missing = enosys();
    outcome(token, "", missing);
    args[args.length - 1](missing);
  };
}
self.fs = fs;
const report = () => {
  const rows = Array.from(seen.entries()).sort((a, b) => b[1].calls - a[1].calls);
  console.log("SYSCALLS:" + rows.map(([name, entry]) => name + " x" + entry.calls + " (" + Array.from(entry.shapes).join(" | ") + ")").join("; "));
  if (traceOn) for (const line of trace) console.log("TRACE:" + line);
};

const esbuild = require("esbuild");
esbuild
  .build({ entryPoints: ["/app/entry.ts"], bundle: true, write: false, format: "esm" })
  .then((result) => { console.log("BUNDLE:" + result.outputFiles[0].text.trim()); report(); },
        (error) => { console.log("FAILED:" + JSON.stringify(error && error.message)); report(); });
setTimeout(report, 800);
`;

const PROGRAM = process.argv.includes("--syscalls")
  ? SYSCALLS
  : process.argv.includes("--build")
    ? BUILD
    : process.argv.includes("--plugin")
      ? PLUGIN
      : TRANSFORM;

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
  // The recorder is a program, and a program here is not handed this tool's argv, so the request crosses as a file it can see.
  if (process.argv.includes("--trace")) vfs.writeFileSync("/app/.trace", "");
  // The program under measurement reads a real file through the host object, because a build that never touches the filesystem measures nothing.
  vfs.writeFileSync("/app/entry.ts", 'export const greeting: string = "hi";');
  const runStarted = now();
  const result = await new InProcessRuntime(vfs).run(`${root}/main.js`, { timeoutMs: 120_000 });
  const runMs = now() - runStarted;

  console.log(`run: ${runMs} ms | exit ${result.exitCode}`);
  if (result.stderr !== "") console.log(`stderr: ${result.stderr.trim()}`);
  console.log(result.stdout.trim());
  console.log(`heap after run: ${heapMb()} MB (+${Math.round((heapMb() - before) * 10) / 10} total)`);

  // Two modes, two expectations, and neither is "some output appeared": the transform must have compiled the type away, and the plugin build must
  // have taken the virtual module through both of its callbacks. Checking for the wrong one made this tool report a success as a failure.
  if (process.argv.includes("--build")) {
    const produced = /BUILD:files=(\d+);bytes=([0-9,]+)/.exec(result.stdout);
    if (produced === null || produced[1] === "0") {
      console.error("FAILED: the build produced no output file");
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--syscalls")) {
    if (!result.stdout.includes("SYSCALLS:")) {
      console.error("FAILED: no syscall report");
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--plugin")) {
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
