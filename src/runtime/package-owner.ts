/**
 * Which package a directory belongs to, for a diagnostic that names an owner rather than a directory.
 *
 * Shared by the loader (a missing native addon, an async module) and the `child_process` shim (a spawn attempt), because both answer the same
 * question and a second copy of this regex is exactly the kind of thing that drifts: the LAST match is what makes nested trees read correctly, and
 * a copy that forgot that would name the outer package.
 */
export function packageOwnerOf(dir: string): string | null {
  // The LAST match, because a nested conflict puts one package inside another's node_modules and the innermost one is the owner.
  const matches = [...dir.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  const last = matches[matches.length - 1];
  return last?.[1] ?? null;
}
