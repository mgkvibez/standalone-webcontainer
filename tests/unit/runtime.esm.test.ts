/**
 * ES modules through the same loader (ADR-0012).
 *
 * Each test is a shape a real package uses, not a syntax catalogue: default and named imports, a namespace, a
 * re-export, dynamic import, import.meta.url, and interop in both directions with CommonJS. Top-level await is tested for what
 * it actually does now: the transform reports it, an entry module that needs it settles before the program is judged, dynamic
 * import waits for it, and a synchronous `require` of such a module refuses with Node's own code. Each of those was measured
 * against node v20.20.2 rather than assumed, and the differential cases in tools/differential keep it that way.
 */

import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { transformEsm } from "../../src/runtime/esm.js";
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

describe("top-level await", () => {
  it("waits for an entry module that awaits before it reports the run finished", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "console.log('before');\nawait Promise.resolve();\nconsole.log('after');",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    // The second line is the whole test: without waiting for evaluation the run ends between the two prints.
    expect(result.stdout).toBe("before\nafter\n");
  });

  it("exposes exports that are only assigned after an await", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "import('./late.js').then((m) => console.log('value=' + m.value));",
        "/app/late.js": "await Promise.resolve();\nexport const value = 'set-after-await';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("value=set-after-await\n");
  });

  it("waits for an entry whose body is suspended on a TIMER, not just on a microtask", async () => {
    // This is the shape that deadlocked. `await Promise.resolve()` settles inside the microtask queue, so it worked while a timer did not: the
    // runner awaited a promise whose only resolver was a scheduler timer that nothing was running. The run ended at its timeout having printed
    // nothing, which reads like a hang rather than a missing pump.
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "console.log('before');\nawait new Promise((resolve) => setTimeout(resolve, 5));\nconsole.log('after');",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("before\nafter\n");
  });

  it("runs timers the entry scheduled after its last await before the program is judged", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": [
          "await Promise.resolve();",
          "setTimeout(() => console.log('timer-after-await'), 1);",
          "console.log('body-done');",
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("body-done\ntimer-after-await\n");
  });

  it("refuses a STATIC import of an async module with a code that names both ends", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "import { value } from './late.js';\nconsole.log('value=' + value);",
        "/app/late.js": "console.log('late-body-ran');\nexport const value = await Promise.resolve('x');",
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    // Node supports this import through async module records, which this runtime does not implement. So the code is ours, not Node's, and the
    // message has to carry both file names: the module is what must change, the importer is where the reader can act.
    expect(result.stderr).toContain("TLA_IN_NON_ENTRY");
    expect(result.stderr).toContain("/app/late.js");
    expect(result.stderr).toContain("/app/main.js");
    // Refused BEFORE evaluation: a module that cannot be waited for must not run its first statements and then fail.
    expect(result.stdout).toBe("");
  });

  it("refuses a static import of an async module that is already in the cache", async () => {
    // The second edge must report what the first one did, or a module reached twice would silently succeed on the second path.
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": [
          "try { await import('./late.js'); } catch (error) { console.log('dynamic=' + (error && error.code)); }",
          "import { later } from './second.js';",
          "console.log('value=' + later);",
        ].join("\n"),
        "/app/second.js": "import { value } from './late.js';\nexport const later = value;",
        "/app/late.js": "export const value = await Promise.resolve('x');",
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TLA_IN_NON_ENTRY");
    expect(result.stderr).toContain("/app/second.js");
  });

  it("refuses a synchronous require of an async module with Node's code", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "commonjs" }),
        "/app/main.js": [
          "try { require('./late.mjs'); } catch (error) { console.log('name=' + error.name + ' code=' + error.code); }",
        ].join("\n"),
        "/app/late.mjs": "await Promise.resolve();\nexport const value = 'set';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    // Measured against node v20.20.2: the name is "Error" and the code is ERR_REQUIRE_ASYNC_MODULE.
    expect(result.stdout).toBe("name=Error code=ERR_REQUIRE_ASYNC_MODULE\n");
  });

  it("keeps refusing require after the async module has already settled", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "commonjs" }),
        "/app/main.js": [
          "const helper = require('./helper.mjs');",
          "helper.done.then((value) => {",
          "  console.log('settled=' + value);",
          "  try { require('./late.mjs'); } catch (error) { console.log('second=' + error.code); }",
          "});",
        ].join("\n"),
        "/app/helper.mjs": "export const done = import('./late.mjs').then((m) => m.value);",
        "/app/late.mjs": "await Promise.resolve();\nexport const value = 'set';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    // Node's rule is about the graph, not the timing: an already-evaluated async module is still refused.
    expect(result.stdout).toBe("settled=set\nsecond=ERR_REQUIRE_ASYNC_MODULE\n");
  });

  it("reports a throw after the first await as the program failing", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "await Promise.resolve();\nthrow new TypeError('late boom');",
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    // A rejection from the entry's evaluation must reach stderr and the exit code, not disappear into an unhandled promise.
    expect(result.stderr).toMatch(/late boom/);
  });
});

