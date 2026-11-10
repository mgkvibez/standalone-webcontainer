/**
 * Module-resolution and error-shape cases, each a small file tree and one question.
 *
 * The event-loop differential in `cases.ts` compares ORDER. This file compares the other half of "does my program run" — which
 * file `require` picks, and what a program sees when resolution fails. Both are places where a reimplementation quietly differs
 * and where user code branches on the result, so both are measured against real Node rather than argued about.
 *
 * Every case prints plain deterministic text and, for failures, prints the FIELDS of the error (`name`, `code`) instead of the
 * stack. A stack contains file paths and Node's internal frames; comparing it would report differences that no program can
 * observe, and would hide the differences that matter behind noise.
 *
 * Each case must be deterministic and must not read the clock, the environment, or anything outside its own tree.
 */

export interface ModuleCase {
  readonly id: string;
  /** What resolution or failure question this case decides, in words. */
  readonly question: string;
  /** path → contents, relative to the case root. The entry is one of these paths. */
  readonly files: Readonly<Record<string, string>>;
  /** Entry file, relative to the case root. */
  readonly entry: string;
}

const ERROR_FIELDS = [
  "  const detail = (label, error) => console.log(label + ' name=' + error.name + ' code=' + error.code);",
].join("\n");

export const MODULE_CASES: readonly ModuleCase[] = [
  {
    id: "file-beats-directory",
    question: "does require('./lib') prefer lib.js over lib/index.js when both exist?",
    files: {
      "main.js": [
        "console.log('picked=' + require('./lib').which);",
      ].join("\n"),
      "lib.js": "exports.which = 'file';",
      "lib/index.js": "exports.which = 'directory';",
    },
    entry: "main.js",
  },
  {
    id: "trailing-slash-means-directory",
    question: "does require('./lib/') force the directory form even when lib.js exists?",
    files: {
      "main.js": [
        "console.log('picked=' + require('./lib/').which);",
      ].join("\n"),
      "lib.js": "exports.which = 'file';",
      "lib/index.js": "exports.which = 'directory';",
    },
    entry: "main.js",
  },
  {
    id: "package-main-field",
    question: "does a directory with a package.json main field load that file?",
    files: {
      "main.js": "console.log('picked=' + require('./pkg').which);",
      "pkg/package.json": JSON.stringify({ name: "pkg", main: "lib/entry.js" }),
      "pkg/lib/entry.js": "exports.which = 'main-field';",
      "pkg/index.js": "exports.which = 'index';",
    },
    entry: "main.js",
  },
  {
    id: "package-main-missing-falls-back",
    question: "does a package.json main that points at a missing file fall back to index.js?",
    files: {
      "main.js": "console.log('picked=' + require('./pkg').which);",
      "pkg/package.json": JSON.stringify({ name: "pkg", main: "does-not-exist.js" }),
      "pkg/index.js": "exports.which = 'index';",
    },
    entry: "main.js",
  },
  {
    id: "json-module",
    question: "does require on a .json file parse it and expose the data?",
    files: {
      "main.js": "const data = require('./data.json'); console.log('value=' + data.value + ' type=' + typeof data);",
      "data.json": JSON.stringify({ value: 41, nested: { ok: true } }),
    },
    entry: "main.js",
  },
  {
    id: "builtin-alias-identity",
    question: "is require('path') the same object as require('node:path')?",
    files: {
      "main.js": [
        "const plain = require('path');",
        "const prefixed = require('node:path');",
        "console.log('same=' + (plain === prefixed) + ' hasJoin=' + (typeof plain.join));",
      ].join("\n"),
    },
    entry: "main.js",
  },
  {
    id: "module-cache-identity",
    question: "does a second require return the same object, running the module once?",
    files: {
      "main.js": [
        "globalThis.runs = 0;",
        "const first = require('./counted');",
        "const second = require('./counted');",
        "console.log('same=' + (first === second) + ' runs=' + globalThis.runs);",
      ].join("\n"),
      "counted.js": "globalThis.runs += 1; module.exports = { runs: globalThis.runs };",
    },
    entry: "main.js",
  },
  {
    id: "circular-partial-exports",
    question: "does a circular require see the partially-filled exports Node exposes?",
    files: {
      "main.js": [
        "const a = require('./a');",
        "console.log('a=' + JSON.stringify(a) + ' b=' + JSON.stringify(require('./b')));",
      ].join("\n"),
      "a.js": [
        "exports.name = 'a';",
        "const b = require('./b');",
        "exports.sawB = b.name;",
      ].join("\n"),
      "b.js": [
        "exports.name = 'b';",
        "const a = require('./a');",
        "exports.sawA = typeof a.sawB;",
      ].join("\n"),
    },
    entry: "main.js",
  },
  {
    id: "nested-node-modules",
    question: "does a require from a subdirectory find a dependency in an ancestor node_modules?",
    files: {
      "main.js": "console.log('dep=' + require('./sub/user').dep);",
      "sub/user.js": "exports.dep = require('dep').value;",
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
      "node_modules/dep/index.js": "exports.value = 'found';",
    },
    entry: "main.js",
  },
  {
    id: "missing-module-shape",
    question: "what name and code does a program see for a missing relative module?",
    files: {
      "main.js": [
        ERROR_FIELDS,
        "try { require('./absent'); } catch (error) { detail('missing', error); }",
      ].join("\n"),
    },
    entry: "main.js",
  },
  {
    id: "missing-directory-index-shape",
    question: "what error do you see for a directory with no index and no package main?",
    files: {
      "main.js": [
        ERROR_FIELDS,
        "try { require('./empty'); } catch (error) { detail('emptyDir', error); }",
      ].join("\n"),
      "empty/notes.txt": "not a module",
    },
    entry: "main.js",
  },
  {
    id: "missing-json-shape",
    question: "what error do you see for a .json file that exists but does not parse?",
    files: {
      "main.js": [
        ERROR_FIELDS,
        "try { require('./broken.json'); } catch (error) { detail('brokenJson', error); }",
      ].join("\n"),
      "broken.json": "{ not json",
    },
    entry: "main.js",
  },
  {
    id: "throw-in-module-shape",
    question: "what error does a caller catch when a required module throws while loading?",
    files: {
      "main.js": [
        ERROR_FIELDS,
        "try { require('./explodes'); } catch (error) { detail('throwing', error); }",
      ].join("\n"),
      "explodes.js": "throw new TypeError('boom while loading');",
    },
    entry: "main.js",
  },
  {
    id: "tla-entry-settles",
    question: "does an entry module that awaits finish before the process is judged?",
    files: {
      "main.mjs": "console.log('before');\nawait Promise.resolve();\nconsole.log('after');",
    },
    entry: "main.mjs",
  },
  {
    id: "tla-export-through-import",
    question: "does import() wait for a module whose exports are only set after an await?",
    files: {
      "main.mjs": "import('./late.mjs').then((m) => console.log('value=' + m.value));",
      "late.mjs": "await Promise.resolve();\nexport const value = 'set-after-await';",
    },
    entry: "main.mjs",
  },
  {
    id: "require-async-module-shape",
    question: "what name and code does require() of a top-level-await module produce?",
    files: {
      "main.cjs": [
        ERROR_FIELDS,
        "try { require('./late.mjs'); } catch (error) { detail('tla', error); }",
      ].join("\n"),
      "late.mjs": "await Promise.resolve();\nexport const value = 'set';",
    },
    entry: "main.cjs",
  },
  {
    id: "require-main-fields",
    question: "does require.main, module.filename and module.id agree with themselves?",
    files: {
      "main.js": [
        "const child = require('./child');",
        "console.log('mainIsSelf=' + (require.main === module) + ' childSawMain=' + child.sawMain);",
      ].join("\n"),
      "child.js": "exports.sawMain = String(require.main === module);",
    },
    entry: "main.js",
  },
];
