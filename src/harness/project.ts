/**
 * A fixture's project: the files a definition ships, and how they reach the runtime's file system.
 *
 * Without this a definition is a list of commands pointing at a project that does not exist: `npm install` has no
 * package.json, `npm run dev` has no sources, and every assertion is unreachable. The step list says what to DO; the
 * files say what to do it TO.
 *
 * Paths are validated rather than trusted. A definition is data, and this data decides where files are written inside
 * the runtime's VFS, so an absolute path or a `..` segment would let a fixture write outside its own project.
 */

import { path } from "../shims/path.js";

/** The write surface a project needs. Structural, so the real VFS and a test double both fit. */
export interface ProjectWriter {
  mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
}

/**
 * `node_modules` is refused on purpose.
 *
 * A fixture that shipped `node_modules` would be asserting against files it wrote itself instead of against what the
 * installer produced, so a broken resolver would still pass. That is the difference between testing the package manager
 * and staging a photograph of it.
 */
const RESERVED_TOP_LEVEL = new Set(["node_modules"]);

export class ProjectPathError extends Error {
  constructor(readonly projectPath: string, reason: string) {
    super(`unsafe fixture file path ${JSON.stringify(projectPath)}: ${reason}`);
    this.name = "ProjectPathError";
  }
}

/** Throws `ProjectPathError` unless the path is a plain relative POSIX path inside the project. */
export function assertSafeProjectPath(projectPath: string): void {
  if (projectPath.length === 0) throw new ProjectPathError(projectPath, "path is empty");
  if (projectPath.includes("\0")) throw new ProjectPathError(projectPath, "path contains a NUL byte");
  if (projectPath.includes("\\")) throw new ProjectPathError(projectPath, "use forward slashes only");
  if (projectPath.startsWith("/")) throw new ProjectPathError(projectPath, "path must be relative to the project root");

  const segments = projectPath.split("/");
  for (const segment of segments) {
    if (segment === "") throw new ProjectPathError(projectPath, "path has an empty segment");
    if (segment === ".") throw new ProjectPathError(projectPath, "path has a redundant '.' segment");
    if (segment === "..") throw new ProjectPathError(projectPath, "path escapes the project root");
  }

  const first = segments[0];
  if (first !== undefined && RESERVED_TOP_LEVEL.has(first)) {
    throw new ProjectPathError(projectPath, "node_modules is produced by the installer, so a fixture must not ship it");
  }
}

/**
 * Write a definition's files into `root`, creating directories as needed.
 *
 * Written in sorted path order so two runs produce identical operations, which keeps failure output comparable.
 * Returns the absolute paths written, for evidence.
 */
export function materializeProject(
  writer: ProjectWriter,
  root: string,
  files: Readonly<Record<string, string>>,
): readonly string[] {
  const base = root.replace(/\/+$/, "");
  const written: string[] = [];

  for (const projectPath of Object.keys(files).sort()) {
    assertSafeProjectPath(projectPath);
    const contents = files[projectPath];
    if (contents === undefined) continue;

    const absolute = path.join(base, projectPath);
    const parent = path.dirname(absolute);
    if (parent !== base) writer.mkdirSync(parent, { recursive: true });
    writer.writeFileSync(absolute, contents);
    written.push(absolute);
  }

  return written;
}
