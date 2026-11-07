/**
 * Freeze trainer, as a library: records and verifies the pins that make a frozen fixture trustworthy.
 *
 * The command line lives in `freeze-fixtures.ts` and is deliberately a separate file. Detecting "was I run as a
 * script" from `process.argv` is unreliable under a TS runner: vite-node passes its own wrapper as `argv[1]`, so the
 * usual `import.meta.url === pathToFileURL(argv[1])` guard is false and the process exits 0 having checked nothing.
 * A file that always runs when executed, and is never imported by tests, has no such failure mode.
 *
 * Two modes, one code path:
 *
 *   npm run fixtures:freeze   pin every definition whose owner has marked it `frozen`
 *   npm run fixtures:check    verify the pins; exit non-zero on drift or an unverifiable frozen claim
 *
 * Why a tool rather than something the harness does: writing a pin is an authoring act, and it must be possible for
 * CI to verify pins without any possibility of refreshing them on the way past. `--check` never writes.
 *
 * Exit codes are the contract, so they are stated here: 0 clean, 1 drift or unverifiable pin, 2 the corpus itself is
 * inconsistent (bad manifest, unparseable definition, or a definition that disagrees with its manifest slot).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseDefinition, type FixtureDefinition } from "../src/harness/definition.js";
import { hashDefinition } from "../src/harness/freeze.js";
import { parseManifest, type ManifestEntry } from "../src/harness/manifest.js";

export interface FreezeRunResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export class CorpusError extends Error {}
export class DriftError extends Error {}

/** Where the manifest lives, relative to the project root, and where pins are recorded. */
const MANIFEST_PATH = "fixtures/manifest.json";

