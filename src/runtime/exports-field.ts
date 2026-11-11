/**
 * `package.json` "exports": the subpath and condition rules, resolved the way Node resolves them.
 *
 * ADR-0004 D-4 recorded this as a gap on purpose: exports maps are the largest fidelity risk in the resolver, and implementing them from intuition
 * is how a runtime of this kind loses trust. This file exists because a fixture now demands it (`rollup/parseAst`, whose map is
 * `{ types, import: ./dist/es/parseAst.js, require: ./dist/parseAst.js }`) and because the rules below are pinned by tests that compare against
 * real Node rather than against my reading of the documentation.
 *
 * What is implemented, and what is not:
 *  - String, array and condition-object targets. Arrays take the first target that resolves, as Node does.
 *  - Subpath keys `"."`, `"./x"`, and pattern keys with `"*"` (longest matching prefix wins, per Node's PATTERN_KEY_COMPARE).
 *  - The condition sets this runtime can honestly answer: `node`, plus `require` or `import` depending on the edge, then `default`.
 *    `types`, `browser`, `development` and `production` are NOT in the set, so they are skipped rather than guessed.
 *  - `null` targets, which mean "explicitly not exported here".
 *  - NOT implemented: "imports" maps (#-specifiers), `browser` field substitution, and the self-reference rule for a package importing its own
 *    name. Each stays a recorded gap rather than a silent maybe.
 */

/** Which edge is resolving. The conditions differ, so the resolver must be told rather than guess. */
export type ResolutionKind = "require" | "import";

/**
 * The conditions in the order Node consults them for each edge. `types` is deliberately absent: it is a TypeScript-only condition, and a target
 * chosen for types would load a `.d.ts` file as JavaScript.
 */
const CONDITIONS: Readonly<Record<ResolutionKind, readonly string[]>> = {
  require: ["node", "require", "default"],
  import: ["node", "import", "default"],
};

/**
 * Rewrite an error's stack header to Node's `Error [CODE]: message` form.
 *
 * Node prints a coded error that way (`Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './nope' is not defined by "exports" in ...`), and a
 * program that greps its own stderr for the code depends on it. Measured against node v20.20.2, and matched here rather than by rewriting the
 * runtime's global formatter, because that formatter also serves `MODULE_NOT_FOUND`, which Node prints WITHOUT a bracket.
 */
function withCodeHeader<T extends Error>(error: T, code: string): T {
  const stack = error.stack;
  if (stack !== undefined) {
    const rest = stack.slice(stack.indexOf("\n"));
    error.stack = `Error [${code}]: ${error.message}${rest.startsWith("\n") ? rest : ""}`;
  }
  return error;
}

/** Node's `ERR_PACKAGE_PATH_NOT_EXPORTED`: the package exists and its map does not offer this subpath. */
export class PackagePathNotExportedError extends Error {
  readonly code = "ERR_PACKAGE_PATH_NOT_EXPORTED";

  constructor(
    readonly subpath: string,
    readonly manifestPath: string,
  ) {
    // Node's wording, verbatim, because a program that matches on the message (some do) should see the same text.
    super(`Package subpath '${subpath}' is not defined by "exports" in ${manifestPath}`);
    this.name = "Error";
    withCodeHeader(this, this.code);
  }
}

/** Node's `ERR_INVALID_PACKAGE_TARGET`: a target that is neither null nor a "./"-relative path. */
export class InvalidPackageTargetError extends Error {
  readonly code = "ERR_INVALID_PACKAGE_TARGET";

  constructor(subpath: string, target: unknown, manifestPath: string) {
    super(`Invalid "exports" target ${JSON.stringify(target)} defined for '${subpath}' in ${manifestPath}`);
    this.name = "Error";
    withCodeHeader(this, this.code);
  }
}

interface PatternMatch {
  readonly key: string;
  /** What `"*"` stands for: the part of the subpath the key's star matched. */
  readonly star: string | null;
}

/**
 * The best key for a subpath: an exact key if one exists, otherwise the pattern with the longest prefix whose suffix also matches.
 *
 * Node compares candidate patterns by their base length and then by the whole key, and takes the greatest. Only the prefix length can differ between
 * two patterns that both match a given subpath in a way that changes which one is more specific, so that is what decides here, with the full key as
 * the tie-break for determinism.
 */
function matchKey(map: Record<string, unknown>, subpath: string): PatternMatch | null {
  if (Object.prototype.hasOwnProperty.call(map, subpath)) return { key: subpath, star: null };
  let best: { key: string; star: string } | null = null;
  for (const key of Object.keys(map)) {
    const starIndex = key.indexOf("*");
    if (starIndex === -1 || !key.startsWith(".")) continue;
    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const star = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (best === null || key.length > best.key.length || (key.length === best.key.length && key > best.key)) best = { key, star };
  }
  return best === null ? null : { key: best.key, star: best.star };
}

/** Resolve one target (string, array, condition object or null) to a "./"-relative path, or `undefined` for "no match". */
function resolveTarget(target: unknown, star: string | null, conditions: readonly string[], subpath: string, manifestPath: string): string | undefined {
  if (target === null) return undefined;
  if (typeof target === "string") {
    if (!target.startsWith("./")) throw new InvalidPackageTargetError(subpath, target, manifestPath);
    // Every "*" in the target is replaced, which is what makes "./dist/*.js" reachable as well as "./dist/*".
    return star === null ? target : target.split("*").join(star);
  }
  if (Array.isArray(target)) {
    // Node: the first target that resolves wins; an array is a fallback list, not a union.
    for (const entry of target) {
      try {
        const resolved = resolveTarget(entry, star, conditions, subpath, manifestPath);
        if (resolved !== undefined) return resolved;
      } catch {
        // A throwing entry falls through to the next one, as Node's ERR_INVALID_PACKAGE_TARGET handling in an array does.
      }
    }
    return undefined;
  }
  if (typeof target === "object") {
    // Keys are consulted IN THE ORDER THEY APPEAR, which is why this is a for-of over entries rather than a set membership test.
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      if (key !== "default" && !conditions.includes(key)) continue;
      const resolved = resolveTarget(value, star, conditions, subpath, manifestPath);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Resolve `subpath` ("." or "./x") through a package's `exports` field.
 *
 * Returns a "./"-relative path inside the package. Throws the two typed errors Node throws, because a caller that catches them should not have to
 * learn a second vocabulary from this runtime.
 */
export function resolveExports(
  exportsField: unknown,
  subpath: string,
  kind: ResolutionKind,
  manifestPath: string,
): string | undefined {
  const conditions = CONDITIONS[kind];
  // A string or array at the top is shorthand for `{ ".": <it> }`. An object whose keys are all conditions is the same shorthand.
  const map: Record<string, unknown> =
    typeof exportsField === "string" || Array.isArray(exportsField) || exportsField === null
      ? { ".": exportsField }
      : isConditionsObject(exportsField)
        ? { ".": exportsField }
        : (exportsField as Record<string, unknown>);

  const match = matchKey(map, subpath);
  if (match === null) throw new PackagePathNotExportedError(subpath, manifestPath);
  const target = resolveTarget(map[match.key], match.star, conditions, subpath, manifestPath);
  if (target === undefined) throw new PackagePathNotExportedError(subpath, manifestPath);
  return target;
}

/** True when an object's keys are all conditions rather than subpaths, which is Node's sugar for a "." entry. */
function isConditionsObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => !key.startsWith("."));
}
