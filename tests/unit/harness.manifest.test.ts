import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseManifest, undefinedFixtures } from "../../src/harness/manifest.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("parseManifest", () => {
  it("accepts the checked-in manifest and transcribes all twenty slots", async () => {
    const raw = JSON.parse(await readFile(join(REPO_ROOT, "fixtures/manifest.json"), "utf8"));
    const entries = parseManifest(raw);
    expect(entries).toHaveLength(20);
    expect(entries[0]).toMatchObject({ id: 1, lane: "front-end-only" });
    expect(entries.find((entry) => entry.id === 5)?.lane).toBe("boundary");
  });

  it("names every slot that still has no definition", async () => {
    const raw = JSON.parse(await readFile(join(REPO_ROOT, "fixtures/manifest.json"), "utf8"));
    // The charter fixes the numbering, not the contents. Until the owner specifies fixtures, every
    // slot is honestly reported as undefined rather than silently treated as scored.
    expect(undefinedFixtures(parseManifest(raw))).toHaveLength(20);
  });

  it("rejects a manifest that moves a fixture out of its charter lane", () => {
    const raw = { fixtures: [{ id: 1, slug: "fixture-01", lane: "boundary", definitionPath: null }] };
    expect(() => parseManifest(raw)).toThrow("charter assigns it to front-end-only");
  });

  it("rejects unknown ids, duplicate ids and unsafe slugs", () => {
    expect(() => parseManifest({ fixtures: [{ id: 21, slug: "x", lane: "boundary" }] })).toThrow(
      "outside the pre-registered 1-20 range",
    );
    expect(() =>
      parseManifest({
        fixtures: [
          { id: 2, slug: "a", lane: "front-end-only", definitionPath: null },
          { id: 2, slug: "b", lane: "front-end-only", definitionPath: null },
        ],
      }),
    ).toThrow("more than once");
    expect(() => parseManifest({ fixtures: [{ id: 2, slug: "../x", lane: "front-end-only" }] })).toThrow(
      "unsafe fixture slug",
    );
  });

  it("rejects a shape that is not a manifest", () => {
    expect(() => parseManifest(null)).toThrow("must be an object");
    expect(() => parseManifest({})).toThrow("must be an object");
  });
});
