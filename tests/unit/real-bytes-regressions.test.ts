/**
 * Defects that only real package bytes produced, one test per defect.
 *
 * Each case here came from running a real registry graph through the loader and reading the failure: the synthetic corpus is good at
 * the shapes we imagined, and the bugs below were all shapes we did not. They are grouped in one file because the thing they share is
 * provenance, not subject: module scope, the transform's own emitted names, and the builtin surface a modern toolchain assumes.
 *
 * The governing rule for every case: our generated code must never depend on a name the module is free to bind itself, and a shim must
 * only claim what it actually does.
 */

import { describe, expect, it } from "vitest";

import { transformEsm } from "../../src/runtime/esm.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { createModuleShim } from "../../src/shims/module.js";
import { FileSystem } from "../../src/vfs/index.js";

const boot = (files: Readonly<Record<string, string>>): { vfs: FileSystem; root: string } => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return { vfs, root: "/app" };
};

const run = async (files: Record<string, string>, entry: string) => {
  const { vfs, root } = boot(files);
  return new InProcessRuntime(vfs).run(`${root}/${entry}`);
};

describe("the transform's emitted names", () => {
  it("mangles past every internal name the module already uses", async () => {
    // Vite's bundled chunk opens with `const require = createRequire(import.meta.url)` and `const __require = require`. Both made the
    // generated prologue throw from inside the module's own temporal dead zone, so the names are now computed per module.
    const transformed = transformEsm(
      'const require = "mine";\nconst __esmRequire = "also mine";\nexport const value = 1;',
      { url: "file:///app/chunk.js" },
    );

    // The emitted names move out of the way: `__esmRequire` becomes `__esmRequire1`, so the prologue never touches a name the module
    // has bound for itself.
    expect(transformed.injected.require).toBe("__esmRequire1");
    expect(transformed.injected.exports).toBe("__esmExports1");
    expect(transformed.code).toContain("Object.defineProperty(__esmExports1,");
    // The module's own `const require` is untouched, because the prologue no longer uses that name at all.
    expect(transformed.code).toContain('const require = "mine";');
    // Its `__esmRequire` local is renamed consistently with ours, which is a safe rename of a local rather than a collision.
    expect(transformed.code).toContain('const __esmRequire1 = "also mine";');
  });

  it("leaves the names alone when the module does not use them", () => {
    const transformed = transformEsm("export const value = 1;", { url: "file:///app/plain.js" });
    expect(transformed.injected.require).toBe("__esmRequire");
    expect(transformed.injected.exports).toBe("__esmExports");
  });

  it("still exports from a module that declares its own `require`", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "import { value } from './chunk.js';\nconsole.log('value=' + value);",
        "/app/chunk.js": [
          "import { createRequire } from 'node:module';",
          "const localRequire = createRequire(import.meta.url);",
          "export const value = typeof localRequire('node:path').join;",
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("value=function\n");
  });
});

describe("module.createRequire", () => {
  it("resolves relative to the file it was created from, not the process cwd", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/lib/helper.js": "module.exports = 'from-lib';",
        "/app/lib/user.js": [
          "import { createRequire } from 'node:module';",
          "const here = createRequire(import.meta.url);",
          "console.log(here('./helper.js'));",
        ].join("\n"),
      },
      "lib/user.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("from-lib\n");
  });

  it("answers isBuiltin and builtinModules from this runtime's own table", () => {
    const names = ["fs", "fs/promises", "path"];
    const shim = createModuleShim({
      createRequire: () => Object.assign(() => undefined, { resolve: () => "", main: undefined, cache: undefined }),
      builtinNames: () => names,
    });

    expect(shim.isBuiltin("node:fs")).toBe(true);
    expect(shim.isBuiltin("fs/promises")).toBe(true);
    // The honest answer: in this runtime that is not a builtin, and a package asking is asking about the runtime it is in.
    expect(shim.isBuiltin("worker_threads")).toBe(false);
    expect([...shim.builtinModules]).toEqual(names);
  });
});

describe("fs/promises", () => {
  it("removes a directory tree recursively and tolerates a missing path under force", async () => {
    const result = await run(
      {
        "/app/main.js": [
          "const fs = require('fs/promises');",
          "fs.mkdir('/app/cache/deep', { recursive: true })",
          "  .then(() => fs.writeFile('/app/cache/deep/file.txt', 'x'))",
          "  .then(() => fs.readdir('/app/cache/deep'))",
          "  .then((entries) => console.log('before=' + entries.join(',')))",
          "  .then(() => fs.rm('/app/cache', { recursive: true, force: true }))",
          "  .then(() => fs.access('/app/cache').then(() => console.log('still there'), (error) => console.log('gone=' + error.code)))",
          "  .then(() => fs.rm('/app/never-existed', { recursive: true, force: true }))",
          "  .then(() => console.log('force ok'))",
          "  .catch((error) => { console.error(error.code + ': ' + error.message); process.exit(1); });",
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("before=file.txt\ngone=ENOENT\nforce ok\n");
  });

  it("stats, and reports the same object shape as fs.promises", async () => {
    const result = await run(
      {
        "/app/main.js": [
          "const fs = require('fs');",
          "const fsp = require('fs/promises');",
          "console.log('same=' + (fs.promises.readFile === fsp.readFile));",
          "fsp.stat('/app/main.js').then((stats) => console.log('dir=' + stats.isDirectory()));",
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stdout).toContain("same=true");
    expect(result.stdout).toContain("dir=false");
  });
});