interface RawManifest {
  readonly fixtures: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

async function readJson(absolutePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CorpusError(`no such file: ${absolutePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CorpusError(`${absolutePath} is not valid JSON: ${(error as Error).message}`);
  }
}

interface LoadedFixture {
  readonly entry: ManifestEntry;
  readonly definition: FixtureDefinition;
  readonly hash: string;
}

/**
 * Read the corpus and check that the manifest and the definitions agree about identity.
 *
 * A definition whose id, slug or lane disagrees with its slot is a corruption, not a drift: the fixture would be
 * scored in a lane the charter did not assign it, which is exactly how a gate gets moved without anyone editing the
 * threshold.
 */
export async function loadCorpus(cwd: string): Promise<readonly LoadedFixture[]> {
  const rawManifest = await readJson(join(cwd, MANIFEST_PATH));
  let entries: readonly ManifestEntry[];
  try {
    entries = parseManifest(rawManifest);
  } catch (error) {
    throw new CorpusError(`${MANIFEST_PATH}: ${(error as Error).message}`);
  }

  const loaded: LoadedFixture[] = [];
  for (const entry of entries) {
    if (entry.definitionPath === null) continue;
    const absolute = join(cwd, entry.definitionPath);
    const rawDefinition = await readJson(absolute);
    let definition: FixtureDefinition;
    try {
      definition = parseDefinition(rawDefinition, entry.definitionPath);
    } catch (error) {
      throw new CorpusError(`${entry.definitionPath}: ${(error as Error).message}`);
    }
    if (definition.id !== entry.id) {
      throw new CorpusError(`${entry.definitionPath} declares id ${definition.id} but sits in slot ${entry.id}`);
    }
    if (definition.slug !== entry.slug) {
      throw new CorpusError(`${entry.definitionPath} declares slug ${definition.slug} but slot ${entry.id} is ${entry.slug}`);
    }
    if (definition.lane !== entry.lane) {
      throw new CorpusError(
        `${entry.definitionPath} declares lane ${definition.lane} but slot ${entry.id} is ${entry.lane}`,
      );
    }
    loaded.push({ entry, definition, hash: await hashDefinition(definition) });
  }
  return loaded;
}

/** Verify every pin without writing anything. */
export async function checkPins(cwd: string): Promise<FreezeRunResult> {
  const loaded = await loadCorpus(cwd);
  const lines: string[] = [];
  let exitCode = 0;

  for (const { entry, definition, hash } of loaded) {
    if (definition.status !== "frozen") {
      lines.push(`fixture ${entry.id}: unfrozen (proposed, awaiting sign-off)`);
      continue;
    }
    if (entry.frozenHash === null) {
      lines.push(`fixture ${entry.id}: UNVERIFIABLE — frozen but the manifest records no pin`);
      exitCode = 1;
      continue;
    }
    if (entry.frozenHash !== hash) {
      lines.push(`fixture ${entry.id}: DRIFTED — pinned ${entry.frozenHash.slice(0, 12)}… now ${hash.slice(0, 12)}…`);
      exitCode = 1;
      continue;
    }
    lines.push(`fixture ${entry.id}: frozen and intact`);
  }

  const unfrozen = loaded.filter((item) => item.definition.status !== "frozen").length;
  lines.push(
    `${loaded.length} definitions, ${loaded.length - unfrozen} frozen, ${unfrozen} awaiting sign-off, exit ${exitCode}`,
  );
  return { exitCode, lines };
}

/**
 * Record pins for every definition the owner has frozen.
 *
 * A `proposed` definition is left alone: refreshing a pin for content nobody approved would manufacture consent. A
 * stale pin on a proposed definition is likewise left in place, because verification ignores it until the definition
 * is frozen again, and silently deleting a hash hides that someone un-froze a fixture.
 */
export async function freezePins(cwd: string): Promise<FreezeRunResult> {
  const loaded = await loadCorpus(cwd);
  const manifestPath = join(cwd, MANIFEST_PATH);
  const rawManifest = (await readJson(manifestPath)) as RawManifest;
  const lines: string[] = [];

  const pins = new Map<number, string>();
  for (const { entry, definition, hash } of loaded) {
    if (definition.status !== "frozen") {
      lines.push(`fixture ${entry.id}: skipped, still proposed (sign-off is the owner's)`);
      continue;
    }
    if (entry.frozenHash === hash) {
      lines.push(`fixture ${entry.id}: already pinned`);
      continue;
    }
    pins.set(entry.id, hash);
    lines.push(`fixture ${entry.id}: ${entry.frozenHash === null ? "pinned" : "re-pinned"} ${hash.slice(0, 12)}…`);
  }

  if (pins.size === 0) {
    lines.push("nothing to write");
    return { exitCode: 0, lines };
  }

  // Preserve field order and every other key: the manifest is hand-maintained prose plus data, and a rewrite that
  // reordered it would bury the one changed field in a large diff.
  const fixtures = rawManifest.fixtures.map((raw) => {
    const id = raw["id"];
    if (typeof id !== "number") return raw;
    const pin = pins.get(id);
    if (pin === undefined) return raw;
    return { ...raw, frozenHash: pin };
  });
  const updated: RawManifest = { ...rawManifest, fixtures };
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  lines.push(`wrote ${pins.size} pin(s) to ${MANIFEST_PATH}`);
  return { exitCode: 0, lines };
}

export interface FreezeFlags {
  readonly check: boolean;
  readonly unknown: readonly string[];
}

/**
 * Read the flags this tool accepts.
 *
 * Only `--`-prefixed arguments are considered at all. A runner contributes its own script path as a bare argument,
 * and treating that as an unknown flag would make the tool refuse to run under `npm run`, which is the only way it is
 * ever invoked. Positional arguments carry no meaning here, so they are ignored rather than guessed at.
 */
export function parseFlags(argv: readonly string[]): FreezeFlags {
  const flags = argv.filter((argument) => argument.startsWith("--"));
  return { check: flags.includes("--check"), unknown: flags.filter((flag) => flag !== "--check") };
}

/** Entry point shared by the CLI and the tests, so the exit codes are covered rather than assumed. */
export async function runFreeze(argv: readonly string[], cwd: string): Promise<FreezeRunResult> {
  const { check, unknown } = parseFlags(argv);
  if (unknown.length > 0) {
    return { exitCode: 2, lines: [`unknown argument(s): ${unknown.join(" ")}`, "usage: freeze-fixtures [--check]"] };
  }
  try {
    return check ? await checkPins(cwd) : await freezePins(cwd);
  } catch (error) {
    if (error instanceof CorpusError) return { exitCode: 2, lines: [`corpus error: ${error.message}`] };
    throw error;
  }
}
