/**
 * CommonJS loader over the VFS (ADR-0002 #7: `fs` -> `path` -> `process`).
 *
 * WHY CommonJS first: `require()` is synchronous, and CJS is still the dominant
 * shape of published pure-JS packages. ESM is deliberately not attempted here;
 * pretending to support both at once is how reimplementations lose fidelity.
 *
 * WHY resolution is hand-written rather than delegated to a library: resolution
 * is where "package X breaks on call Y" actually happens (`exports` maps,
 * condition order, directory mains). Owning it means a failure is diagnosable.
 *
 * Known, documented gaps (ADR-0004, D-4): `exports`/`imports` maps, `browser`
 * field substitution, `.node` binaries (would need a per-package WASM build), and
 * dynamic `require(expr)` outside the pre-resolved set are not supported.
 */
import { path as nodePath } from "../shims/path.js";
import { transformEsm } from "./esm.js";
import type { FsShim } from "../shims/fs.js";
import { ProcessRefusal } from "./refusal.js";

/** Thrown for a resolver failure; `code` matches Node so callers can branch. */
export class ModuleNotFoundError extends Error {
  readonly code = "MODULE_NOT_FOUND";

  constructor(specifier: string, fromDir: string) {
    super(`Cannot find module '${specifier}' from '${fromDir}'`);
    // Node reports `Error` with code MODULE_NOT_FOUND, and a program that logs `error.name` or compares it sees that, so the
    // class name is kept for debugging only. The differential caught this: 11 of 14 module cases matched before the fix.
    this.name = "Error";
  }
}

export interface LoaderDeps {
  readonly fs: FsShim;
  /** Builtin module table: name -> the object user code receives. */
  readonly builtins: Readonly<Record<string, unknown>>;
}

export interface ModuleRecord {
  readonly id: string;
  exports: unknown;
  loaded: boolean;
}

const EXTENSIONS: readonly string[] = [".js", ".cjs", ".json"];

const isRelative = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

/**
 * The two things Node removes before compiling a file, and `new Function` would reject.
 *
 * A shebang is not academic: every executable installed from npm begins with `#!`, so a runtime that cannot load one
 * cannot start any tool. A BOM is rarer but equally fatal, and it arrives from files edited on Windows.
 *
 * The shebang line is replaced rather than deleted so line numbers in stack traces still match the file on disk.
 */
