import { describe, expect, it } from "vitest";

import { AssertionError, deepEqual, strictEqual, throws } from "../../src/shims/assert.js";
import { inherits, inspect, isDeepStrictEqual, promisify, format } from "../../src/shims/util.js";
import { parse as parseQuery, stringify as stringifyQuery } from "../../src/shims/querystring.js";
import { StringDecoder } from "../../src/shims/string-decoder.js";
import { parse as parseUrl, format as formatUrl, fileURLToPath, pathToFileURL } from "../../src/shims/url.js";
import { isIP, isIPv4, isIPv6 } from "../../src/shims/net.js";
import { createServer as createHttpsServer } from "../../src/shims/https.js";
import { AsyncLocalStorage } from "../../src/shims/async-hooks.js";

describe("util", () => {
  it("formats with the placeholders loggers actually use", () => {
    expect(format("%s has %d items", "cart", 3)).toBe("cart has 3 items");
    expect(format("%j", { a: 1 })).toBe('{"a":1}');
    expect(format("100%%")).toBe("100%");
    expect(format("no placeholders", "extra")).toBe("no placeholders extra");
    expect(format({ a: 1 })).toBe("{ a: 1 }");
  });

  it("inspects without invoking getters, because printing a value must not change it", () => {
    let read = false;
    const value = {
      get hidden() {
        read = true;
        return 1;
      },
      plain: "text",
    };
    expect(inspect(value)).toContain("plain: 'text'");
    expect(read).toBe(false);
  });

  it("marks cycles instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(inspect(cyclic)).toContain("[Circular *1]");
  });

  it("inherits through the prototype chain, which is the whole contract", () => {
    class Base {
      greet(): string {
        return "hi";
      }
    }
    class Derived {}
    inherits(Derived, Base);
    // The prototype chain is runtime data: `inherits` cannot express it in the type system, which is why Node's own types need a cast.
    expect((new Derived() as unknown as Base).greet()).toBe("hi");
  });

  it("promisifies an error-first callback", async () => {
    const fn = (value: string, callback: (error: Error | null, result?: string) => void): void => callback(null, value.toUpperCase());
    const promisified = promisify(fn) as unknown as (value: string) => Promise<string>;
    await expect(promisified("ok")).resolves.toBe("OK");
    const failing = (_value: string, callback: (error: Error | null) => void): void => callback(new Error("boom"));
    const failingPromisified = promisify(failing) as unknown as (value: string) => Promise<void>;
    await expect(failingPromisified("x")).rejects.toThrow("boom");
  });

  it("deep-compares by structure and prototype", () => {
    expect(isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(isDeepStrictEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(isDeepStrictEqual(new Date(0), new Date(0))).toBe(true);
  });
});

describe("querystring", () => {
  it("parses repeats into an array and keeps a null prototype", () => {
    const parsed = parseQuery("a=1&b=2&b=3");
    expect(parsed["a"]).toBe("1");
    expect(parsed["b"]).toEqual(["2", "3"]);
    // `toString` must not come from Object.prototype: code that does `key in result` relies on it.
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("decodes plus as space and survives a malformed escape", () => {
    expect(parseQuery("q=hello+world")["q"]).toBe("hello world");
    expect(parseQuery("q=%E0%A4%A")["q"]).toBe("%E0%A4%A");
  });

  it("round-trips through stringify", () => {
    expect(stringifyQuery({ a: "1", b: ["2", "3"] })).toBe("a=1&b=2&b=3");
  });
});

describe("url", () => {
  it("parses the relative request target a server actually holds", () => {
    const parsed = parseUrl("/a/b?x=1");
    expect(parsed.pathname).toBe("/a/b");
    expect(parsed.search).toBe("?x=1");
    expect(parsed.path).toBe("/a/b?x=1");
    expect(parsed.host).toBeNull();
    expect(parsed.href).toBe("/a/b?x=1");
  });

  it("parses an absolute URL with authority, and formats it back", () => {
    const parsed = parseUrl("http://user:pw@example.com:8080/p?q=2#frag");
    expect(parsed.protocol).toBe("http:");
    expect(parsed.hostname).toBe("example.com");
    expect(parsed.port).toBe("8080");
    expect(parsed.auth).toBe("user:pw");
    expect(formatUrl(parsed)).toBe("http://user:pw@example.com:8080/p?q=2#frag");
  });

  it("converts between a file URL and a path", () => {
    expect(fileURLToPath("file:///tmp/a%20b.txt")).toBe("/tmp/a b.txt");
    expect(pathToFileURL("/tmp/a b.txt").href).toBe("file:///tmp/a%20b.txt");
  });
});

describe("string_decoder", () => {
  it("keeps a multi-byte character split across two chunks intact", () => {
    const bytes = new TextEncoder().encode("héllo");
    const decoder = new StringDecoder("utf8");
    // Split inside the two-byte 'é': the whole point of the module.
    const first = decoder.write(bytes.subarray(0, 2));
    const second = decoder.write(bytes.subarray(2)) + decoder.end();
    expect(first + second).toBe("héllo");
  });
});

describe("assert", () => {
  it("throws an AssertionError carrying the operator, which frameworks read", () => {
    try {
      strictEqual(1, 2, "numbers differ");
      throw new Error("expected strictEqual to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AssertionError);
      expect((error as AssertionError).operator).toBe("strictEqual");
      expect((error as AssertionError).message).toBe("numbers differ");
    }
  });

  it("compares deeply and catches the difference", () => {
    expect(() => deepEqual({ a: 1 }, { a: 1 })).not.toThrow();
    expect(() => deepEqual({ a: 1 }, { a: 2 })).toThrow(AssertionError);
  });

  it("asserts that a function throws, by constructor and by message", () => {
    expect(throws(() => {
      throw new TypeError("bad");
    }, TypeError).message).toBe("bad");
    expect(throws(() => {
      throw new Error("nope");
    }, /nope/).message).toBe("nope");
    expect(() => throws(() => undefined)).toThrow(/Missing expected exception/);
  });
});

describe("net and https refuse what a browser cannot do, by name", () => {
  it("answers the IP questions properly, because packages branch on them", () => {
    expect(isIP("127.0.0.1")).toBe(4);
    expect(isIP("::1")).toBe(6);
    expect(isIP("::ffff:127.0.0.1")).toBe(6);
    expect(isIP("not-an-ip")).toBe(0);
    expect(isIPv4("256.1.1.1")).toBe(false);
    expect(isIPv6("1:2:3:4:5:6:7:8")).toBe(true);
    expect(isIPv6("1:2:3")).toBe(false);
  });

  it("refuses TLS rather than quietly serving plaintext", () => {
    expect(() => createHttpsServer()).toThrow(/ERR_NOT_SUPPORTED/);
    expect(() => createHttpsServer()).toThrow(/downgrade/);
  });
});

describe("async_hooks", () => {
  it("keeps a store for the duration of run and restores what was there before", async () => {
    const storage = new AsyncLocalStorage<string>();
    expect(storage.getStore()).toBeUndefined();
    await storage.run("abc", async () => {
      expect(storage.getStore()).toBe("abc");
      await Promise.resolve();
      expect(storage.getStore()).toBe("abc");
    });
    expect(storage.getStore()).toBeUndefined();
  });
});

describe("promisify's own argument check", () => {
  it("refuses a non-function with Node's code and message instead of crashing on a symbol read", () => {
    // The failure this replaces: a builtin member this runtime does not implement arrives as `undefined`, and promisify read
    // `Symbol(nodejs.util.promisify.custom)` off it, so the report was "Cannot read properties of undefined" from a line naming neither the
    // missing function nor the argument. Node's own answer is a typed refusal, and `Received undefined` is its exact text for this case.
    let caught: unknown;
    try {
      promisify(undefined as unknown as () => void);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
      message: 'The "original" argument must be of type function. Received undefined',
    });
  });
});
