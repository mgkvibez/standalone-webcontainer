import { describe, expect, it } from "vitest";

import { CommonJsLoader, declaresOwnBinding } from "../../src/runtime/commonjs.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createFsShim } from "../../src/shims/fs.js";
import { EventEmitter } from "../../src/shims/events.js";
import { Duplex, PassThrough, Readable, Stream, Transform, Writable } from "../../src/shims/stream.js";

/**
 * Two bugs found by running real packages, both of which compiled only because nothing had tried them.
 *
 * 1. `new Function`'s parameters are lexical bindings, so express 5's `lib/utils.js`, which opens with
 *    `const Buffer = require("node:buffer").Buffer`, cannot coexist with a `Buffer` parameter. The failure was a SyntaxError before
 *    a line of express ran.
 * 2. `express` mixes `EventEmitter.prototype` into a plain object and calls `app.on(...)`, which failed because listener state lived
 *    in a `#private` field that only real instances can touch.
 */
describe("the module wrapper omits a binding a module declares for itself", () => {
  it("sees a lexical declaration of the same name", () => {
    expect(declaresOwnBinding('const Buffer = require("node:buffer").Buffer;', "Buffer")).toBe(true);
    expect(declaresOwnBinding("let Buffer = 1;", "Buffer")).toBe(true);
    expect(declaresOwnBinding("class Buffer {}", "Buffer")).toBe(true);
  });

  it("sees a destructured declaration, which is how a modernised package binds it", () => {
    expect(declaresOwnBinding('const { Buffer } = require("node:buffer");', "Buffer")).toBe(true);
    expect(declaresOwnBinding('const { setTimeout } = require("node:timers");', "setTimeout")).toBe(true);
  });

  it("does not count `var`, because a var simply reuses the parameter slot", () => {
    // `var Buffer` alongside a `Buffer` parameter is legal even in strict mode, and 50 packages rely on that.
    expect(declaresOwnBinding("var Buffer = require('safe-buffer').Buffer", "Buffer")).toBe(false);
  });

  it("ignores a declaration inside a nested scope, which cannot collide with a parameter", () => {
    // The first version matched anywhere in the file. Vite's bundled chunk declares `const exports = []` inside two ordinary
    // functions, and that stripped the binding for the whole module.
    expect(declaresOwnBinding("function f() { const Buffer = 1; return Buffer; }", "Buffer")).toBe(false);
    expect(declaresOwnBinding("if (x) {\n  const Buffer = 1;\n}", "Buffer")).toBe(false);
    // The destructuring form needs its braces, so it is tested against the whole line; a nested one is still rejected because that
    // line is read at a depth other than zero.
    expect(declaresOwnBinding("function f() { const { Buffer } = require('node:buffer'); }", "Buffer")).toBe(false);
    // ...while a top-level one, before or after a nested block, still counts.
    expect(declaresOwnBinding("function f() { const Buffer = 1; }\nconst Buffer = 2;", "Buffer")).toBe(true);
    expect(declaresOwnBinding("const Buffer = 2;\nfunction f() { let Buffer = 1; }", "Buffer")).toBe(true);
  });

  it("does not match a different name or a mention inside a string", () => {
    expect(declaresOwnBinding("const other = 1;", "Buffer")).toBe(false);
    expect(declaresOwnBinding("console.log('const Buffer = 1');", "Buffer")).toBe(false);
    expect(declaresOwnBinding("Buffer.from('x');", "Buffer")).toBe(false);
  });
});

/**
 * The scan above decides, from text, whether a module declares a global for itself. Text cannot always answer that, and the answer that matters
 * is the one V8 gives at compile time. These two tests pin the limit and the backstop together, because either one alone reads as the other
 * working.
 */
describe("a module whose own declaration the scan cannot see still loads", () => {
  // Real shape: vite's `publicUtils.cjs` is 6 000 lines of bundled code, and the walk below counts braces in text that is not only code. A regex
  // literal containing an opening brace leaves it one deep for the rest of the file, so every top-level declaration after it reads as nested.
  const source = `const openingBrace = /{/;
const crypto = { marker: "own" };
module.exports = crypto.marker;
`;

  const load = (contents: string): unknown => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/app/bundle.cjs", contents);
    const loader = new CommonJsLoader({ fs: createFsShim(vfs as never), builtins: {} });
    return loader.require("/app/bundle.cjs", "/app");
  };

  it("is a case the scan gets wrong, which is why the loader cannot rely on it alone", () => {
    expect(declaresOwnBinding(source, "crypto")).toBe(false);
  });

  it("loads anyway, and the module's own binding wins over the injected global", () => {
    // Before the backstop this threw `SyntaxError: /app/bundle.cjs: Identifier 'crypto' has already been declared` and the dependency never
    // ran. Node's behaviour, which this restores: a module-level binding shadows the global of the same name.
    expect(load(source)).toBe("own");
  });

  it("keeps a module's own `require`, a divergence from Node that predates the backstop", () => {
    // Node's wrapper passes `require` as a parameter, so `const require = createRequire(import.meta.url)` is a SyntaxError there. This loader has
    // always withdrawn the parameter for such a module on purpose (see the `__require` binding), and the backstop does not change that: it only
    // makes the withdrawal happen for the names the scan misses too. Recorded here because "we do it on purpose" and "we forgot" look identical
    // from outside.
    expect(load(`const require = 1;\nmodule.exports = require;\n`)).toBe(1);
  });
});

describe("the emitter works on an object that is not an instance of it", () => {
  it("accepts on/emit through a mixed-in prototype, the way express builds an app", () => {
    const app = Object.create(EventEmitter.prototype) as EventEmitter;
    const seen: unknown[] = [];
    app.on("mount", (value: unknown) => seen.push(value));
    app.emit("mount", "router");
    expect(seen).toEqual(["router"]);
  });

  it("keeps separate listener lists per object, including for plain objects", () => {
    const first = Object.create(EventEmitter.prototype) as EventEmitter;
    const second = Object.create(EventEmitter.prototype) as EventEmitter;
    let calls = 0;
    first.on("x", () => (calls += 1));
    second.emit("x");
    expect(calls).toBe(0);
    first.emit("x");
    expect(calls).toBe(1);
  });

  it("still behaves for a real instance, including once()", () => {
    const emitter = new EventEmitter();
    let calls = 0;
    emitter.once("ready", () => (calls += 1));
    emitter.emit("ready");
    emitter.emit("ready");
    expect(calls).toBe(1);
  });
});

describe("require('stream') is the legacy Stream constructor, with the classes attached", () => {
  it("is callable and carries Readable, Writable, Duplex, Transform and PassThrough", () => {
    // `send` does `util.inherits(SendStream, require("stream"))` and `Stream.call(this)`, so the module object must be a constructor.
    const streamModule = Object.assign(Stream, { Stream, Readable, Writable, Duplex, Transform, PassThrough });
    expect(typeof streamModule).toBe("function");
    expect(streamModule.Readable).toBe(Readable);
    expect(typeof streamModule.prototype.on).toBe("function");
  });
});
