/**
 * Startup a package needs and its callers never give it.
 *
 * A substituted package often ships a build that expects a bundler or a page to prepare it: `esbuild-wasm` must be handed its `.wasm` bytes
 * through `initialize()` before any API call, and Vite calls `transform()` without ever doing so. This module is that preparation, as data:
 * one row per package, keyed `<package name>:<method>`, so the loader needs no knowledge of any particular package.
 *
 * Deliberately NOT part of the substitution table: that table decides *which bytes* are installed, and this decides *what to do after* those
 * bytes are loaded. Keeping them apart means a package can need startup without being substituted, and a substitution can apply to a package
 * that needs nothing.
 */

/**
 * What a hook may touch. Passed rather than imported so a hook can be exercised against a real VFS in a test without a loader.
 */
export interface InitHookContext {
  /** The package directory, e.g. `/app/node_modules/esbuild`. */
  readonly dir: string;
  /** Present so a hook can read a data file the package ships. */
  readonly readFile: (path: string) => string | Uint8Array;
  /**
   * Writes a file the package produced, creating parents.
   *
   * A hook is allowed to put a package's output on disk because some packages cannot: `esbuild-wasm` runs its compiler over a channel that declares
   * no filesystem, so the tool that expects files refuses to run at all. This is the only way such a package's declared work becomes real files.
   */
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
}

