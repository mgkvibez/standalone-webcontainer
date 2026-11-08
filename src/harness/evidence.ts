/**
 * Raw evidence on disk (charter §4.8): "Every scored run produces logs, console output, error
 * traces, and file manifests on disk. No summary without evidence."
 *
 * The only interesting part is containment. Evidence directories are named from fixture slugs, which
 * are data, so a hostile or fat-fingered slug must not be able to write outside the run directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { EvidenceBundle } from "./evidence-bundle.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSafeSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new Error(`unsafe fixture slug ${JSON.stringify(slug)}: expected lowercase kebab-case`);
  }
}

export async function writeEvidence(
  rootDir: string,
  fixtureSlug: string,
  files: Readonly<Record<string, string>>,
): Promise<EvidenceBundle> {
  assertSafeSlug(fixtureSlug);

  const root = resolve(rootDir);
  const dir = resolve(join(root, fixtureSlug));
  // Belt and braces: the slug regex already rules out `..` and absolute paths, but a future change to
  // the regex must not silently become a path-traversal bug.
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`evidence path escapes the run directory: ${dir}`);
  }

  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    if (!SLUG.test(name.replace(/\.[a-z0-9]+$/, ""))) {
      throw new Error(`unsafe evidence file name ${JSON.stringify(name)}`);
    }
    await writeFile(join(dir, name), contents, "utf8");
    written.push(name);
  }

  return { dir, files: written };
}
