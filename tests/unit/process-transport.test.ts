/**
 * The broker, over real `MessageChannel`s.
 *
 * `MessageChannel` exists in Node, so this is not a fake transport: the messages really are structured-cloned and really do arrive
 * asynchronously, which is what makes the deadline, the correlation ids and the detach-clears-pending rule testable without a
 * browser. What the browser lane adds is a real program inside a real Worker; what this file adds is the ability to test the
 * failure paths, which a real program would only reach by being broken in exactly the right way.
 */

import { describe, expect, it } from "vitest";

import {
  portFromPreviewUrl,
  ProcessTransportBroker,
  type MessagePortLike,
  type TransportReplyMessage,
  type TransportRequestMessage,
} from "../../src/process/process-transport.js";

const decode = (body: Uint8Array): string => new TextDecoder().decode(body);

const request = (url: string, over: Partial<{ method: string; headers: Record<string, string>; body: Uint8Array }> = {}) => ({
  method: over.method ?? "GET",
  url,
  headers: over.headers ?? {},
  body: over.body ?? new Uint8Array(),
});

/** A process end that answers with a fixed body, so the test is about the broker rather than about HTTP. */
function answeringProcess(statusCode = 200, body = "hello from the process") {
  const channel = new MessageChannel();
  const received: TransportRequestMessage[] = [];
  channel.port1.onmessage = (event: MessageEvent) => {
    const message = event.data as TransportRequestMessage;
    received.push(message);
    const reply: TransportReplyMessage = {
      type: "transport-reply",
      id: message.id,
      response: {
        statusCode,
        statusMessage: "",
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode(body),
      },
    };
    channel.port1.postMessage(reply);
  };
  return { channel, received };
}

describe("portFromPreviewUrl", () => {
  it("reads the port a preview path addresses", () => {
    expect(portFromPreviewUrl("/preview/3000/")).toBe(3000);
    expect(portFromPreviewUrl("/preview/3200/src/main.js")).toBe(3200);
    expect(portFromPreviewUrl("/preview/3200/a/b/c?x=1")).toBe(3200);
  });

  it("reads an absolute URL, because a Node-side probe has no browser to strip the origin", () => {
    expect(portFromPreviewUrl("http://localhost:5173/preview/4000/index.html")).toBe(4000);
  });

  it("answers undefined for anything that is not a preview path", () => {
    for (const url of ["/", "/src/main.js", "/preview/", "/preview/abc/x", "/previewx/3000/", "/preview/0/x", "/preview/70000/x"]) {
      expect(portFromPreviewUrl(url), url).toBeUndefined();
    }
  });

  it("honours a custom mount path, so a test can route somewhere else", () => {
    expect(portFromPreviewUrl("/__preview/3000/x", "/__preview")).toBe(3000);
    expect(portFromPreviewUrl("/preview/3000/x", "/__preview")).toBeUndefined();
  });

  it("is not confused by a second preview segment in the path underneath", () => {
    // `/preview/4000/` must not be read from the delegated path: routing to the wrong port would serve another project's server.
    expect(portFromPreviewUrl("/preview/3000/preview/4000/x")).toBe(3000);
  });
});

