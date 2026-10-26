import { VFSInvalidPathError } from "./errors.js";

/**
 * Normalize any user-supplied path into the VFS canonical form: an absolute
 * POSIX string starting with `/`, with `.` and `..` resolved, duplicate
 * separators collapsed, and a trailing separator removed (`/` stays `/`).
 *
 * WHY not Node's `path.posix`: the VFS runs inside a browser Web Worker
 * (ADR-0002 #2) where Node built-ins are unavailable, and the normalizer
 * must behave identically regardless of host OS. Windows-style `\`
 * separators are accepted on the way in (editors on Windows hosts produce
 * them) and normalized to strict POSIX internally, because ADR-0002 #1 keys
 * the VFS Map by normalized absolute path.
 */
export function normalizeVfsPath(input: string): string {
  if (input.length === 0) {
    throw new VFSInvalidPathError(input, "path must be a non-empty string");
  }
  let raw = input.replace(/\\/g, "/");
  if (!raw.startsWith("/")) {
    // WHY: the VFS has a single root; a relative path resolves against `/`,
    // matching Node semantics for a process whose cwd is the filesystem root.
    raw = `/${raw}`;
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // `/..` collapses to `/` at the root, matching POSIX.
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
