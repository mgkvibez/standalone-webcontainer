/**
 * The shipped corpus, checked against itself.
 *
 * A definition is data about a project, and the two can disagree silently: a step can `npm run build` when the shipped
 * package.json has no `build` script, or an assertion can look for text that no shipped file produces. Neither shows up
 * until a run, where it surfaces as a runtime failure and blames the wrong thing. These checks run offline, in
 * milliseconds, and fail the build instead.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { materializeProject } from "../../src/harness/project.js";
import { parseStepCommand } from "../../src/harness/command.js";
import { FileSystem } from "../../src/vfs/index.js";

const DEFINITIONS = join(import.meta.dirname, "..", "..", "fixtures", "definitions");

function loadCorpus(): readonly FixtureDefinition[] {
  return readdirSync(DEFINITIONS)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseDefinition(JSON.parse(readFileSync(join(DEFINITIONS, name), "utf8")), name));
}

const corpus = loadCorpus();
const staged = corpus.filter((definition) => definition.files !== undefined);

describe("the shipped corpus", () => {
  it("is the twenty pre-registered fixtures, each parsing", () => {
    expect(corpus).toHaveLength(20);
    expect(corpus.map((definition) => definition.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("stages at least one fixture and never more than the whole corpus", () => {
    // Not a completeness assertion. Staging is content work done fixture by fixture, and asserting "all twenty" today
    // would only fail. This bounds the number that is staged so it cannot silently drop to zero.
    expect(staged.length).toBeGreaterThanOrEqual(1);
    expect(staged.length).toBeLessThanOrEqual(corpus.length);
  });

  for (const definition of staged) {
    describe(definition.slug, () => {
      it("stages every file without escaping the project root", () => {
        const vfs = new FileSystem();
        vfs.mkdirSync("/app", { recursive: true });
        const written = materializeProject(vfs, "/app", definition.files ?? {});
        expect(written).toHaveLength(Object.keys(definition.files ?? {}).length);

        for (const path of written) {
          expect(vfs.readFileSync(path, "utf8")).toBeTypeOf("string");
        }
      });

      it("runs only scripts its own package.json defines", () => {
        const files = definition.files ?? {};
        const packageJson = files["package.json"];
        const scripts =
          packageJson === undefined
            ? undefined
            : (JSON.parse(packageJson) as { scripts?: Record<string, string> }).scripts;

        for (const step of definition.steps) {
          const plan = parseStepCommand(step.command);
          if (plan.kind !== "run-script") continue;

          expect(packageJson, `${definition.slug} runs a script but ships no package.json`).toBeDefined();
          expect(scripts, `${definition.slug} ships no scripts block`).toBeDefined();
          expect(
            Object.keys(scripts ?? {}),
            `${definition.slug} runs "npm run ${plan.script}" which its package.json does not define`,
          ).toContain(plan.script);
        }
      });

      it("asserts on text that some shipped file actually contains", () => {
        const contents = Object.values(definition.files ?? {}).join("\n");
        for (const assertion of definition.assertions) {
          if (assertion.contains === undefined) continue;
          // http-body-contains is the case where the expected text has to originate in the project we ship.
          if (assertion.kind !== "http-body-contains") continue;
          expect(
            contents,
            `${definition.slug} expects the response to contain ${JSON.stringify(assertion.contains)} but no shipped file contains it`,
          ).toContain(assertion.contains);
        }
      });
    });
  }
});