describe("ProcessTransportBroker", () => {
  it("forwards to the process that owns the port and returns its answer", async () => {
    const broker = new ProcessTransportBroker();
    const process = answeringProcess(201, "from pid 7");
    broker.attach(7, process.channel.port2 as unknown as { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null });
    broker.setPorts(7, [{ protocol: "http", port: 3000 }]);

    const response = await broker.handle(request("/preview/3000/page"));

    expect(response.statusCode).toBe(201);
    expect(decode(response.body)).toBe("from pid 7");
    expect(process.received).toHaveLength(1);
    // The URL is forwarded UNREWRITTEN: stripping the prefix is the serving runtime's gateway job, and doing it twice breaks every
    // static site that would then serve its index at every path.
    expect(process.received[0]?.request.url).toBe("/preview/3000/page");
  });

  it("routes by port when several processes are attached", async () => {
    const broker = new ProcessTransportBroker();
    const first = answeringProcess(200, "one");
    const second = answeringProcess(200, "two");
    broker.attach(1, first.channel.port2 as never);
    broker.setPorts(1, [{ protocol: "http", port: 3000 }]);
    broker.attach(2, second.channel.port2 as never);
    broker.setPorts(2, [{ protocol: "http", port: 4000 }]);

    expect(decode((await broker.handle(request("/preview/4000/"))).body)).toBe("two");
    expect(decode((await broker.handle(request("/preview/3000/"))).body)).toBe("one");
    // One message each: a broker that broadcast would have woken both processes for one request.
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
  });

  it("answers 503 for a port nobody serves, naming the port", async () => {
    const broker = new ProcessTransportBroker();
    const response = await broker.handle(request("/preview/9999/"));
    expect(response.statusCode).toBe(503);
    expect(decode(response.body)).toContain("9999");
  });

  it("answers 400 for a URL that addresses no port", async () => {
    const broker = new ProcessTransportBroker();
    expect((await broker.handle(request("/src/main.js"))).statusCode).toBe(400);
  });

  it("answers 504 when the process accepts the request and never answers, and does not leak the correlation entry", async () => {
    const broker = new ProcessTransportBroker({ timeoutMs: 20 });
    const channel = new MessageChannel();
    // Deliberately silent: this is a server whose handler awaits forever.
    channel.port1.onmessage = () => undefined;
    broker.attach(3, channel.port2 as never);
    broker.setPorts(3, [{ protocol: "http", port: 3000 }]);

    const response = await broker.handle(request("/preview/3000/"));
    expect(response.statusCode).toBe(504);
    expect(decode(response.body)).toContain("3000");

    // A late reply must find nothing. Sending one now would otherwise resolve the NEXT request with this answer, which is the
    // defect a leaked correlation table produces and the reason the id is removed before the timeout resolves.
    channel.port1.postMessage({
      type: "transport-reply",
      id: 1,
      response: { statusCode: 200, statusMessage: "", headers: {}, body: new Uint8Array([1]) },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.ownerOf(3000)).toBe(3);
  });

  it("fails a waiting request immediately when its process is detached, rather than at the deadline", async () => {
    const broker = new ProcessTransportBroker({ timeoutMs: 5_000 });
    const channel = new MessageChannel();
    channel.port1.onmessage = () => undefined;
    broker.attach(4, channel.port2 as never);
    broker.setPorts(4, [{ protocol: "http", port: 3000 }]);

    const startedAt = Date.now();
    const pending = broker.handle(request("/preview/3000/"));
    broker.detach(4);
    const response = await pending;

    expect(response.statusCode).toBe(503);
    expect(decode(response.body)).toContain("pid 4");
    // Well under the five-second deadline: a killed server must read as "nothing is listening" now, not after a timeout.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(broker.ownerOf(3000)).toBeUndefined();
  });

  it("reports a process's own failure as a 500 that names it", async () => {
    const broker = new ProcessTransportBroker();
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as TransportRequestMessage;
      channel.port1.postMessage({ type: "transport-error", id: message.id, reason: "the handler threw" });
    };
    broker.attach(5, channel.port2 as never);
    broker.setPorts(5, [{ protocol: "http", port: 3000 }]);

    const response = await broker.handle(request("/preview/3000/"));
    expect(response.statusCode).toBe(500);
    expect(decode(response.body)).toBe("the handler threw");
  });

  it("tracks bindings across processes, and stops routing a port the process released", async () => {
    const broker = new ProcessTransportBroker();
    broker.attach(1, new MessageChannel().port2 as never);
    broker.setPorts(1, [{ protocol: "http", port: 3000 }]);
    expect(broker.bindings()).toEqual([{ pid: 1, protocol: "http", port: 3000 }]);

    broker.setPorts(1, []);
    expect(broker.ownerOf(3000)).toBeUndefined();
    expect(broker.bindings()).toEqual([]);
    expect((await broker.handle(request("/preview/3000/"))).statusCode).toBe(503);
  });

  it("accepts a raw ports message and ignores a malformed one instead of trusting it", async () => {
    const broker = new ProcessTransportBroker();
    broker.attach(1, new MessageChannel().port2 as never);

    broker.accept(1, { type: "ports", ports: [{ protocol: "http", port: 3000 }, { protocol: "ftp", port: 21 }, { port: "3001" }] });
    expect(broker.ownerOf(3000)).toBe(1);
    expect(broker.ownerOf(21)).toBeUndefined();
    expect(broker.bindings()).toHaveLength(1);
  });

  it("keeps http and https on the same number apart, because a browser treats them as two origins", () => {
    const broker = new ProcessTransportBroker();
    broker.attach(1, new MessageChannel().port2 as never);
    broker.setPorts(1, [{ protocol: "https", port: 443 }]);
    expect(broker.ownerOf(443, "http")).toBeUndefined();
    expect(broker.ownerOf(443, "https")).toBe(1);
  });
});