export interface InitHook {
  /** `<packageName>:<method>`, which is exactly what a substitution row records. */
  readonly key: string;
  /** Why the package cannot be used without this, in one sentence. */
  readonly reason: string;
  /**
   * Prepares the module. Returns a replacement for its exports when startup must be awaited before the module is usable, and nothing when the
   * module became usable in place.
   */
  readonly run: (exports: unknown, context: InitHookContext) => unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The hook table. */
export const INIT_HOOKS: readonly InitHook[] = [
  {
    key: "esbuild-wasm:initialize",
    reason:
      "esbuild-wasm runs its Go service on a WebAssembly.Module it must be handed before the first API call, and callers never call initialize()",
    run: (exports, context) => {
      if (!isRecord(exports) || typeof exports.initialize !== "function") {
        throw new Error(`${context.dir} declares the esbuild-wasm init hook but exports no initialize()`);
      }
      const bytes = context.readFile(`${context.dir}/esbuild.wasm`);
      const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      // Copied into an ArrayBuffer-backed view on purpose: WebAssembly.Module refuses a SharedArrayBuffer-backed one, and a VFS read may
      // legitimately hand back either.
      const copy = new Uint8Array(raw.length);
      copy.set(raw);
      const wasm = new WebAssembly.Module(copy);

      // `worker: false` is the in-thread service. The default builds a Worker from a Blob and a blob URL, which this runtime has neither the
      // need nor the shape for: the point of the WASM build here is that the work happens in the same process as the caller.
      const initialize = exports.initialize as (options: Record<string, unknown>) => Promise<void>;
      const ready = initialize.call(exports, { wasmModule: wasm, worker: false });

      // Why a proxy, measured rather than assumed: the module refuses to be used until that promise resolves ("You need to wait for the
      // promise returned from initialize to be resolved before calling this"), and its callers never await it, or even call initialize at
      // all. So every callable export waits for readiness on first call. Without this the module loads, reports itself ready, and fails on
      // the first real call: initialisation ORDER is the whole problem, not initialisation itself.
      /**
       * THE FILESYSTEM ESBUILD THINKS IT DOES NOT HAVE.
       *
       * `esbuild-wasm`'s browser service builds its channel with `hasFS: false` (`lib/browser.js`), and the JS side then (a) throws `The "write"
       * option is unavailable in this environment` for an explicit `write: true` and (b) makes `write` DEFAULT TO FALSE for every build. Native
       * esbuild defaults it to true, so a caller written against Node esbuild believes its files are on disk when they exist only on the returned
       * `outputFiles`.
       *
       * Measured, and it is the reason vite's dev server never produced a dependency: `optimizeDeps` runs `esbuild.context({ outdir })`, esbuild
       * returns `outputFiles` instead of writing them, vite's own commit only renames the temporary cache directory into place, and the browser
       * then asks for `/node_modules/.vite/deps/picocolors.js`, which does not exist. Metadata naming a file that was never written. The dev server
       * answers `504 Outdated Optimize Dep` forever.
       *
       * So the hook restores native esbuild's contract: `write` defaults to true, an `outdir`/`outfile` receives the real bytes, and a context keeps
       * doing it on every rebuild. It can, because a hook holds the runtime's filesystem. `write: false` is left exactly as the caller asked: the
       * fixtures that read `outputFiles` in memory stay a pure in-memory build.
       */
      const writeOutputs = (result: unknown): void => {
        if (!isRecord(result)) return;
        const files = result.outputFiles;
        if (!Array.isArray(files)) return;
        for (const file of files) {
          if (!isRecord(file) || typeof file.path !== "string") continue;
          const contents = file.contents;
          const bytes =
            contents instanceof Uint8Array
              ? contents
              : typeof file.text === "string"
                ? new TextEncoder().encode(file.text)
                : undefined;
          if (bytes !== undefined) context.writeFile(file.path, bytes);
        }
      };

      /** Native esbuild's rule: write unless the caller said otherwise, and only when there is somewhere to write to. */
      const wantsFiles = (options: unknown): options is Record<string, unknown> => {
        if (!isRecord(options) || options.write === false) return false;
        return typeof options.outdir === "string" || typeof options.outfile === "string";
      };

      const buildWithFiles = (build: (...inner: unknown[]) => unknown) => (options: unknown) => {
        if (!wantsFiles(options)) return build(options);
        // `write` is stripped rather than set to false so esbuild reports `outputFiles`, which is where the bytes are in this environment.
        const { write: _write, ...rest } = options;
        return Promise.resolve(build(rest)).then((result: unknown) => {
          writeOutputs(result);
          return result;
        });
      };

      /**
       * A context writes on every rebuild.
       *
       * `rebuild()` takes no options of its own: everything that decides what a rebuild produces (outdir, outfile, splitting) was fixed when the
       * context was created, and esbuild answers a rebuild with `outputFiles` like any other build. So the bytes are taken from each rebuild's
       * result, and the OPTIONS were already cleaned when the context was made.
       */
      const contextWithFiles = (context: unknown): unknown => {
        if (!isRecord(context) || typeof context.rebuild !== "function") return context;
        const rebuild = context.rebuild as (...inner: unknown[]) => unknown;
        return new Proxy(context, {
          get(target, property, receiver) {
            if (property === "rebuild") {
              return (...args: unknown[]) =>
                Promise.resolve(rebuild.apply(target, args)).then((result: unknown) => {
                  writeOutputs(result);
                  return result;
                });
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
      };

      const proxy: unknown = new Proxy(exports, {
        get(target, property, receiver) {
          // `default` answers THIS PROXY, not the raw module object. esbuild's bundle ends with `default: browser_exports`, and an ES module import
          // reads that property, so handing back the unwrapped object would put every wrapped function out of reach: measured, vite's dependency
          // optimizer kept calling the unwrapped `context` and kept writing nothing.
          if (property === "default") return proxy;
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function" || property === "initialize") return value;
          const call = (args: unknown[]): unknown => (value as (...inner: unknown[]) => unknown).apply(target, args);
          // `build` is the whole API for a one-shot caller, and `context` is the whole API for one that rebuilds. Both are wrapped; everything
          // else (transform, formatMessages, version, stop) is passed through untouched, because none of them produces files.
          if (property === "build") {
            const build = buildWithFiles((options: unknown) => call([options]));
            return (...args: unknown[]) => ready.then(() => (args.length === 0 ? call(args) : build(args[0])));
          }
          if (property === "context") {
            return (...args: unknown[]) =>
              ready.then(() => {
                const options = args[0];
                if (!wantsFiles(options)) return Promise.resolve(call(args)).then(contextWithFiles);
                // The decision lives at creation, so `write` is removed HERE: leaving it in makes esbuild refuse before the context exists.
                const { write: _write, ...rest } = options;
                return Promise.resolve(call([rest, ...args.slice(1)])).then(contextWithFiles);
              });
          }
          return (...args: unknown[]) => ready.then(() => call(args));
        },
      });
      return proxy;
    },
  },
];

const BY_KEY = new Map(INIT_HOOKS.map((hook) => [hook.key, hook]));

/** The hook for a package, if it has one. */
export function initHookFor(packageName: string): InitHook | undefined {
  return BY_KEY.get(`${packageName}:initialize`);
}
