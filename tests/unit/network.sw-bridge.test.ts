/**
 * The worker/page bridge, tested through a fake bus that reorders messages on purpose.
 *
 * Every test here wires the two real halves together. Nothing is mocked except the transport, because the
 * transport is the part that cannot be tested in a unit test at all: in a browser it is `postMessage`
 * between two global scopes.
 */

import { describe, expect, it } from "vitest";

import {
  createPageSideResponder,
  createWorkerSideProxy,
  type PageMessage,
  type PreviewRequestMessage,
} from "../../src/network/sw-bridge.js";
import { PreviewGateway } from "../../src/network/preview-gateway.js";
import { PortRegistry } from "../../src/network/port-registry.js";

const decoder = new TextDecoder();

interface Bus {
  fromWorker: PreviewRequestMessage[];
  toWorker: PageMessage[];
  /** Deliver page messages in the given order, not arrival order. Resolves once the worker has them. */
  deliver(order?: "fifo" | "reverse"): Promise<void>;
}

function wire(options: {
  timeoutMs?: number;
  gateway?: PreviewGateway;
} = {}): {
  gateway: PreviewGateway;
  worker: ReturnType<typeof createWorkerSideProxy>;
  bus: Bus;
} {
  const gateway = options.gateway ?? new PreviewGateway({ registry: new PortRegistry() });
  const fromWorker: PreviewRequestMessage[] = [];
  const toWorker: PageMessage[] = [];

  const worker = createWorkerSideProxy({
    timeoutMs: options.timeoutMs ?? 1_000,
    send: (message) => fromWorker.push(message),
  });

  const responder = createPageSideResponder({
    gateway,
    reply: (message) => toWorker.push(message),
  });

  return {
    gateway,
    worker,
    bus: {
      fromWorker,
      toWorker,
      async deliver(order = "fifo") {
        const messages = order === "reverse" ? [...fromWorker].reverse() : [...fromWorker];
        fromWorker.length = 0;
        // Awaiting each accept is what makes this test honest: replies are only handed back once the page
        // side has actually finished, rather than after a hopeful microtask tick.
        await Promise.all(messages.map((message) => responder.accept(message)));
        for (const message of toWorker.splice(0)) worker.receive(message);
      },
    },
  };
}