/**
 * A response that arrives in pieces, over the same channel as the one that arrives whole.
 *
 * The interesting failures are not "a chunk was delivered" but the ones where a chunk is delivered to the WRONG request: the broker
 * keeps one correlation entry per request, and a late chunk for an answered request that is forwarded anyway lands in whatever asked
 * next.
 */
describe("streaming through the broker", () => {
  /** A process that starts a response, writes the given chunks with a turn between each, then replies. */
  function streamingProcess(chunks: readonly string[], options: { readonly replyFirst?: boolean } = {}) {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as TransportRequestMessage;
      if (options.replyFirst === true) {
        channel.port1.postMessage({
          type: "transport-reply",
          id: message.id,
          response: { statusCode: 200, statusMessage: "", headers: {}, body: new Uint8Array(), streamed: true },
        });
      }
      channel.port1.postMessage({
        type: "transport-event",
        id: message.id,
        event: { kind: "start", statusCode: 201, statusMessage: "Created", headers: { "content-type": "text/plain" } },
      });
      for (const chunk of chunks) {
        channel.port1.postMessage({ type: "transport-event", id: message.id, event: { kind: "chunk", body: new TextEncoder().encode(chunk) } });
      }
      if (options.replyFirst !== true) {
        channel.port1.postMessage({
          type: "transport-reply",
          id: message.id,
          response: { statusCode: 201, statusMessage: "Created", headers: {}, body: new Uint8Array(), streamed: true },
        });
      }
    };
    return channel;
  }

  function brokerWith(channel: MessageChannel): ProcessTransportBroker {
    const broker = new ProcessTransportBroker();
    broker.attach(1, channel.port2 as unknown as MessagePortLike);
    broker.setPorts(1, [{ protocol: "http", port: 3000 }]);
    return broker;
  }

  it("delivers the start event and every chunk, in write order, before the reply resolves", async () => {
    const events: string[] = [];
    let status = 0;
    const broker = brokerWith(streamingProcess(["one", "two"]));
    const response = await broker.handle(request("/preview/3000/stream"), (event) => {
      if (event.kind === "start") {
        status = event.statusCode;
        events.push("start");
        return;
      }
      events.push(decode(event.body));
    });
    expect(events).toEqual(["start", "one", "two"]);
    expect(status).toBe(201);
    expect(response.streamed).toBe(true);
    expect(response.body.byteLength).toBe(0);
  });

  it("keeps the whole body for a caller that did not ask for events", async () => {
    // The process installs the sink, so it is the process that has to be told. A Worker that streams unconditionally answers a buffered
    // caller with `streamed: true` and an empty body: a 200 whose content is gone, indistinguishable from a handler that wrote nothing.
    const channel = new MessageChannel();
    const broker = new ProcessTransportBroker({ mountPath: "/preview", timeoutMs: 1_000 });
    broker.attach(1, channel.port2 as unknown as MessagePortLike);
    broker.setPorts(1, [{ protocol: "http", port: 3000 }]);

    const requests: { readonly stream?: boolean }[] = [];
    channel.port1.onmessage = (event: MessageEvent<{ readonly id: number; readonly stream?: boolean }>) => {
      requests.push(event.data);
      channel.port1.postMessage({
        type: "transport-reply",
        id: event.data.id,
        response: { statusCode: 200, statusMessage: "OK", headers: {}, body: new TextEncoder().encode("whole body") },
      });
    };
    channel.port1.start();

    const response = await broker.handle({ method: "GET", url: "/preview/3000/plain", headers: {}, body: new Uint8Array() });

    expect(new TextDecoder().decode(response.body)).toBe("whole body");
    expect(response.streamed).toBeUndefined();
    // And the process was told the truth about what the caller wanted.
    expect(requests[0]?.stream).toBeUndefined();

    const streamed = new MessageChannel();
    const streaming = new ProcessTransportBroker({ mountPath: "/preview", timeoutMs: 1_000 });
    streaming.attach(2, streamed.port2 as unknown as MessagePortLike);
    streaming.setPorts(2, [{ protocol: "http", port: 3000 }]);
    const asked: { readonly stream?: boolean }[] = [];
    streamed.port1.onmessage = (event: MessageEvent<{ readonly id: number; readonly stream?: boolean }>) => {
      asked.push(event.data);
      streamed.port1.postMessage({
        type: "transport-reply",
        id: event.data.id,
        response: { statusCode: 200, statusMessage: "OK", headers: {}, body: new Uint8Array(), streamed: true },
      });
    };
    streamed.port1.start();
    await streaming.handle({ method: "GET", url: "/preview/3000/stream", headers: {}, body: new Uint8Array() }, () => undefined);
    expect(asked[0]?.stream).toBe(true);
  });

  it("drops an event that arrives after its request answered, instead of giving it to the next one", async () => {
    const channel = streamingProcess([], { replyFirst: true });
    const broker = brokerWith(channel);
    const seen: string[] = [];
    // The reply arrives first, so the entry is gone. A chunk posted afterwards for that id must find nothing.
    await broker.handle(request("/preview/3000/first"), (event) => {
      seen.push(event.kind === "start" ? "start" : decode(event.body));
    });
    channel.port1.postMessage({ type: "transport-event", id: 1, event: { kind: "chunk", body: new TextEncoder().encode("late") } });
    // A second request reuses the SAME numeric id? It must not: ids increase, which is what makes the dropped-id rule sufficient.
    const second = await broker.handle(request("/preview/3000/second"), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Neither the dropped late chunk nor the second request's own events reached this caller: it passed no sink.
    expect(seen).toEqual([]);
    expect(second.statusCode).toBe(200);
  });

  it("does not forward events to a caller that asked for a whole response", async () => {
    const broker = brokerWith(streamingProcess(["ignored"]));
    const response = await broker.handle(request("/preview/3000/buffered"));
    // No sink: the events are dropped rather than accumulated, because a caller with no sink has nowhere to put them.
    expect(response.streamed).toBe(true);
    expect(response.body.byteLength).toBe(0);
  });

  it("ignores a malformed event rather than throwing into the caller's request", async () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as TransportRequestMessage;
      channel.port1.postMessage({ type: "transport-event", id: message.id, event: { kind: "nonsense" } });
      channel.port1.postMessage({ type: "transport-event", id: message.id, event: { kind: "chunk", body: "not bytes" } });
      channel.port1.postMessage({
        type: "transport-reply",
        id: message.id,
        response: { statusCode: 200, statusMessage: "", headers: {}, body: new TextEncoder().encode("ok") },
      });
    };
    const broker = brokerWith(channel);
    const chunks: Uint8Array[] = [];
    const response = await broker.handle(request("/preview/3000/x"), (event) => {
      if (event.kind === "chunk") chunks.push(event.body);
    });
    expect(response.statusCode).toBe(200);
    // The string body became an empty array rather than a lie about bytes.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.byteLength).toBe(0);
  });
});

