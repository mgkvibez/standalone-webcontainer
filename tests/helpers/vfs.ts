/**
 * Small VFS helpers shared by the tests that install.
 *
 * The VFS reports existence by throwing from `statSync` and may return either a string or bytes from
 * `readFileSync`, so every test file would otherwise grow the same two wrappers.
 */

import { FileSystem } from "../../src/vfs/index.js";

const decoder = new TextDecoder();

export function exists(vfs: FileSystem, path: string): boolean {
  try {
    vfs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function text(vfs: FileSystem, path: string): string {
  const contents = vfs.readFileSync(path);
  return typeof contents === "string" ? contents : decoder.decode(contents);
}

/** A VFS with an `/app` project root, which is what every install test works against. */
export function bootVfs(root = "/app"): { vfs: FileSystem; root: string } {
  const vfs = new FileSystem();
  vfs.mkdirSync(root, { recursive: true });
  return { vfs, root };
}