describe("service worker bridge", () => {
  it("round-trips a request through the page and back", async () => {
    const { gateway, worker, bus } = wire();
    gateway.createServer((req, res) => res.end(`page-served:${req.url}`)).listen(3000);

    const answer = worker.handle({ method: "GET", url: "/preview/3000/hello", headers: {}, body: new Uint8Array() });
    await bus.deliver();
    const response = await answer;

    expect(response.statusCode).toBe(200);
    expect(decoder.decode(response.body)).toBe("page-served:/hello");
  });

  it("correlates concurrent requests even when replies arrive in reverse order", async () => {
    const { gateway, worker, bus } = wire({ timeoutMs: 500 });
    gateway.createServer((req, res) => {
      // The first request answers last, so a naive "next reply wins" bridge would cross them.
      const delay = req.url?.includes("first") === true ? 15 : 0;
      setTimeout(() => res.end(req.url ?? ""), delay);
    }).listen(3000);

    const first = worker.handle({ method: "GET", url: "/preview/3000/first", headers: {}, body: new Uint8Array() });
    const second = worker.handle({ method: "GET", url: "/preview/3000/second", headers: {}, body: new Uint8Array() });
    await bus.deliver("reverse");

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(decoder.decode(firstResponse.body)).toBe("/first");
    expect(decoder.decode(secondResponse.body)).toBe("/second");
  });

  it("preserves binary bodies across the boundary", async () => {
    const { gateway, worker, bus } = wire();
    gateway.createServer((_req, res) => res.end(new Uint8Array([0, 255, 7]))).listen(3000);

    const answer = worker.handle({ method: "GET", url: "/preview/3000/bin", headers: {}, body: new Uint8Array() });
    await bus.deliver();
    const response = await answer;
    expect([...response.body]).toEqual([0, 255, 7]);
  });

  it("passes a handler's status and headers back", async () => {
    const { gateway, worker, bus } = wire();
    gateway.createServer((_req, res) => {
      res.statusCode = 201;
      res.setHeader("x-made-by", "user-code");
      res.end("created");
    }).listen(3000);

    const answer = worker.handle({ method: "POST", url: "/preview/3000/items", headers: {}, body: new Uint8Array([1]) });
    await bus.deliver();
    const response = await answer;
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-made-by"]).toBe("user-code");
  });

  it("answers 504 when the page never replies, and stops counting the request", async () => {
    const { worker } = wire({ timeoutMs: 15 });
    const response = await worker.handle({
      method: "GET",
      url: "/preview/3000/nobody-home",
      headers: {},
      body: new Uint8Array(),
    });
    expect(response.statusCode).toBe(504);
    expect(decoder.decode(response.body)).toContain("15ms");
    expect(worker.pending).toBe(0);
  });

  it("ignores a reply that arrives after the deadline", async () => {
    const { gateway, worker, bus } = wire({ timeoutMs: 10 });
    gateway.createServer((_req, res) => setTimeout(() => res.end("too late"), 60)).listen(3000);

    const answer = worker.handle({ method: "GET", url: "/preview/3000/slow", headers: {}, body: new Uint8Array() });
    await bus.deliver();
    const response = await answer;
    expect(response.statusCode).toBe(504);

    // The late reply must not throw or resurrect a settled request.
    const late = bus.fromWorker[0];
    expect(late).toBeUndefined();
    expect(() =>
      worker.receive({ type: "preview-response", id: "preview-999", statusCode: 200, headers: {}, body: new Uint8Array() }),
    ).not.toThrow();
  });

  it("turns a page-side failure message into a 500 with the reason", async () => {
    const { worker, bus } = wire();
    const responder = createPageSideResponder({
      gateway: {
        handle: () => Promise.reject(new Error("gateway exploded")),
      } as unknown as PreviewGateway,
      reply: (message) => bus.toWorker.push(message),
    });

    const answer = worker.handle({ method: "GET", url: "/preview/3000/", headers: {}, body: new Uint8Array() });
    await responder.accept({
      type: "preview-request",
      id: bus.fromWorker[0]?.id ?? "preview-1",
      method: "GET",
      url: "/preview/3000/",
      headers: {},
      body: new Uint8Array(),
    });
    for (const message of bus.toWorker) worker.receive(message);

    const response = await answer;
    expect(response.statusCode).toBe(500);
    expect(decoder.decode(response.body)).toContain("gateway exploded");
  });

  it("ignores messages that are not for it", async () => {
    const { gateway } = wire();
    const responder = createPageSideResponder({ gateway, reply: () => undefined });
    // @ts-expect-error a foreign message type: the responder must shrug rather than crash the page.
    await expect(responder.accept({ type: "something-else" })).resolves.toBeUndefined();
  });

  it("fails every pending request on teardown", async () => {
    const { worker } = wire({ timeoutMs: 5_000 });
    const first = worker.handle({ method: "GET", url: "/preview/3000/a", headers: {}, body: new Uint8Array() });
    const second = worker.handle({ method: "GET", url: "/preview/3000/b", headers: {}, body: new Uint8Array() });

    expect(worker.pending).toBe(2);
    expect(worker.closeAll()).toHaveLength(2);
    const responses = await Promise.all([first, second]);
    for (const response of responses) expect(response.statusCode).toBe(500);
    expect(worker.pending).toBe(0);
  });

  it("reports 404 through the bridge when no server is listening", async () => {
    const { worker, bus } = wire();
    const answer = worker.handle({ method: "GET", url: "/preview/9999/", headers: {}, body: new Uint8Array() });
    await bus.deliver();
    const response = await answer;
    expect(response.statusCode).toBe(404);
    expect(decoder.decode(response.body)).toContain("9999");
  });
});