/**
 * The upgrade path across the boundary.
 *
 * A message port rather than a real Worker, on purpose: the crossing is what is under test, and a fake process end can be made to refuse, to
 * stall and to speak in a precise order, which a real program would only do by being broken in exactly the right way. The real Worker is
 * covered in the browser lane, where a program does its own handshake.
 */
describe("upgrade across the boundary", () => {
  /** A process end that decides what to do with `socket-open` and records everything it is sent. */
  function socketProcess(onOpen: (id: number, port: MessagePortLike) => void) {
    const channel = new MessageChannel();
    const sent: { type?: string; data?: Uint8Array }[] = [];
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; id?: number; data?: Uint8Array };
      sent.push(message);
      if (message.type === "socket-open" && typeof message.id === "number") onOpen(message.id, channel.port1 as unknown as MessagePortLike);
    };
    return { channel, sent };
  }

  const attach = (broker: ProcessTransportBroker, port: MessagePortLike): void => {
    broker.attach(7, port);
    broker.setPorts(7, [{ protocol: "http", port: 3200 }]);
  };

  it("refuses a port nobody serves, in the gateway's own words", async () => {
    const broker = new ProcessTransportBroker();
    const result = await broker.upgrade(4999, "/live", {});
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    // Shared with `handle`'s 503 on purpose: a user meets both and should read one sentence.
    expect(result.reason).toContain("No preview server is listening on port 4999");
  });

  it("forwards the process's refusal verbatim", async () => {
    const broker = new ProcessTransportBroker();
    const process = socketProcess((id, port) => port.postMessage({ type: "socket-refused", id, reason: "port 3200 has no upgrade listener" }));
    attach(broker, process.channel.port2 as unknown as MessagePortLike);

    const result = await broker.upgrade(3200, "/live", {});
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("no upgrade listener");
  });

  it("carries bytes both ways once accepted, including a write that arrives before the acceptance", async () => {
    const broker = new ProcessTransportBroker();
    const process = socketProcess((id, port) => {
      // The 101 lands BEFORE the acceptance, which is what a handler writing its handshake synchronously produces. Dropping it would present
      // as a connection that opened and then said nothing.
      port.postMessage({ data: new TextEncoder().encode("101 Switching Protocols"), type: "socket-data", id });
      port.postMessage({ type: "socket-accepted", id });
    });
    attach(broker, process.channel.port2 as unknown as MessagePortLike);

    const result = await broker.upgrade(3200, "/live", {});
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const received: string[] = [];
    result.socket.on("data", (chunk: unknown) => received.push(decode(chunk as Uint8Array)));
    // Attaching a listener drains what queued while there was none, the same rule an in-thread pair relies on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.join("")).toBe("101 Switching Protocols");

    result.socket.write("frame-bytes");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const data = process.sent.filter((message) => message.type === "socket-data");
    expect(data.length).toBe(1);
    expect(decode(data[0]?.data ?? new Uint8Array())).toBe("frame-bytes");
  });

  it("passes a half-close through in both directions", async () => {
    const broker = new ProcessTransportBroker();
    const process = socketProcess((id, port) => {
      port.postMessage({ type: "socket-accepted", id });
      // A server that answers and hangs up: the client must see `end` rather than a connection that stays open forever.
      port.postMessage({ data: new TextEncoder().encode("bye"), type: "socket-data", id });
      port.postMessage({ type: "socket-end", id });
    });
    attach(broker, process.channel.port2 as unknown as MessagePortLike);

    const result = await broker.upgrade(3200, "/live", {});
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const events: string[] = [];
    result.socket.on("data", () => events.push("data"));
    result.socket.on("end", () => events.push("end"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["data", "end"]);

    result.socket.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(process.sent.some((message) => message.type === "socket-end")).toBe(true);
  });

  it("refuses rather than waiting forever when the open is never answered", async () => {
    const broker = new ProcessTransportBroker({ timeoutMs: 40 });
    // A process that takes the message and says nothing: the shape of a Worker wedged in the program it is running.
    const process = socketProcess(() => {});
    attach(broker, process.channel.port2 as unknown as MessagePortLike);

    const result = await broker.upgrade(3200, "/live", {});
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("did not accept the upgrade within 40 ms");
  });

  it("fails an open connection the moment its process is dropped", async () => {
    const broker = new ProcessTransportBroker();
    const process = socketProcess((id, port) => port.postMessage({ type: "socket-accepted", id }));
    attach(broker, process.channel.port2 as unknown as MessagePortLike);

    const result = await broker.upgrade(3200, "/live", {});
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const closed: string[] = [];
    result.socket.on("close", () => closed.push("close"));
    broker.detach(7);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A connection to a dead process is over, not idle: waiting is waiting for something that cannot arrive.
    expect(closed).toEqual(["close"]);
    expect(result.socket.destroyed).toBe(true);
  });
});
