/**
 * npm scripts and `node_modules/.bin` resolution, done by reading the project rather than by running a shell.
 *
 * npm does two things here that a fixture command depends on:
 *
 * 1. `npm run <script>` looks the script up in package.json and runs its command string. That string is itself a
 *    command line, so it goes through the same interpreter as a fixture step, which is where shell syntax is refused.
 * 2. A bare command name (`vite`, `next`, `tsc`) is resolved through the `bin` field of every installed package, which
 *    is what `node_modules/.bin` is: a directory of links npm generates so the command name exists on PATH.
 *
 * We have no PATH and no links. Resolution scans the installed tree instead, which is slower and, for a client-side
 * runtime, exactly equivalent for the only thing that matters: the name maps to a file, and that file is run with the
 * arguments the caller passed.
 *
 * Deliberate limits, so they are documented rather than discovered:
 *
 * - Only the project's own `node_modules` is searched, plus scoped packages (`@scope/name`). npm also links bins from
 *   nested `node_modules` into the nearest `.bin`; a fixture that depends on a transitively hoisted bin we did not place
 *   at the top level will not resolve, and reports "command not found" rather than running the wrong file.
 * - The first package whose `bin` field claims a name wins, chosen in sorted order so two runs agree. npm's own answer
 *   in a conflict depends on install order; ours is deterministic and therefore reproducible in a report.
 */

export interface ProjectView {
  readonly readFileText: (path: string) => string | null;
  readonly readDirNames: (path: string) => readonly string[];
}

/** package.json was absent or unusable. Distinguished from "the script does not exist". */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export interface ResolvedBin {
  readonly packageName: string;
  /** Absolute VFS path of the file to execute. */
  readonly entryPath: string;
  /** The name it was found under, which for a package with one bin is its own name. */
  readonly name: string;
}

const PACKAGE_JSON = "package.json";

function joinPath(base: string, child: string): string {
  return base.endsWith("/") ? base + child : `${base}/${child}`;
}

function parseJsonObject(text: string | null, path: string): Record<string, unknown> {
  if (text === null) throw new ProjectError(`${path} is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProjectError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectError(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The `scripts` map of a project, or an empty map when it declares none.
 *
 * A non-string script value is a project error rather than a skip: `"build": 5` means the file is wrong, and silently
 * treating it as "no build script" would turn a broken project into a fixture failure about the runtime.
 */
export function readPackageScripts(view: ProjectView, root: string): Readonly<Record<string, string>> {
  const manifest = parseJsonObject(view.readFileText(joinPath(root, PACKAGE_JSON)), joinPath(root, PACKAGE_JSON));
  const scripts = manifest["scripts"];
  if (scripts === undefined) return {};
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new ProjectError(`${joinPath(root, PACKAGE_JSON)}: scripts must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== "string") {
      throw new ProjectError(`${joinPath(root, PACKAGE_JSON)}: scripts.${name} must be a string`);
    }
    result[name] = command;
  }
  return result;
}

/** Every installed package directory under `node_modules`, scoped ones included. Sorted, so resolution is stable. */
export function listInstalledPackages(view: ProjectView, root: string): readonly string[] {
  const nodeModules = joinPath(root, "node_modules");
  const names: string[] = [];
  for (const entry of view.readDirNames(nodeModules)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const scoped of view.readDirNames(joinPath(nodeModules, entry))) {
        if (!scoped.startsWith(".")) names.push(`${entry}/${scoped}`);
      }
      continue;
    }
    names.push(entry);
  }
  return names.sort();
}

/**
 * The bins a package declares, as name to entry file. npm allows `bin` to be a string, in which case the bin is named
 * after the package (unscoped), or an object of arbitrary names.
 */
function binsOf(view: ProjectView, packageDir: string, packageName: string): Readonly<Record<string, string>> {
  const manifest = view.readFileText(joinPath(packageDir, PACKAGE_JSON));
  if (manifest === null) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(manifest, joinPath(packageDir, PACKAGE_JSON));
  } catch {
    // A package installed with an unreadable manifest cannot contribute a bin; failing the whole resolution for it
    // would make one broken transitive dependency hide every working command in the project.
    return {};
  }

  const bin = parsed["bin"];
  if (typeof bin === "string") {
    const unscoped = packageName.includes("/") ? (packageName.split("/")[1] ?? packageName) : packageName;
    return { [unscoped]: bin };
  }
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) return {};

  const result: Record<string, string> = {};
  for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
    if (typeof target === "string") result[name] = target;
  }
  return result;
}

/**
 * Find the package that provides `command`, or null.
 *
 * Returns null rather than throwing for "no such command": a missing tool and a broken project are different failures,
 * and the caller reports them differently (exit 1 with npm's message, versus a harness fault).
 */
export function resolveBin(view: ProjectView, root: string, command: string): ResolvedBin | null {
  const nodeModules = joinPath(root, "node_modules");
  for (const packageName of listInstalledPackages(view, root)) {
    const packageDir = joinPath(nodeModules, packageName);
    const entry = binsOf(view, packageDir, packageName)[command];
    if (entry === undefined) continue;
    const cleaned = entry.startsWith("./") ? entry.slice(2) : entry;
    return { packageName, entryPath: joinPath(packageDir, cleaned), name: command };
  }
  return null;
}
