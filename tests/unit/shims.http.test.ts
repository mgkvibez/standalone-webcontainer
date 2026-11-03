/**
 * `http` shim: servers, requests, responses.
 *
 * Written against the behaviours applications rely on, including the ones that only matter on the unhappy
 * path: a handler that throws, a write after end, a second server on a taken port.
 */

import { describe, expect, it, vi } from "vitest";

import { createServer, Server, type WireRequest } from "../../src/shims/http.js";
import { PortRegistry } from "../../src/network/port-registry.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function request(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    method: "GET",
    url: "/",
    headers: { host: "localhost" },
    body: new Uint8Array(),
    ...overrides,
  };
}

function registry(): PortRegistry {
  return new PortRegistry();
}

describe("http.createServer", () => {
  it("answers a request and computes content-length", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("hello");
    });

    const response = await server.dispatch(request());
    expect(response.statusCode).toBe(200);
    expect(decoder.decode(response.body)).toBe("hello");
    expect(response.headers["content-length"]).toBe("5");
    expect(response.headers["content-type"]).toBe("text/plain");
  });

  it("does not let a handler override content-length with a wrong value", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-length", "999");
      response.end("ten bytes!");
    });
    const response = await server.dispatch(request());
    // A trusted content-length that disagrees with the body truncates the response in a real browser.
    expect(response.headers["content-length"]).toBe("10");
  });

  it("keeps binary bodies as bytes", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13]);
    const server = createServer((_request, response) => {
      response.end(bytes);
    });
    const response = await server.dispatch(request());
    expect([...response.body]).toEqual([0, 255, 128, 10, 13]);
  });

  it("delivers the request body through data and end, decoded when setEncoding is used", async () => {
    const seen: string[] = [];
    const server = createServer((req, response) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => seen.push(String(chunk)));
      req.on("end", () => {
        seen.push("end");
        response.end("ok");
      });
    });

    await server.dispatch(request({ method: "POST", body: encoder.encode("payload") }));
    expect(seen).toEqual(["payload", "end"]);
  });

  it("delivers raw bytes when no encoding was chosen", async () => {
    let received: Uint8Array | null = null;
    const server = createServer((req, response) => {
      req.on("data", (chunk) => {
        received = chunk as Uint8Array;
      });
      req.on("end", () => response.end());
    });
    await server.dispatch(request({ method: "POST", body: new Uint8Array([1, 2, 3]) }));
    expect(received).toBeInstanceOf(Uint8Array);
    expect([...(received as unknown as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("emits end even for an empty body", async () => {
    let ended = false;
    const server = createServer((req, response) => {
      req.on("data", () => {
        throw new Error("no data expected");
      });
      req.on("end", () => {
        ended = true;
        response.end();
      });
    });
    await server.dispatch(request());
    expect(ended).toBe(true);
  });

  it("answers 404 when there is no request listener, rather than hanging", async () => {
    const response = await createServer().dispatch(request());
    expect(response.statusCode).toBe(404);
  });

  it("turns a throwing handler into a 500 instead of a rejected promise", async () => {
    const server = createServer(() => {
      throw new Error("handler exploded");
    });
    const response = await server.dispatch(request());
    expect(response.statusCode).toBe(500);
    expect(decoder.decode(response.body)).toBe("handler exploded");
  });

  it("turns a rejected async handler into a 500", async () => {
    const server = createServer(async () => {
      throw new Error("async failure");
    });
    const response = await server.dispatch(request());
    expect(response.statusCode).toBe(500);
    expect(decoder.decode(response.body)).toBe("async failure");
  });

  it("routes a handler failure to clientError when a listener exists", async () => {
    const server = createServer(() => {
      throw new Error("boom");
    });
    const seen: unknown[] = [];
    server.on("clientError", (cause) => seen.push(cause));
    await server.dispatch(request());
    expect(seen).toHaveLength(1);
  });

  it("supports writeHead with and without a status message", async () => {
    const server = createServer((req, response) => {
      if (req.url === "/message") response.writeHead(201, "Created", { "x-a": "1" });
      else response.writeHead(202, { "x-b": "2" });
      response.end("body");
    });
    const withMessage = await server.dispatch(request({ url: "/message" }));
    expect(withMessage.statusCode).toBe(201);
    expect(withMessage.statusMessage).toBe("Created");
    expect(withMessage.headers["x-a"]).toBe("1");

    const withoutMessage = await server.dispatch(request({ url: "/other" }));
    expect(withoutMessage.statusCode).toBe(202);
    expect(withoutMessage.headers["x-b"]).toBe("2");
  });

  it("accumulates multiple writes", async () => {
    const server = createServer((_request, response) => {
      response.write("one");
      response.write(encoder.encode("-two"));
      response.end("-three");
    });
    const response = await server.dispatch(request());
    expect(decoder.decode(response.body)).toBe("one-two-three");
  });

  it("refuses a write or header change after end", async () => {
    let writeError: unknown = null;
    let headerError: unknown = null;
    const server = createServer((_request, response) => {
      response.end("done");
      try {
        response.write("late");
      } catch (error) {
        writeError = error;
      }
      try {
        response.setHeader("x-late", "1");
      } catch (error) {
        headerError = error;
      }
    });
    await server.dispatch(request());
    expect(String(writeError)).toMatch(/WRITE_AFTER_END/);
    expect(String(headerError)).toMatch(/HEADERS_SENT/);
  });

  it("makes end idempotent", async () => {
    const server = createServer((_request, response) => {
      response.end("first");
      response.end("second");
    });
    const response = await server.dispatch(request());
    expect(decoder.decode(response.body)).toBe("first");
  });

  it("rejects a non-utf8 encoding rather than mis-encoding silently", async () => {
    let failure: unknown = null;
    const server = createServer((_request, response) => {
      try {
        response.write("x", "latin1");
      } catch (error) {
        failure = error;
      }
      response.end();
    });
    await server.dispatch(request());
    expect(String(failure)).toMatch(/only utf8/);
  });

  it("exposes header helpers", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("X-Thing", "value");
      const has = response.hasHeader("x-thing");
      response.removeHeader("x-thing");
      const afterRemoval = response.hasHeader("x-thing");
      response.end(has && !afterRemoval ? "helpers-ok" : "helpers-broken");
    });
    const response = await server.dispatch(request());
    expect(decoder.decode(response.body)).toBe("helpers-ok");
  });
});

