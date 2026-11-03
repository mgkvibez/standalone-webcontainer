import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSafeSlug, writeEvidence } from "../../src/harness/evidence.js";

const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swc-evidence-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeEvidence", () => {
  it("writes every file and reports what it wrote", async () => {
    const root = await tempRoot();
    const bundle = await writeEvidence(root, "fixture-01", {
      "run.log": "ok",
      "manifest.json": '{"files":[]}',
    });
    expect([...bundle.files].sort()).toEqual(["manifest.json", "run.log"]);
    expect(await readFile(join(bundle.dir, "run.log"), "utf8")).toBe("ok");
    expect((await readdir(bundle.dir)).sort()).toEqual(["manifest.json", "run.log"]);
  });

  it("rejects a slug that could escape the run directory", async () => {
    const root = await tempRoot();
    await expect(writeEvidence(root, "../escape", { "a.log": "x" })).rejects.toThrow("unsafe fixture slug");
    await expect(writeEvidence(root, "Fixture-01", { "a.log": "x" })).rejects.toThrow("unsafe fixture slug");
    await expect(writeEvidence(root, "/etc/passwd", { "a.log": "x" })).rejects.toThrow("unsafe fixture slug");
  });

  it("rejects an evidence file name that is really a path", async () => {
    const root = await tempRoot();
    await expect(writeEvidence(root, "fixture-01", { "../../evil": "x" })).rejects.toThrow();
  });

  it("accepts only lowercase kebab-case slugs", () => {
    expect(() => assertSafeSlug("fixture-01")).not.toThrow();
    expect(() => assertSafeSlug("next-js-app")).not.toThrow();
    expect(() => assertSafeSlug("Fixture-01")).toThrow();
    expect(() => assertSafeSlug("fixture_01")).toThrow();
    expect(() => assertSafeSlug("")).toThrow();
  });
});
