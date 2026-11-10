/**
 * `module`, which exists here for one reason: `createRequire`.
 *
 * Measured against vite's real bytes, the whole surface its graph touches is three members, and the counts are lopsided:
 * `createRequire` twenty-one times, `isBuiltin` ten, `builtinModules` seven. Everything else in Node's `module` (`Module`,
 * `_resolveFilename`, `syncBuiltinESMExports`, `wrap`) is absent.
 *
 * `createRequire` is the load-bearing one. A modern ES module that needs to resolve a path at run time does
 * `const require = createRequire(import.meta.url)`, and vite does exactly that in its bundled chunk before it does anything else.
 * Without this module the chunk cannot even finish evaluating.
 *
 * `builtinModules` and `isBuiltin` answer from the runtime's own builtin table rather than from Node's list. That is the honest
 * answer to "is this a builtin": in THIS runtime `https` is a builtin and `worker_threads` is not, and a package that asks the question
 * is asking about the runtime it is in, not about Node.
 */

/** A `require` bound to one directory, shaped as Node's: callable, with `resolve`, `main` and `cache`. */
export interface RequireFunction {
  (specifier: string): unknown;
  resolve(specifier: string): string;
  readonly main: unknown;
  readonly cache: unknown;
}

export interface ModuleShimOptions {
  /**
   * Bind a require to the directory of a file path or file URL.
   *
   * A URL is accepted because that is what callers actually pass: `createRequire(import.meta.url)` is the idiom, and our
   * `import.meta.url` is a `file://` URL, exactly as in Node.
   */
  readonly createRequire: (from: string) => RequireFunction;
  /** The builtin names this runtime serves, read lazily so the table can be the loader's own. */
  readonly builtinNames: () => readonly string[];
}

export interface ModuleShim {
  createRequire: (from: string | URL) => RequireFunction;
  readonly builtinModules: readonly string[];
  isBuiltin: (specifier: string) => boolean;
}

const toPath = (from: string | URL): string => {
  const text = typeof from === "string" ? from : from.href;
  if (!text.startsWith("file://")) return text;
  // `file:///node_modules/vite/x.js` -> `/node_modules/vite/x.js`. Percent-decoding matters because a project directory may contain
  // a space, and a path with a literal `%20` in it would resolve against the wrong directory.
  try {
    return decodeURIComponent(text.slice("file://".length));
  } catch {
    return text.slice("file://".length);
  }
};

const withoutNodePrefix = (specifier: string): string => specifier.replace(/^node:/, "");

export function createModuleShim(options: ModuleShimOptions): ModuleShim {
  const isBuiltin = (specifier: string): boolean => {
    const bare = withoutNodePrefix(specifier);
    // Sub-paths are builtins only if the exact name is served (`fs/promises` is a key of the table in its own right).
    return options.builtinNames().includes(bare);
  };

  const shim: ModuleShim = {
    createRequire: (from) => options.createRequire(toPath(from)),
    // A getter rather than a copy, because the table is complete only after the loader exists. A snapshot taken at construction
    // time would be empty, and an empty `builtinModules` is worse than none: packages use it to decide whether to require at all.
    get builtinModules() {
      // Bare names, as Node reports them: `'fs'`, not `'node:fs'`. Callers compare these against a specifier they have usually already
      // stripped, and prefixing here would make every comparison false.
      return [...options.builtinNames()];
    },
    isBuiltin,
  };
  return shim;
}
