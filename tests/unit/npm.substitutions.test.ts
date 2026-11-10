/**
 * Substitutions: a package whose published build cannot run here, served from its WebAssembly equivalent.
 *
 * The claim these tests hold is narrow and checkable: the *requested* name is what lands in the tree, the *substitute's* bytes are what
 * lands in it, and the report says so in words a person can read. That combination is what lets a package say `require('esbuild')` and
 * be served a build that never spawns a process, without any package learning that it happened.
 */

import { describe, expect, it } from "vitest";

import { installDependencies } from "../../src/npm/install.js";
import {
  parseSubstitutions,
  resolvedRange,
  SUBSTITUTIONS,
  substitutionFor,
  SubstitutionError,
  type Substitution,
} from "../../src/npm/substitutions.js";
import { createFakeRegistry } from "../helpers/registry.js";
import { bootVfs, exists, text } from "../helpers/vfs.js";

describe("the table", () => {
  it("substitutes esbuild, keeps the caller's range, and names the hook it will need", () => {
    const entry = substitutionFor("esbuild");
    expect(entry?.substitute).toBe("esbuild-wasm");
    expect(entry?.rule).toBe("range");
    // Not called here: installing bytes and running a module's startup are different layers.
    expect(entry?.initHook).toBe("esbuild-wasm:initialize");
    expect(entry?.reason).toContain("child_process");
    // Everything else is untouched, which is the ordinary answer.
    expect(substitutionFor("express")).toBeUndefined();
  });

  it("refuses rows that cannot be honoured as written", () => {
    const base: Substitution = { requested: "a", substitute: "b", rule: "range", reason: "because" };
    const reject = (row: Substitution, code: string): void => {
      expect(() => parseSubstitutions([row])).toThrowError(expect.objectContaining({ code }));
    };

    reject({ ...base, substitute: "a" }, "SELF_SUBSTITUTION");
    reject({ ...base, requested: "Bad Name" }, "INVALID_REQUESTED_NAME");
    reject({ ...base, reason: "  " }, "MISSING_REASON");
    reject({ ...base, rule: "exact" }, "MISSING_PIN");
    // A pin on a rule that ignores it would be a lie told by the table itself.
    reject({ ...base, pinnedVersion: "1.2.3" }, "UNUSED_PIN");
    expect(() => parseSubstitutions([base, base])).toThrowError(expect.objectContaining({ code: "DUPLICATE_SUBSTITUTION" }));
    // a -> b and b -> c would make the outcome depend on iteration order.
    expect(() => parseSubstitutions([base, { ...base, requested: "b", substitute: "c" }])).toThrowError(
      expect.objectContaining({ code: "CHAINED_SUBSTITUTION" }),
    );
  });

  it("keeps the caller's range for the substitute to resolve against", () => {
    const entry = SUBSTITUTIONS[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(resolvedRange(entry, "^0.21.3")).toBe("^0.21.3");
    expect(resolvedRange({ ...entry, rule: "exact", pinnedVersion: "0.21.5" }, "^0.21.3")).toBe("0.21.5");
    expect(resolvedRange({ ...entry, rule: "latest" }, "^0.21.3")).toBe("*");
  });
});

describe("an install that substitutes", () => {
  const registry = async () =>
    createFakeRegistry({
      packages: {
        esbuild: [{ version: "0.21.5", files: { "lib/main.js": "module.exports = 'spawns a binary';" } }],
        "esbuild-wasm": [{ version: "0.21.5", files: { "lib/main.js": "module.exports = 'wasm';" } }],
        plain: [{ version: "1.0.0", files: { "index.js": "module.exports = 1;" } }],
      },
    });

  it("puts the substitute's bytes under the requested name and records why", async () => {
    const { vfs, root } = bootVfs();
    const report = await installDependencies({ dependencies: { esbuild: "^0.21.3" } }, { registry: await registry(), vfs, root });

    // The directory is the requested name, because that is where `require('esbuild')` looks.
    expect(report.packages).toEqual([{ name: "esbuild", version: "0.21.5", path: "/app/node_modules/esbuild" }]);
    // The bytes are the substitute's, which is the whole point.
    expect(text(vfs, "/app/node_modules/esbuild/lib/main.js")).toBe("module.exports = 'wasm';");
    // And it is not ALSO installed under its own name, which would be two copies of a 12 MB build.
    expect(exists(vfs, "/app/node_modules/esbuild-wasm")).toBe(false);

    expect(report.substitutions).toHaveLength(1);
    expect(report.substitutions[0]).toMatchObject({
      requested: "esbuild",
      substitute: "esbuild-wasm",
      rule: "range",
      requestedRange: "^0.21.3",
      version: "0.21.5",
      initHook: "esbuild-wasm:initialize",
    });
    expect(report.warnings.join("\n")).toContain("served by esbuild-wasm@0.21.5");
  });

  it("leaves an unrelated package alone and reports no substitutions", async () => {
    const { vfs, root } = bootVfs();
    const report = await installDependencies({ dependencies: { plain: "^1.0.0" } }, { registry: await registry(), vfs, root });

    expect(report.substitutions).toEqual([]);
    expect(text(vfs, "/app/node_modules/plain/index.js")).toBe("module.exports = 1;");
  });

  it("blames the table, not the user's project, when the substitute cannot honour the range", async () => {
    const thin = await createFakeRegistry({
      packages: {
        esbuild: [{ version: "0.21.5" }],
        "esbuild-wasm": [{ version: "0.9.0" }],
      },
    });
    const { vfs, root } = bootVfs();

    await expect(
      installDependencies({ dependencies: { esbuild: "^0.21.3" } }, { registry: thin, vfs, root }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SUBSTITUTE_NO_MATCH" }));
    await expect(
      installDependencies({ dependencies: { esbuild: "^0.21.3" } }, { registry: thin, vfs, root }),
    ).rejects.toThrowError(SubstitutionError);
  });

  it("names both versions when the substitute has not published the asked-for line, and installs nothing", async () => {
    // The version-drift window is real: the two packages move together but not simultaneously, so a dependent can ask for an esbuild version
    // esbuild-wasm has not shipped. The refusal must be one sentence naming both sides, because naming only the range sends the reader to look
    // at their own dependency, and it must refuse rather than fall back to "latest", which would hand back a different compiler silently.
    const drifted = await createFakeRegistry({
      packages: {
        esbuild: [{ version: "0.28.2" }],
        "esbuild-wasm": [{ version: "0.21.4" }, { version: "0.21.5" }],
      },
    });
    const { vfs, root } = bootVfs();

    const attempt = installDependencies({ dependencies: { esbuild: "^0.28.2" } }, { registry: drifted, vfs, root });

    await expect(attempt).rejects.toThrowError(/esbuild@\^0\.28\.2 needs a version esbuild-wasm has not published/);
    await expect(attempt).rejects.toThrowError(/newest is 0\.21\.5/);
    expect(() => vfs.statSync(`${root}/node_modules/esbuild`)).toThrow();
  });
});
