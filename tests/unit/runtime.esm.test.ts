/**
 * ES modules through the same loader (ADR-0012).
 *
 * Each test is a shape a real package uses, not a syntax catalogue: default and named imports, a namespace, a
 * re-export, dynamic import, import.meta.url, and interop in both directions with CommonJS. The two refusals are
 * tested as refusals, because a transform that silently mis-executes top-level await would be worse than one that
 * says no.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { transformEsm, EsmSyntaxError } from "../../src/runtime/esm.js";
import { FileSystem } from "../../src/vfs/index.js";

const run = async (files: Record<string, string>, entry: string) => {
  const { vfs, root } = boot(files);
  return new InProcessRuntime(vfs).run(`${root}/${entry}`);
};

/** Same shape as the loader tests in runtime.in-process.test.ts: real VFS, real shims, no mocks. */
function boot(files: Readonly<Record<string, string>>): { vfs: FileSystem; root: string } {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  return { vfs, root: "/app" };
}

describe("ES modules", () => {
  it("imports a default export from another ES module", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import greet from "./greet.js";\nconsole.log(greet("world"));',
        "/app/greet.js": 'export default (name) => `hello ${name}`;',
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("hello world\n");
  });

  it("imports named exports, including a renamed one", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import { a, b as renamed } from "./values.js";\nconsole.log(a, renamed);',
        "/app/values.js": "export const a = 1;\nexport const b = 2;",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("1 2\n");
  });

  it("imports a namespace and reads its members", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import * as values from "./values.js";\nconsole.log(values.a + values.b);',
        "/app/values.js": "export const a = 20;\nexport const b = 22;",
      },
      "main.js",
    );

    expect(result.stdout).toBe("42\n");
  });

  it("supports export default on a named function, and importing it by name", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import handler from "./handler.js";\nconsole.log(handler());',
        "/app/handler.js": "export default function handle() {\n  return 'handled';\n}",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("handled\n");
  });

  it("supports a re-export with an alias", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import { renamed } from "./barrel.js";\nconsole.log(renamed);',
        "/app/barrel.js": 'export { original as renamed } from "./value.js";',
        "/app/value.js": "export const original = 'carried through';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("carried through\n");
  });

  it("supports export * from, without leaking default", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import * as all from "./barrel.js";\nconsole.log(all.a, all.default === undefined);',
        "/app/barrel.js": 'export * from "./values.js";',
        "/app/values.js": "export const a = 7;\nexport default 'should not leak';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("7 true\n");
  });

  it("interoperates with a CommonJS dependency in both directions", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js":
          'import legacy from "./legacy.cjs";\nimport { helper } from "./helper.mjs";\nconsole.log(legacy(), helper());',
        "/app/legacy.cjs": "module.exports = () => 'from cjs';",
        "/app/helper.mjs": "export const helper = () => 'from esm';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("from cjs from esm\n");
  });

  it("imports a Node builtin by name", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import { EventEmitter } from "events";\nconst e = new EventEmitter();\ne.on("x", () => console.log("ok"));\ne.emit("x");',
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ok\n");
  });

  it("resolves an ES module dependency from node_modules by its type field", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module", dependencies: { lib: "1.0.0" } }),
        "/app/node_modules/lib/package.json": JSON.stringify({ name: "lib", version: "1.0.0", type: "module", main: "index.js" }),
        "/app/node_modules/lib/index.js": "export const name = 'lib';",
        "/app/main.js": 'import { name } from "lib";\nconsole.log(name);',
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("lib\n");
  });

  it("resolves a dynamic import through the loader, observable via the module's own evaluation", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        // The continuation is not observed (next test), so the proof is that the imported module ran at all.
        "/app/main.js": 'export const load = () => import("./lazy.js");\nload();',
        "/app/lazy.js": "console.log('lazy module evaluated');\nexport const value = 1;",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("lazy module evaluated\n");
  });

  it("observes output written in a promise continuation, now that evaluation is followed by a drain", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'import("./lazy.js").then(() => console.log("after the microtask"));',
        "/app/lazy.js": "export const value = 1;",
      },
      "main.js",
    );

    // This asserted the opposite until ADR-0013: the output was written into a sink nobody had read yet, which looked
    // exactly like a program printing nothing. The test is flipped rather than deleted so the change is visible.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("after the microtask\n");
  });

  it("exposes import.meta.url as a file URL", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "console.log(import.meta.url.endsWith('/main.js'), import.meta.url.startsWith('file://'));",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("true true\n");
  });

  it("treats a .mjs file as a module even when the package says commonjs", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "commonjs" }),
        "/app/main.mjs": 'import { a } from "./values.mjs";\nconsole.log(a);',
        "/app/values.mjs": "export const a = 'explicit';",
      },
      "main.mjs",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("explicit\n");
  });

  it("reports a syntax error as exit 1 with the parse failure on stderr", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/broken.js": "export const = ;",
      },
      "broken.js",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not parse ES module/);
  });
});

describe("transformEsm", () => {
  it("refuses top-level await with a message that says what to do instead", () => {
    expect(() => transformEsm("await Promise.resolve(1);", { url: "file:///app/x.js" })).toThrow(EsmSyntaxError);
    expect(() => transformEsm("await Promise.resolve(1);", { url: "file:///app/x.js" })).toThrow(/async function/);
  });

  it("allows await inside an async function", () => {
    const result = transformEsm("export const go = async () => { await Promise.resolve(1); };", {
      url: "file:///app/x.js",
    });
    expect(result.code).toContain("exports.go");
  });

  it("reports the imported specifiers it saw", () => {
    const result = transformEsm('import a from "one";\nimport { b } from "two";', { url: "file:///app/x.js" });
    expect(result.specifiers).toEqual(["one", "two"]);
  });
});
