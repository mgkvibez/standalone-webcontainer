/**
 * The preview gateway: routing, rewriting, and the deadline that turns a hung handler into a 504.
 *
 * The timeout tests use a short real timeout rather than a fake clock because the timer and the registry
 * have to agree; testing only the registry would leave the timer unverified, which is the half that can
 * silently stop firing.
 */

import { describe, expect, it } from "vitest";

import { PreviewGateway } from "../../src/network/preview-gateway.js";
import { PortRegistry } from "../../src/network/port-registry.js";
import { Server, type WireRequest } from "../../src/shims/http.js";

const decoder = new TextDecoder();

function request(url: string, overrides: Partial<WireRequest> = {}): WireRequest {
  return { method: "GET", url, headers: {}, body: new Uint8Array(), ...overrides };
}

function setup(options: { timeoutMs?: number; mountPath?: string } = {}): {
  ports: PortRegistry;
  gateway: PreviewGateway;
} {
  const ports = new PortRegistry();
  const gateway = new PreviewGateway({ registry: ports, ...options });
  return { ports, gateway };
}

describe("PreviewGateway.resolve", () => {
  const { gateway } = setup();

  it("parses a port and keeps the rest of the path", () => {
    expect(gateway.resolve("/preview/3000/foo?x=1")).toEqual({
      protocol: "http",
      port: 3000,
      path: "/foo?x=1",
    });
  });

  it("treats a bare port as the root path", () => {
    expect(gateway.resolve("/preview/3000")).toEqual({ protocol: "http", port: 3000, path: "/" });
  });

  it("returns null for anything that is not a preview URL", () => {
    for (const url of ["/", "/api/thing", "/preview/", "/preview/abc/x", "/previews/3000/"]) {
      expect(gateway.resolve(url), url).toBeNull();
    }
  });

  it("rejects port numbers outside the valid range", () => {
    expect(gateway.resolve("/preview/0/")).toBeNull();
    expect(gateway.resolve("/preview/65536/")).toBeNull();
    expect(gateway.resolve("/preview/99999999999999999999/")).toBeNull();
  });

  it("honours a custom mount path", () => {
    const custom = setup({ mountPath: "/runtime" }).gateway;
    expect(custom.resolve("/runtime/3000/a")).toEqual({ protocol: "http", port: 3000, path: "/a" });
  });
});

describe("PreviewGateway.handle", () => {
  it("routes to the server bound on that port and rewrites the path", async () => {
    const { ports, gateway } = setup();
    const server = gateway.createServer((req, response) => {
      response.end(`saw:${req.url}`);
    });
    server.listen(3000);

    const response = await gateway.handle(request("/preview/3000/products?page=2"));
    expect(response.statusCode).toBe(200);
    // The prefix must be gone: a handler expects the path its own app would request.
    expect(decoder.decode(response.body)).toBe("saw:/products?page=2");
    expect(ports.has("http", 3000)).toBe(true);
  });

  it("sends each request to its own server when several are listening", async () => {
    const { gateway } = setup();
    const first = gateway.createServer((_req, res) => res.end("first"));
    const second = gateway.createServer((_req, res) => res.end("second"));
    first.listen(3000);
    second.listen(4000);

    expect(decoder.decode((await gateway.handle(request("/preview/3000/"))).body)).toBe("first");
    expect(decoder.decode((await gateway.handle(request("/preview/4000/"))).body)).toBe("second");
  });

  it("names the port when nothing is listening, instead of a bare 404", async () => {
    const { gateway } = setup();
    const response = await gateway.handle(request("/preview/5050/"));
    expect(response.statusCode).toBe(404);
    expect(decoder.decode(response.body)).toContain("5050");
    expect(decoder.decode(response.body)).toContain("listen(5050)");
  });

  it("stops routing to a server once it closes", async () => {
    const { gateway } = setup();
    const server = gateway.createServer((_req, res) => res.end("here"));
    server.listen(3000);
    expect((await gateway.handle(request("/preview/3000/"))).statusCode).toBe(200);

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await closed;
    expect((await gateway.handle(request("/preview/3000/"))).statusCode).toBe(404);
  });

  it("passes the method, headers and body through to the handler", async () => {
    const { gateway } = setup();
    const server = gateway.createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(String(chunk)));
      req.on("end", () => {
        res.end(`${req.method}:${req.headers["x-test"] ?? "none"}:${chunks.join("")}`);
      });
    });
    server.listen(3000);

    const response = await gateway.handle(
      request("/preview/3000/submit", {
        method: "POST",
        headers: { "x-test": "yes" },
        body: new TextEncoder().encode("hello"),
      }),
    );
    expect(decoder.decode(response.body)).toBe("POST:yes:hello");
  });

  it("answers 504 when a handler never ends, and stops counting it as in flight", async () => {
    const { gateway } = setup({ timeoutMs: 25 });
    const server = gateway.createServer(() => {
      // Deliberately never responds: this is the failure both reference implementations exhibit.
    });
    server.listen(3000);

    const response = await gateway.handle(request("/preview/3000/hang"));
    expect(response.statusCode).toBe(504);
    expect(decoder.decode(response.body)).toContain("25ms");
    expect(gateway.inFlight).toBe(0);
  });

  it("does not time out a handler that answers in time", async () => {
    const { gateway } = setup({ timeoutMs: 200 });
    const server = gateway.createServer((_req, res) => {
      setTimeout(() => res.end("slow but fine"), 5);
    });
    server.listen(3000);

    const response = await gateway.handle(request("/preview/3000/"));
    expect(response.statusCode).toBe(200);
    expect(decoder.decode(response.body)).toBe("slow but fine");
  });

  it("reports a non-preview URL as a 404 rather than guessing", async () => {
    const { gateway } = setup();
    const response = await gateway.handle(request("/assets/logo.png"));
    expect(response.statusCode).toBe(404);
    expect(decoder.decode(response.body)).toContain("Not a preview request");
  });

  it("fails every outstanding request on teardown", async () => {
    const { gateway } = setup({ timeoutMs: 5_000 });
    const server = gateway.createServer(() => undefined);
    server.listen(3000);

    const pending = gateway.handle(request("/preview/3000/hang"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gateway.inFlight).toBe(1);
    expect(gateway.closeAll()).toHaveLength(1);
    const response = await pending;
    expect(response.statusCode).toBe(500);
  });

  it("detaching stops the gateway from routing to that server", async () => {
    const { ports, gateway } = setup();
    const server = new Server((_req, res) => res.end("ok"), { registry: ports });
    const detach = gateway.attach(server);
    server.listen(3000);
    expect((await gateway.handle(request("/preview/3000/"))).statusCode).toBe(200);

    detach();
    expect((await gateway.handle(request("/preview/3000/"))).statusCode).toBe(404);
  });
});
