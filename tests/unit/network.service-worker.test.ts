/**
 * The fetch handler against real `Request` and `Response` objects.
 *
 * These use the platform's own web types rather than hand-built stand-ins, because the bugs this file can
 * have are precisely about those types: a `Response` constructed with a body it is not allowed to have, a
 * `content-length` that disagrees with the body, headers the constructor refuses.
 */

import { describe, expect, it, vi } from "vitest";

import { createPreviewFetchHandler } from "../../src/network/service-worker.js";
import { PreviewGateway } from "../../src/network/preview-gateway.js";
import { PortRegistry } from "../../src/network/port-registry.js";

const decoder = new TextDecoder();

function setup(options: { timeoutMs?: number; passthrough?: (request: Request) => Promise<Response> } = {}): {
  gateway: PreviewGateway;
  handle: (request: Request) => Promise<Response>;
} {
  const gateway = new PreviewGateway({ registry: new PortRegistry(), timeoutMs: options.timeoutMs ?? 5_000 });
  const handle = createPreviewFetchHandler({ gateway, passthrough: options.passthrough ?? (async () => new Response("passthrough")) });
  return { gateway, handle };
}

describe("createPreviewFetchHandler", () => {
  it("answers a preview request through the gateway", async () => {
    const { gateway, handle } = setup();
    const server = gateway.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    });
    server.listen(3000);

    const response = await handle(new Request("http://localhost:5173/preview/3000/api/items?page=2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(decoder.decode(await response.arrayBuffer()))).toEqual({ path: "/api/items?page=2" });
  });

  it("preserves the handler's status code", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((_req, res) => {
      res.statusCode = 418;
      res.end("teapot");
    }).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/"));
    expect(response.status).toBe(418);
  });

  it("sends non-preview requests to the passthrough", async () => {
    const seen: string[] = [];
    const { handle } = setup({
      passthrough: async (request) => {
        seen.push(request.url);
        return new Response("app-asset");
      },
    });

    const response = await handle(new Request("http://localhost/assets/app.js"));
    expect(decoder.decode(await response.arrayBuffer())).toBe("app-asset");
    expect(seen).toEqual(["http://localhost/assets/app.js"]);
  });

  it("falls back to the global fetch when no passthrough is given", async () => {
    const gateway = new PreviewGateway({ registry: new PortRegistry() });
    const stub = vi.fn(async () => new Response("from-network"));
    vi.stubGlobal("fetch", stub);
    try {
      const handle = createPreviewFetchHandler({ gateway });
      const response = await handle(new Request("http://localhost/api/thing"));
      expect(stub).toHaveBeenCalledTimes(1);
      expect(decoder.decode(await response.arrayBuffer())).toBe("from-network");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards the request method, headers and body", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(String(chunk)));
      req.on("end", () => res.end(`${req.method}|${req.headers["x-token"] ?? ""}|${chunks.join("")}`));
    }).listen(3000);

    const response = await handle(
      new Request("http://localhost/preview/3000/submit", {
        method: "POST",
        headers: { "x-token": "abc" },
        body: "payload",
      }),
    );
    expect(decoder.decode(await response.arrayBuffer())).toBe("POST|abc|payload");
  });

  it("carries binary responses through unchanged", async () => {
    const { gateway, handle } = setup();
    const bytes = new Uint8Array([0, 1, 254, 255, 13, 10]);
    gateway.createServer((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.end(bytes);
    }).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/blob"));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 254, 255, 13, 10]);
  });

  it("strips a handler's content-length so the platform computes the real one", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((_req, res) => {
      res.setHeader("content-length", "9999");
      res.end("four");
    }).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/"));
    expect(response.headers.get("content-length")).not.toBe("9999");
    expect(decoder.decode(await response.arrayBuffer())).toBe("four");
  });

  it("returns no body for HEAD even though the handler wrote one", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("body-that-head-must-not-have");
    }).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/", { method: "HEAD" }));
    expect(response.status).toBe(200);
    // Constructing a Response with a body for HEAD throws, which is why this is handled rather than ignored.
    expect(await response.text()).toBe("");
  });

  it("returns no body for 204", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    }).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/"));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("answers 404 for a port with no server, and names it", async () => {
    const { handle } = setup();
    const response = await handle(new Request("http://localhost/preview/4001/"));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("4001");
  });

  it("answers 504 rather than hanging when the handler never ends", async () => {
    const { gateway, handle } = setup({ timeoutMs: 20 });
    gateway.createServer(() => undefined).listen(3000);

    const response = await handle(new Request("http://localhost/preview/3000/hang"));
    expect(response.status).toBe(504);
  });

  it("keeps concurrent requests apart", async () => {
    const { gateway, handle } = setup();
    gateway.createServer((req, res) => {
      // Answer out of order to prove correlation does not depend on arrival order.
      const delay = req.url?.includes("slow") === true ? 20 : 1;
      setTimeout(() => res.end(`answered:${req.url ?? ""}`), delay);
    }).listen(3000);

    const [slow, fast] = await Promise.all([
      handle(new Request("http://localhost/preview/3000/slow")),
      handle(new Request("http://localhost/preview/3000/fast")),
    ]);
    expect(decoder.decode(await slow.arrayBuffer())).toBe("answered:/slow");
    expect(decoder.decode(await fast.arrayBuffer())).toBe("answered:/fast");
  });

  it("answers 500 with a reason when the request body cannot be read", async () => {
    const { handle } = setup();
    // A body that errors mid-read, which is what an aborted upload looks like.
    const broken = {
      method: "POST",
      url: "http://localhost/preview/3000/upload",
      headers: new Headers(),
      arrayBuffer: () => Promise.reject(new Error("stream aborted")),
    } as unknown as Request;

    const response = await handle(broken);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("stream aborted");
  });

  it("answers 400 for a request whose URL cannot be parsed", async () => {
    const { handle } = setup();
    const broken = {
      method: "GET",
      url: "not a url",
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Request;

    const response = await handle(broken);
    expect(response.status).toBe(400);
  });
});
