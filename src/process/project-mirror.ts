/**
 * Mirroring the page's project snapshot into a kernel's filesystem.
 *
 * The durable copy of a project is the page's (`projects.ts`, localStorage). The kernel's filesystem is runtime state: it holds what
 * programs wrote, and it must not be rewritten wholesale at every command boundary or a program's own output would vanish the moment the
 * next command started.
 *
 * So this is a diff, and the three rules it encodes are all consequences of that:
 *
 * - **A path the page deleted is removed here too.** Otherwise a file the user removed keeps being imported by a later build, which is
 *   the least debuggable failure in this whole area: the code on disk is not the code in the editor.
 * - **An unchanged text file is skipped.** Rewriting it would touch modification times and defeat a dev server's own caching.
 * - **A byte file is always written.** Comparing it would mean decoding it, and two different byte sequences can decode to the same
 *   replacement characters, so a decode is not an equality test.
 *
 * It deliberately knows nothing about kernels, Workers or the page: it takes a target with three file operations and a snapshot.
 */

import type { ProjectFileContents } from "../container/types.js";

/** The slice of a filesystem this needs. Narrow so a kernel, a VFS, or a test double can all be the target. */
export interface MirrorTarget {
  readFile(path: string): string | null;
  writeFile(path: string, contents: string | Uint8Array): void;
  unlink(path: string): void;
}

export interface ProjectMirror {
  /** Bring the target into line with the snapshot. Idempotent: syncing the same snapshot twice writes nothing the second time. */
  sync(target: MirrorTarget, files: Readonly<Record<string, ProjectFileContents>>): void;
  /** Paths currently believed to be mirrored. */
  paths(): readonly string[];
  /** Forget what was mirrored, which also forgets what to delete on the next sync. Used when the target itself is replaced. */
  reset(): void;
}

export function createProjectMirror(): ProjectMirror {
  let previous = new Set<string>();
  return {
    sync(target, files) {
      const next = new Set(Object.keys(files));
      for (const path of previous) {
        if (next.has(path)) continue;
        target.unlink(path);
      }
      for (const [path, contents] of Object.entries(files)) {
        if (typeof contents === "string" && target.readFile(path) === contents) continue;
        target.writeFile(path, contents);
      }
      previous = next;
    },
    paths() {
      return [...previous];
    },
    reset() {
      previous = new Set();
    },
  };
}
