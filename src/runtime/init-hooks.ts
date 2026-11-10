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
      return new Proxy(exports, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function" || property === "initialize") return value;
          return (...args: unknown[]) => ready.then(() => (value as (...inner: unknown[]) => unknown).apply(target, args));
        },
      });
    },
  },
];

const BY_KEY = new Map(INIT_HOOKS.map((hook) => [hook.key, hook]));

/** The hook for a package, if it has one. */
export function initHookFor(packageName: string): InitHook | undefined {
  return BY_KEY.get(`${packageName}:initialize`);
}