describe("http.Server lifecycle", () => {
  it("registers its port in the registry and releases it on close", () => {
    const ports = registry();
    const server = new Server(undefined, { registry: ports });
    server.listen(3000);
    expect(ports.has("http", 3000)).toBe(true);
    server.close();
    expect(ports.has("http", 3000)).toBe(false);
  });

  it("refuses a second server on a taken port with EADDRINUSE", () => {
    const ports = registry();
    const first = new Server(undefined, { registry: ports });
    const second = new Server(undefined, { registry: ports });
    first.listen(3000);
    expect(() => second.listen(3000)).toThrow(/EADDRINUSE/);
  });

  it("reports address() only while listening", () => {
    const server = new Server(undefined, { registry: registry() });
    expect(server.address()).toBeNull();
    server.listen(3333);
    expect(server.address()).toEqual({ address: "0.0.0.0", family: "IPv4", port: 3333 });
    expect(server.listening).toBe(true);
    server.close();
    expect(server.address()).toBeNull();
    expect(server.listening).toBe(false);
  });

  it("emits listening asynchronously so a late subscriber still hears it", async () => {
    const server = new Server(undefined, { registry: registry() });
    const heard = new Promise<void>((resolve) => {
      server.listen(3001);
      server.once("listening", () => resolve());
    });
    await heard;
    server.close();
  });

  it("invokes the listen callback", async () => {
    const server = new Server(undefined, { registry: registry() });
    const callback = vi.fn();
    const done = new Promise<void>((resolve) => server.listen(3002, () => {
      callback();
      resolve();
    }));
    await done;
    expect(callback).toHaveBeenCalled();
    server.close();
  });

  it("tolerates close being called twice", () => {
    const ports = registry();
    const server = new Server(undefined, { registry: ports });
    server.listen(3003);
    server.close();
    expect(() => server.close()).not.toThrow();
  });

  it("lets a closed port be bound again", () => {
    const ports = registry();
    const first = new Server(undefined, { registry: ports });
    first.listen(3004);
    first.close();
    const second = new Server(undefined, { registry: ports });
    expect(() => second.listen(3004)).not.toThrow();
  });

  it("refuses listen(callback) with no port, and says why", () => {
    const server = new Server(undefined, { registry: registry() });
    expect(() => server.listen(() => undefined)).toThrow(/ephemeral port allocation/);
  });
});
