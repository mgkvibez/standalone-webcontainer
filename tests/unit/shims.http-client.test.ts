/**
 * The HTTP client boundary (ADR-0025): refused by name, with the validators implemented.
 *
 * The audit's complaint was that `http.get` was ABSENT, which in a program reads as `http.get is not a function` and looks like a broken
 * runtime rather than a boundary. So the first test here is not about behaviour, it is about the MESSAGE: a caller who hits this has to be told
 * why, what to use instead, and where the decision is written down. The last test proves the same thing from user code, through the loader and
 * the facade, because that is the path a dependency actually takes.
 */

import { describe, expect, it } from "vitest";

import * as http from "../../src/shims/http.js";
import {
  Agent,
  ClientRequest,
  get,
  maxHeaderSize,
  request,
  validateHeaderName,
  validateHeaderValue,
} from "../../src/shims/http.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";

interface Coded {
  readonly code?: string;
  readonly message: string;
}

function thrown(run: () => unknown): Coded {
  try {
    run();
  } catch (error) {
    return error as Coded;
  }
  throw new Error("expected a throw, got a return value");
}

describe("the HTTP client is refused by name", () => {
  it("refuses request and get with a code, a reason and the alternative", () => {
    for (const member of [request, get]) {
      const error = thrown(() => member("http://example.com"));
      expect(error.code).toBe("ERR_NOT_SUPPORTED");
      // The three facts a caller needs, each of which the silent version omitted.
      expect(error.message).toContain("no sockets");
      expect(error.message).toContain("fetch");
      expect(error.message).toContain("ADR-0025");
    }
  });

  it("refuses Agent, so keepAlive cannot appear to have been configured", () => {
    const error = thrown(() => new Agent({ keepAlive: true }));
    expect(error.code).toBe("ERR_NOT_SUPPORTED");
    expect(error.message).toContain("Agent");
  });

  it("refuses ClientRequest, which needs a socket to carry it", () => {
    const error = thrown(() => new ClientRequest());
    expect(error.code).toBe("ERR_NOT_SUPPORTED");
    expect(error.message).toContain("ClientRequest");
  });

  it("keeps the server half untouched: the refusal is the client's, not the module's", () => {
    expect(typeof http.createServer).toBe("function");
    expect(http.METHODS).toContain("GET");
    expect(http.STATUS_CODES[200]).toBe("OK");
  });
});

describe("http's header validators are real implementations", () => {
  it("accepts an RFC 7230 token", () => {
    expect(() => validateHeaderName("x-trace-id")).not.toThrow();
    expect(() => validateHeaderName("Accept")).not.toThrow();
    expect(() => validateHeaderValue("x-trace-id", "abc")).not.toThrow();
    expect(() => validateHeaderValue("x-trace-id", 42)).not.toThrow();
  });

  it("refuses a name that is not a token, with Node's code", () => {
    for (const name of ["bad name", "bad:name", "", "quote\"d", "new\nline"]) {
      const error = thrown(() => validateHeaderName(name));
      expect(error.code).toBe("ERR_INVALID_HTTP_TOKEN");
    }
  });

  it("refuses an undefined value and a value that would split the header", () => {
    expect(thrown(() => validateHeaderValue("x", undefined)).code).toBe("ERR_HTTP_INVALID_HEADER_VALUE");
    // Header injection: the case that makes the validator worth having at all.
    expect(thrown(() => validateHeaderValue("x", "a\nb")).code).toBe("ERR_INVALID_CHAR");
    expect(thrown(() => validateHeaderValue("x", "a\rb")).code).toBe("ERR_INVALID_CHAR");
    expect(thrown(() => validateHeaderValue("x", "a\u0000b")).code).toBe("ERR_INVALID_CHAR");
  });

  it("reports Node's maximum header size as a real number", () => {
    expect(maxHeaderSize).toBe(16384);
  });
});

describe("user code reaching for the client", () => {
  it("gets the named refusal through the loader and the facade, not a missing-function TypeError", async () => {
    const vfs = new FileSystem();
    vfs.writeFileSync(
      "/probe.js",
      [
        'const http = require("http");',
        "const shape = typeof http.get + '/' + typeof http.request + '/' + typeof http.validateHeaderName;",
        "let code = 'none';",
        "try { http.get('http://example.com'); } catch (error) { code = error.code; }",
        "console.log(shape, code, http.maxHeaderSize);",
      ].join("\n"),
    );
    const result = await new InProcessRuntime(vfs).run("/probe.js", { timeoutMs: 10000 });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("function/function/function ERR_NOT_SUPPORTED 16384");
  });
});