describe("a module that binds a name the wrapper injects", () => {
  it("keeps every export of a module that declares its own top-level `exports`", async () => {
    // Vite's bundled chunk carries its own package.json as top-level vars, including `var exports = { ... }`. Real ESM has no
    // `exports`, so that is an ordinary local and the module's exports are unaffected. Writing our exports into that name instead
    // lost everything declared after the assignment, which is why the transform targets `__cjsExports`.
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": "import { before, after } from './chunk.js';\nconsole.log('before=' + before + ' after=' + after);",
        "/app/chunk.js": [
          "export const before = 'kept';",
          "var exports = { metadata: true };",
          "export const after = 'also-kept';",
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("before=kept after=also-kept\n");
  });
});

describe("transformEsm", () => {
  it("reports top-level await instead of refusing it", () => {
    const result = transformEsm("await Promise.resolve(1);", { url: "file:///app/x.js" });
    expect(result.hasTopLevelAwait).toBe(true);
    // The await itself is left where it is: the loader decides how to evaluate it, the transform only says that it is there.
    expect(result.code).toContain("await Promise.resolve(1);");
  });

  it("reports `for await` at module scope as top-level await", () => {
    // There is no AwaitExpression node for this form, so a detector that only looked for one would call this module synchronous.
    const result = transformEsm("for await (const x of []) { void x; }", { url: "file:///app/x.js" });
    expect(result.hasTopLevelAwait).toBe(true);
  });

  it("does not report await inside an async function", () => {
    const result = transformEsm("export const go = async () => { await Promise.resolve(1); };", {
      url: "file:///app/x.js",
    });
    expect(result.code).toContain("__esmExports.go");
    expect(result.hasTopLevelAwait).toBe(false);
  });

  it("reports the imported specifiers it saw", () => {
    const result = transformEsm('import a from "one";\nimport { b } from "two";', { url: "file:///app/x.js" });
    expect(result.specifiers).toEqual(["one", "two"]);
  });
});

describe("a default import of events is the class", () => {
  it("extends it, which is the exact expression that stopped vite's boot", async () => {
    // `import require$$0$7 from 'events'` then `class WebSocket extends require$$0$7`: the interop rule for a value without
    // `__esModule` hands the default the value itself, so the base class is the EventEmitter constructor and not a namespace.
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": [
          'import events from "events";',
          'import { EventEmitter } from "events";',
          "class WebSocket extends events {}",
          'const socket = new WebSocket();',
          'socket.on("open", () => console.log("extends:" + (events === EventEmitter)));',
          'socket.emit("open");',
        ].join("\n"),
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("extends:true\n");
  });
});

describe("a `file:` URL specifier", () => {
  it("imports a module by URL, which is how vite loads a bundled config it just wrote", async () => {
    // The literal shape: vite writes the bundled config to `/vite.config.js.timestamp-....mjs`, then `await import(pathToFileURL(temp).href)`.
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": [
          'import { pathToFileURL } from "node:url";',
          'const loaded = await import(pathToFileURL("/app/bundled.config.mjs").href);',
          "console.log(loaded.default.name, loaded.default.served);",
        ].join("\n"),
        "/app/bundled.config.mjs": "export default { name: 'from-url', served: true };",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("from-url true\n");
  });

  it("reports a missing URL target as a module-not-found naming the URL", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'await import("file:///app/absent.mjs");',
      },
      "main.js",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("file:///app/absent.mjs");
  });

  it("percent-decodes the URL, so a path with a space resolves to the file with the space", async () => {
    const result = await run(
      {
        "/app/package.json": JSON.stringify({ name: "app", type: "module" }),
        "/app/main.js": 'const loaded = await import("file:///app/a%20b.mjs");\nconsole.log(loaded.value);',
        "/app/a b.mjs": "export const value = 'spaced';",
      },
      "main.js",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("spaced\n");
  });
});