function prepareSource(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.startsWith("#!") ? withoutBom.replace(/^#![^\n]*/, "") : withoutBom;
}

/**
 * Does this module declare `name` for itself, lexically?
 *
 * Only lexical declarations collide with a parameter: `var` redeclares one happily (it is the same scope slot), but `const`, `let`
 * and `class` are a SyntaxError when the name is already a parameter. Destructuring counts, because `const { Buffer } = ...` is how
 * a modernised package binds it.
 */
export function declaresOwnBinding(source: string, name: string): boolean {
  // Comments and string literals are removed first, because a mention is not a declaration: `// use const Buffer` in a doc comment
  // would otherwise strip the shim from a module that genuinely needs it. This is a scrubber, not a parser, and it says so: a
  // regex literal containing a quote can confuse the last three rules, and the cost of a false NEGATIVE is bounded (the module keeps
  // the parameter and hits the same SyntaxError it would have hit without any of this).
  const scrubbed = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const direct = new RegExp(`\\b(?:const|let|class)\\s+${name}\\b`);
  const destructured = new RegExp(`\\b(?:const|let)\\s*(?:\\{[^}]*\\b${name}\\b[^}]*\\}|\\[[^\\]]*\\b${name}\\b[^\\]]*\\])`, "s");
  return direct.test(scrubbed) || destructured.test(scrubbed);
}

/** The clock and timer surface a run exposes to user code (ADR-0013 amendment 2). */
export interface RuntimeGlobals {
  readonly Date: unknown;
  readonly performance: unknown;
  readonly setTimeout: (...args: never[]) => unknown;
  readonly setInterval: (...args: never[]) => unknown;
  readonly clearTimeout: (handle: never) => void;
  readonly clearInterval: (handle: never) => void;
  readonly setImmediate: (...args: never[]) => unknown;
}

export interface RuntimeContext {
  readonly process: unknown;
  readonly console: unknown;
  readonly Buffer: unknown;
  readonly globals?: RuntimeGlobals;
}

/**
 * The host's own clock and timers, used when a caller does not supply a scheduler.
 *
 * Defaulting to these keeps every existing caller meaningful rather than making an unscheduled runtime throw, while
 * InProcessRuntime always supplies the virtual clock.
 */
const HOST_GLOBALS: RuntimeGlobals = {
  Date,
  performance: globalThis.performance ?? { now: () => Date.now() },
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
  clearTimeout: (handle: Parameters<typeof clearTimeout>[0]) => clearTimeout(handle),
  clearInterval: (handle: Parameters<typeof clearInterval>[0]) => clearInterval(handle),
  setImmediate: (callback: (...args: never[]) => void, ...args: unknown[]) => setTimeout(callback, 0, ...args),
};

export class CommonJsLoader {
  readonly #deps: LoaderDeps;
  readonly #cache = new Map<string, ModuleRecord>();
  /**
   * The module that `require.main` reports: the entry, in Node's sense.
   *
   * Set by the first module evaluated rather than passed in, because the loader is created before the entry path is known and
   * every `require` made afterwards must see the same object.
   */
  #main: ModuleRecord | null = null;
  /** Directory -> format, because deciding from `type` means reading package.json on every require otherwise. */
  readonly #formats = new Map<string, "esm" | "cjs">();

  constructor(deps: LoaderDeps) {
    this.#deps = deps;
  }

  /**
   * Is this file an ES module?
   *
   * Extension first (`.mjs`/`.cjs` are explicit and override everything), then the nearest package.json `type`, which
   * is Node's rule and the reason `import` statements work in files whose extension is plain `.js`. Walking up stops at
   * the filesystem root so a project without a package.json still resolves to "commonjs" rather than looping.
   */
  #moduleFormat(path: string): "esm" | "cjs" {
    if (path.endsWith(".mjs")) return "esm";
    if (path.endsWith(".cjs")) return "cjs";

    const startDir = nodePath.dirname(path);
    const cached = this.#formats.get(startDir);
    if (cached !== undefined) return cached;

    let format: "esm" | "cjs" = "cjs";
    let dir = startDir;
    for (;;) {
      const manifest = this.#readManifestQuietly(nodePath.join(dir, "package.json"));
      if (manifest !== null) {
        format = manifest["type"] === "module" ? "esm" : "cjs";
        break;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    this.#formats.set(startDir, format);
    return format;
  }

  /** package.json contents, or null when it is absent or unparseable: a missing manifest is not a load failure here. */
  #readManifestQuietly(path: string): Record<string, unknown> | null {
    try {
      const raw = this.#deps.fs.readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Resolve a specifier to an absolute VFS path, or return a builtin name. */
  resolve(specifier: string, fromDir: string): { kind: "builtin"; name: string } | { kind: "file"; path: string } {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (Object.prototype.hasOwnProperty.call(this.#deps.builtins, bare)) {
      return { kind: "builtin", name: bare };
    }

    if (nodePath.isAbsolute(specifier) || isRelative(specifier)) {
      const candidate = nodePath.isAbsolute(specifier) ? nodePath.normalize(specifier) : nodePath.normalize(nodePath.join(fromDir, specifier));
      const found = this.#resolveFileOrDirectory(candidate);
      if (found !== undefined) return { kind: "file", path: found };
      throw new ModuleNotFoundError(specifier, fromDir);
    }

    // Bare specifier: walk up the directory chain looking in node_modules, which
    // is what makes nested dependency trees resolve the way npm laid them out.
    let current = nodePath.normalize(fromDir);
    for (;;) {
      const candidate = nodePath.join(current, "node_modules", specifier);
      const found = this.#resolveFileOrDirectory(candidate);
      if (found !== undefined) return { kind: "file", path: found };
      const parent = nodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    throw new ModuleNotFoundError(specifier, fromDir);
  }

  /**
   * Node's documented order: exact file, then extension guesses, then treat as a
   * directory via package.json `main`, then index files.
   */
  #resolveFileOrDirectory(candidate: string): string | undefined {
    // The exact name and every extension guess are INDEPENDENT probes: their ORDER decides the winner, not whether they can
    // be asked together. Asking in one round trip changes nothing about which file wins and removes up to three wake-ups
    // from the expensive path, because a miss is the common case (a directory, or a specifier that needs an extension).
    const fileCandidates = [candidate, ...EXTENSIONS.map((extension) => candidate + extension)];
    // The manifest probe rides along in the same batch: it is only *used* when the candidate turns out to be a directory, but
    // asking early costs one entry in a message that is already being sent and saves a whole wake-up on the path that needs it.
    const probes = [...fileCandidates, nodePath.join(candidate, "/package.json")];
    const fileStats = this.#deps.fs.statManySync(probes);
    const fileHit = fileStats.slice(0, fileCandidates.length).findIndex((stats) => stats?.isFile() === true);
    if (fileHit !== -1) return fileCandidates[fileHit];

    if (fileStats[0]?.isDirectory() !== true) return undefined;

    const main = this.#readPackageMain(candidate, fileStats[fileCandidates.length]?.isFile() === true);
    if (main !== undefined) {
      const mainPath = main.startsWith("/") ? nodePath.join(candidate, main) : nodePath.join(candidate, main);
      const resolvedMain = this.#resolveFileOrDirectory(mainPath);
      if (resolvedMain !== undefined) return resolvedMain;
    }

    const indexCandidates = EXTENSIONS.map((extension) => nodePath.join(candidate, `/index${extension}`));
    const indexStats = this.#deps.fs.statManySync(indexCandidates);
    const indexHit = indexStats.findIndex((stats) => stats?.isFile() === true);
    return indexHit === -1 ? undefined : indexCandidates[indexHit];
  }

  /**
   * Reads the manifest a batched probe already found. `manifestExists` comes from that probe rather than a fresh stat,
   * because the answer is already in hand and asking twice is the cost this change exists to remove.
   */
  #readPackageMain(directory: string, manifestExists: boolean): string | undefined {
    if (!manifestExists) return undefined;
    const manifestPath = nodePath.join(directory, "/package.json");
    try {
      const raw = this.#deps.fs.readFileSync(manifestPath, "utf8");
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (typeof parsed === "object" && parsed !== null && "main" in parsed) {
        const main = (parsed as { main?: unknown }).main;
        if (typeof main === "string" && main !== "") return main;
      }
    } catch {
      // A malformed package.json is Node's "invalid package config" condition.
      // Surfacing it as a resolution miss keeps the error path simple for now;
      // the fidelity gap is recorded in ADR-0004 rather than swallowed silently.
      return undefined;
    }
    return undefined;
  }

  /** Load a module by absolute path, evaluating it once and caching the record. */
  loadFile(path: string): ModuleRecord {
    const cached = this.#cache.get(path);
    if (cached !== undefined) return cached;

    // Refuse a native addon as a refusal, not as a parse error. Before this, `require("./x.node")` read the binary as
    // JavaScript and failed with "binary is not defined", which reads as a bug in this loader rather than a capability
    // the runtime does not have. The distinction matters to a fixture that is supposed to assert on the refusal.
    if (path.endsWith(".node")) {
      // A typed refusal (ADR-0014) rather than a plain Error: the fixture layer has to distinguish "the runtime declined
      // this on purpose" from "the runtime broke", and it can only do that if the refusal carries its own evidence.
      throw new ProcessRefusal({
        code: "native-addon",
        capability: "native addon",
        message:
          `Cannot load native addon ${path}: native addons are not supported in this runtime. ` +
          "A package that needs one must ship a WASM build or be replaced with a pure-JS alternative.",
        subject: path,
      });
    }

    const record: ModuleRecord = { id: path, exports: {}, loaded: false };
    // Cache BEFORE evaluating so a circular require sees the partial exports Node
    // would give it, instead of recursing forever.
    this.#cache.set(path, record);

    if (path.endsWith(".json")) {
      const raw = this.#deps.fs.readFileSync(path, "utf8");
      record.exports = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      record.loaded = true;
      return record;
    }

    const source = this.#deps.fs.readFileSync(path, "utf8");
    const prepared = prepareSource(typeof source === "string" ? source : source.toString());
    // ES modules are reduced to the same factory shape rather than dispatched differently, so both formats resolve
    // every specifier through this one loader (ADR-0012). The compile step below does not care which it got.
    const code =
      this.#moduleFormat(path) === "esm" ? transformEsm(prepared, { url: `file://${path}` }).code : prepared;
    const moduleDir = nodePath.dirname(path);

    // `new Function`'s parameter list IS the shim surface: user code sees exactly these names as free variables, and nothing else
    // from our scope. The clock and the timers are in it for the same reason `process` is, so a run's setTimeout IS the
    // scheduler's and its Date.now() IS virtual (ADR-0013).
    //
    // One name is omitted per module when that module declares it itself. A parameter is a lexical binding in the body, so
    // express 5's `lib/utils.js`, which opens with `const Buffer = require("node:buffer").Buffer`, cannot coexist with a `Buffer`
    // parameter: it is a SyntaxError before a line of it runs. Node never has this problem because Buffer is a real global there
    // and a module's own declaration simply shadows it. Dropping the parameter for a module that binds the name gives that
    // module exactly Node's behaviour, while every other module keeps the shim.
    const requireFromHere = (specifier: string): unknown => this.require(specifier, moduleDir);
    // `require.main` is the entry module, on every require function, so the common `require.main === module` test works. It is
    // read at call time from the loader rather than captured, because the entry is only known after it has been loaded.
    Object.defineProperty(requireFromHere, "main", {
      get: () => this.#main,
      enumerable: false,
      configurable: false,
    });
    const runtime = this.#runtimeContext;
    const runtimeGlobals = runtime.globals ?? HOST_GLOBALS;
    const bindings: ReadonlyArray<readonly [string, unknown]> = [
      ["exports", record.exports],
      ["require", requireFromHere],
      ["module", record],
      ["__filename", path],
      ["__dirname", moduleDir],
      ["process", runtime.process],
      ["console", runtime.console],
      ["Buffer", runtime.Buffer],
      ["Date", runtimeGlobals.Date],
      ["performance", runtimeGlobals.performance],
      ["setTimeout", runtimeGlobals.setTimeout],
      ["setInterval", runtimeGlobals.setInterval],
      ["clearTimeout", runtimeGlobals.clearTimeout],
      ["clearInterval", runtimeGlobals.clearInterval],
      ["setImmediate", runtimeGlobals.setImmediate],
    ];
    const injected = bindings.filter(([name]) => !declaresOwnBinding(code, name));

    let factory: (...args: unknown[]) => unknown;
    try {
      factory = new Function(...injected.map(([name]) => name), code + "\n//# sourceURL=" + path) as (...args: unknown[]) => unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A SyntaxError while compiling a dependency is unattributable without its path: the bare message says which identifier
      // collided and nothing about whose file it was in.
      throw new SyntaxError(`${path}: ${message}`);
    }

    // The entry module becomes `require.main` the first time anything is evaluated, which is the entry itself.
    if (this.#main === null) this.#main = record;
    factory.call(record.exports, ...injected.map(([, value]) => value));

    record.loaded = true;
    return record;
  }

  /** Runtime-provided globals; set by the Runtime before any load. */
  #runtimeContext: RuntimeContext = { process: undefined, console: undefined, Buffer: undefined, globals: HOST_GLOBALS };

  setRuntimeContext(context: RuntimeContext): void {
    this.#runtimeContext = context;
  }

  /** `require` from a given directory, mirroring Node's signature. */
  require(specifier: string, fromDir: string): unknown {
    const resolution = this.resolve(specifier, fromDir);
    if (resolution.kind === "builtin") return this.#deps.builtins[resolution.name];
    return this.loadFile(resolution.path).exports;
  }

  getCache(): ReadonlyMap<string, ModuleRecord> {
    return this.#cache;
  }
}
