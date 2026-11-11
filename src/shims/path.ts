/**
 * `path` shim, POSIX semantics (ADR-0002 #7: `fs` -> `path` -> `process` -> ...,
 * target Node 20 LTS).
 *
 * Substrate: `pathe` (MIT, zero dependencies), which is the library ADR-0003's
 * chosen `unenv` path preset wraps. Realizing the preset through its underlying
 * library keeps the dependency count auditable while the expert is unavailable;
 * swapping in `unenv` later changes this file only (see ADR-0004, D-1).
 *
 * WHY the explicit surface rather than `export * from "pathe"`: Node's `path`
 * module has a fixed, documented shape, and a shim that silently grows whatever
 * the substrate exports is not a faithful `path`. Every member here is one Node
 * documents; anything Node has that is missing is a known gap, not an accident.
 * Fidelity is proved differentially in `tests/unit/shims.path.test.ts`.
 */
import * as pathe from "pathe";

/**
 * What `path.posix` and `path.win32` expose.
 *
 * A named type because Node's two namespaces are the same function set over a different separator convention, so the type is what makes it
 * checkable that `posix` really is complete rather than "whatever we happened to remember".
 */
export interface PathNamespace {
  readonly sep: string;
  readonly delimiter: string;
  normalize(p: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  relative(from: string, to: string): string;
  parse(p: string): ReturnType<typeof pathe.parse>;
  format(pathObject: Parameters<typeof pathe.format>[0]): string;
  toNamespacedPath(p: string): string;
}

export interface PathShim extends PathNamespace {
  readonly sep: "/";
  readonly delimiter: ":";
  /** Node's POSIX view. Complete here, because POSIX is what this runtime implements. */
  readonly posix: PathNamespace;
  /** Node's Windows view. Present and REFUSING, because answering POSIX rules under this name would compute wrong paths. */
  readonly win32: PathNamespace;
  normalize(p: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  relative(from: string, to: string): string;
  parse(p: string): ReturnType<typeof pathe.parse>;
  format(pathObject: Parameters<typeof pathe.format>[0]): string;
  toNamespacedPath(p: string): string;
}

/**
 * Two documented deviations found by the differential test, corrected here so
 * callers get Node behaviour rather than substrate behaviour:
 *
 * 1. `pathe` preserves a leading `//` (POSIX allows it), Node's posix collapses
 *    it. Node is the contract, so it is collapsed.
 * 2. `pathe.extname("/dir/.hidden")` returns ".hidden"; Node returns "" because a
 *    dotfile's dot is not an extension separator. Implemented directly.
 */
/**
 * Node's POSIX normalize, implemented rather than delegated: `pathe` leaves
 * "/./../y" unclamped where Node returns "/y", and normalization underpins join
 * and module resolution, so this is the one function worth owning outright.
 *
 * Rules (Node posix): empty -> ".", collapse repeated separators, drop "." 
 * segments, resolve ".." against the previous segment, clamp ".." at the root
 * for absolute paths, and preserve a trailing slash (but never make "/" into
 * "//").
 */
const normalizeNodeWidth = (input: string): string => {
  if (input === "") return ".";
  const isAbsolute = input.startsWith("/");
  const trailingSlash = input.length > 1 && input.endsWith("/");
  const segments = input.split("/").filter((s) => s !== "" && s !== ".");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      const previous = out[out.length - 1];
      if (previous !== undefined && previous !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      // Absolute path at root: ".." is clamped, as POSIX requires.
    } else {
      out.push(segment);
    }
  }
  const body = out.join("/");
  let result = isAbsolute ? `/${body}` : body;
  if (result === "") result = isAbsolute ? "/" : ".";
  if (trailingSlash && !result.endsWith("/")) result = `${result}/`;
  return result;
};

const extname = (p: string): string => {
  const base = pathe.basename(p);
  // Node returns "" for "." and ".." and for a leading-dot-only name.
  if (base === "." || base === "..") return "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
};

const join = (...parts: string[]): string => {
  const joined = parts.filter((part) => part !== "").join("/");
  return joined === "" ? "." : normalizeNodeWidth(joined);
};

/**
 * `path.win32`, refused by name.
 *
 * Every member throws `ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME` and says which one and why, so a caller that probes `path.win32.join` finds a
 * function (Node has one) and a caller that CALLS it learns the truth immediately, rather than receiving a POSIX answer under a Windows name.
 */
function win32Namespace(): PathNamespace {
  const refuse = (member: string) => (): never => {
    throw Object.assign(
      new Error(`path.win32.${member} is not implemented: this runtime resolves POSIX paths only, and answering with POSIX rules would compute the wrong path`),
      { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
    );
  };
  const names = [
    "normalize", "join", "resolve", "isAbsolute", "dirname", "basename", "extname", "relative", "parse", "format", "toNamespacedPath",
  ] as const;
  const namespace = { sep: "\\", delimiter: ";" } as PathNamespace;
  for (const name of names) {
    Object.defineProperty(namespace, name, { value: refuse(name), enumerable: true });
  }
  return namespace;
}

/**
 * The POSIX implementation, built once.
 *
 * `path` spreads this and `path.posix` IS this, which is Node's own arrangement: `path.posix.normalize === path.normalize`. Building it as a
 * value before `path` exists is also what keeps `path.posix` from being a use-before-definition.
 */
const posixNamespace: PathNamespace = {
  sep: "/",
  delimiter: ":",
  normalize: normalizeNodeWidth,
  join,
  resolve: (...parts) => pathe.resolve(...parts),
  isAbsolute: (p) => pathe.isAbsolute(p),
  dirname: (p) => pathe.dirname(p),
  basename: (p, ext) => (ext === undefined ? pathe.basename(p) : pathe.basename(p, ext)),
  extname,
  relative: (from, to) => pathe.relative(from, to),
  parse: (p) => pathe.parse(p),
  format: (pathObject) => pathe.format(pathObject),
  // Browser-side there are no Windows device paths, so this is the POSIX
  // identity. Node documents `path.posix.toNamespacedPath` as a no-op too.
  toNamespacedPath: (p) => p,
  // Node's `path.posix` is the POSIX view, which is the only view this runtime implements: the same functions, available under the name a
  // program reaches for when it wants to be explicit about separator convention. rollup does exactly that (`path.posix.sep`), and the property
  // being undefined is a crash rather than a fallback.
};

/**
 * `path` itself: the POSIX functions, plus the two namespaces Node hangs off them.
 *
 * `win32` is a NAMED refusal rather than a silent POSIX answer: a program that asks for Windows path semantics and gets POSIX ones back would
 * compute wrong paths quietly, which is worse than a throw it can see and catch.
 */
export const path: PathShim = {
  ...posixNamespace,
  sep: "/",
  delimiter: ":",
  posix: posixNamespace,
  win32: win32Namespace(),
};

export const pathShim = path;
