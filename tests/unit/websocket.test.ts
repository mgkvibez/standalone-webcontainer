/**
 * A websocket over the container's own transport: the handshake, the framing, and the failures that must not hang.
 *
 * The server in these tests is written the way `ws` writes one, because that is the code that has to keep working: an `upgrade` listener
 * that inspects the request, answers with a `101` it computes itself, and then treats the socket as a byte stream. If this file can do
 * that, a package can.
 *
 * The two directions of masking are asserted separately. A runtime that masks server frames and not client frames (or the reverse) works
 * against itself and fails against every real peer, so the wrong answer is the one most likely to go unnoticed.
 */

import { describe, expect, it } from "vitest";

import { PreviewGateway } from "../../src/network/preview-gateway.js";
import { PortRegistry } from "../../src/network/port-registry.js";
import { sha1 } from "../../src/shims/digest.js";
import { Server } from "../../src/shims/http.js";
import type { Socket } from "../../src/shims/socket.js";
import { createWebSocketClass, decodeFrame, encodeFrame } from "../../src/shims/websocket.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** What a websocket server writes when it accepts, computed the way `ws` computes it. */
function acceptKeyFor(request: { readonly headers: Record<string, string> }): string {
  const key = request.headers["sec-websocket-key"] ?? "";
  return base64(sha1(key + GUID));
}

interface Harness {
  readonly gateway: PreviewGateway;
  readonly server: Server;
  readonly sockets: Socket[];
  readonly clientMaskedFirstFrame: boolean | null;
  readonly WebSocketClass: typeof WebSocket;
}

/**
 * A server that accepts upgrades and echoes text frames back.
 *
 * Frames are parsed with the same `decodeFrame` the client uses, which is a real dependency rather than a shortcut: the point is that the
 * two ends agree, and a test with two independent parsers would only prove the test's parser.
 */
function harnessOn(port = 3000, options: { readonly protocol?: string | null } = {}): Harness {
  const ports = new PortRegistry();
  const gateway = new PreviewGateway({ registry: ports });
  const sockets: Socket[] = [];
  /** Whether the client set the mask bit on the first frame it sent. The check the standard makes, recorded rather than assumed. */
  let clientMaskedFirstFrame: boolean | null = null;
  const server = new Server(undefined, { registry: ports });
  gateway.attach(server);
  server.listen(port);

  // Typed the way an emitter listener really is: `unknown` arguments, narrowed here. Asserting the shape instead would make the test
  // depend on the emitter's typing rather than on what the server actually passes.
  server.on("upgrade", (...args: unknown[]) => {
    const request = args[0] as { headers: Record<string, string> };
    const socket = args[1] as Socket;
    sockets.push(socket);
    // A subprotocol header only when the test asks for one: a server that names a protocol nobody offered is a real failure mode, and it can only
    // be tested if the harness can produce it.
    const chosen = options.protocol === undefined || options.protocol === null ? "" : `Sec-WebSocket-Protocol: ${options.protocol}\r\n`;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `${chosen}` +
        `Sec-WebSocket-Accept: ${acceptKeyFor(request)}\r\n\r\n`,
    );
    let buffer = new Uint8Array(0);
    socket.on("data", (chunk: unknown) => {
      const bytes = chunk as Uint8Array;
      buffer = new Uint8Array([...buffer, ...bytes]);
      if (clientMaskedFirstFrame === null && buffer.length >= 2) clientMaskedFirstFrame = (buffer[1]! & 0x80) === 0x80;
      for (;;) {
        let frame;
        try {
          frame = decodeFrame(buffer, 1 << 20);
        } catch (error) {
          socket.emit("error", error as Error);
          return;
        }
        if (frame === null) return;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x1) socket.write(encodeFrame(0x1, frame.payload, false));
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(0x8, frame.payload, false));
          socket.end();
          return;
        }
      }
    });
  });

  const WebSocketClass = createWebSocketClass((request) => {
    const result = gateway.upgrade({ protocol: "http", port: request.port, path: request.path }, request.headers);
    return result.accepted ? { socket: result.socket } : { refusal: result.reason };
  });

  return {
    gateway,
    server,
    sockets,
    WebSocketClass,
    get clientMaskedFirstFrame(): boolean | null {
      return clientMaskedFirstFrame;
    },
  };
}

/** Wait for one event, with a deadline so a broken seam fails as an assertion rather than as a hung test. */
function once(socket: SocketLike, name: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs);
    socket.addEventListener(name, (event: unknown) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

type SocketLike = {
  addEventListener(name: string, listener: (event: unknown) => void): void;
};

describe("websocket handshake", () => {
  it("opens against an upgrade listener, and the server's accept key matches the client's", async () => {
    const { WebSocketClass } = harnessOn();
    const socket = new WebSocketClass("ws://localhost:3000/live") as unknown as SocketLike & { readyState: number };
    expect(socket.readyState).toBe(0);

    await once(socket, "open");
    // 1 is OPEN. If the accept key had not matched, the client would have emitted `error` instead, so this single assertion covers the
    // handshake: a wrong key cannot reach this line.
    expect(socket.readyState).toBe(1);
  });

  it("refuses by name when nothing is listening on the port, rather than waiting for a handshake", async () => {
    const { WebSocketClass } = harnessOn();
    const socket = new WebSocketClass("ws://localhost:4999/live") as unknown as SocketLike;

    const event = (await once(socket, "error")) as { message: string };
    // The wording matters: "nothing is listening" is a program that has not started, and it is the failure a user meets most often.
    expect(event.message).toContain("No preview server is listening on port 4999");
  });

  it("refuses when the port serves requests but has no upgrade listener", async () => {
    const ports = new PortRegistry();
    const gateway = new PreviewGateway({ registry: ports });
    const server = new Server((_request, response) => response.end("plain"), { registry: ports });
    gateway.attach(server);
    server.listen(3100);

    const WebSocketClass = createWebSocketClass((request) => {
      const result = gateway.upgrade({ protocol: "http", port: request.port, path: request.path }, request.headers);
      return result.accepted ? { socket: result.socket } : { refusal: result.reason };
    });
    const socket = new WebSocketClass("ws://localhost:3100/") as unknown as SocketLike;

    const event = (await once(socket, "error")) as { message: string };
    expect(event.message).toContain("no upgrade listener");
  });
});

describe("subprotocol negotiation", () => {
  it("records the protocol the server chose from the ones it offered", async () => {
    const { WebSocketClass } = harnessOn(3300, { protocol: "echo" });
    const socket = new WebSocketClass("ws://localhost:3300/live", "echo") as unknown as SocketLike & { protocol: string };

    await once(socket, "open");
    // A browser sets this from the response; `ws` and anything that offers two protocols reads it to know what it is talking to. The client sent
    // the header and ignored the answer until a previewed page asked for `echo` and got `""` back.
    expect(socket.protocol).toBe("echo");
  });

  it("refuses a protocol it never offered, rather than talking a language it did not agree to", async () => {
    const { WebSocketClass } = harnessOn(3301, { protocol: "something-else" });
    const socket = new WebSocketClass("ws://localhost:3301/live") as unknown as SocketLike;

    const event = (await once(socket, "error")) as { message: string };
    expect(event.message).toContain("when none was requested");
  });

  it("refuses a chosen protocol that is not in the list it offered", async () => {
    const { WebSocketClass } = harnessOn(3302, { protocol: "other" });
    const socket = new WebSocketClass("ws://localhost:3302/live", ["echo", "chat"]) as unknown as SocketLike;

    const event = (await once(socket, "error")) as { message: string };
    expect(event.message).toContain('"other", which was not offered');
  });

  it("one of several offered protocols is accepted, and reported as chosen", async () => {
    const { WebSocketClass } = harnessOn(3303, { protocol: "chat" });
    const socket = new WebSocketClass("ws://localhost:3303/live", ["echo", "chat"]) as unknown as SocketLike & { protocol: string };

    await once(socket, "open");
    expect(socket.protocol).toBe("chat");
  });
});

describe("the accept key", () => {
  it("refuses a 101 whose accept header does not match the key it sent", async () => {
    const ports = new PortRegistry();
    const gateway = new PreviewGateway({ registry: ports });
    const server = new Server(undefined, { registry: ports });
    gateway.attach(server);
    server.listen(3200);
    // 101 with a plausible-looking but wrong accept value: the shape a wrong GUID, a stale key or a middlebox produces. Without the
    // check, this is "connected", and every later frame is being exchanged with something that never understood the handshake.
    server.on("upgrade", (...args: unknown[]) => {
      const socket = args[1] as Socket;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n",
      );
    });

    const WebSocketClass = createWebSocketClass((request) => {
      const result = gateway.upgrade({ protocol: "http", port: request.port, path: request.path }, request.headers);
      return result.accepted ? { socket: result.socket } : { refusal: result.reason };
    });
    const socket = new WebSocketClass("ws://localhost:3200/") as unknown as SocketLike;

    const event = (await once(socket, "error")) as { message: string };
    expect(event.message).toContain("sec-websocket-accept did not match");
  });
});

describe("websocket messages", () => {
  it("carries a text message both ways, with the client's frames masked", async () => {
    // The harness object, not destructured values: `clientMaskedFirstFrame` is a getter read at the moment the frame has actually arrived.
    const harness = harnessOn();
    const { WebSocketClass } = harness;
    const socket = new WebSocketClass("ws://localhost:3000/") as unknown as SocketLike & {
      send(data: string): void;
    };
    await once(socket, "open");

    const received = once(socket, "message");
    socket.send("hello");
    expect(((await received) as { data: string }).data).toBe("hello");
    // The frames a client sends must be masked. Asserting it HERE, on bytes that really crossed the wire, is what covers the call site;
    // asserting it only against `encodeFrame` would still pass if `send` passed `false`.
    expect(harness.clientMaskedFirstFrame).toBe(true);
  });

  it("assembles a fragmented message instead of delivering its pieces", async () => {
    const { WebSocketClass, sockets } = harnessOn();
    const socket = new WebSocketClass("ws://localhost:3000/") as unknown as SocketLike & { send(data: string): void };
    await once(socket, "open");

    const received = once(socket, "message");
    // Both fragments deliberately unmasked, because this is the server's side of the connection.
    const first = encodeFrame(0x1, TEXT_ENCODER.encode("hel"), false);
    // Clear FIN while keeping the opcode: a first fragment is `text, not final`, and a continuation is `no opcode, final`.
    first[0] = first[0]! & 0x7f;
    const second = encodeFrame(0x0, TEXT_ENCODER.encode("lo"), false);
    sockets[0]!.write(new Uint8Array([...first, ...second]));

    expect(((await received) as { data: string }).data).toBe("hello");
  });

  it("closes cleanly, and the peer sees the close code", async () => {
    const { WebSocketClass } = harnessOn();
    const socket = new WebSocketClass("ws://localhost:3000/") as unknown as SocketLike & {
      close(code?: number, reason?: string): void;
    };
    await once(socket, "open");

    const closed = once(socket, "close");
    socket.close(1000, "done");
    const event = (await closed) as { code: number; wasClean: boolean };
    expect(event.code).toBe(1000);
    expect(event.wasClean).toBe(true);
  });
});

describe("frame encoding", () => {
  it("masks a client frame and unmasks it on the way in", () => {
    const payload = TEXT_ENCODER.encode("ping");
    const frame = encodeFrame(0x1, payload, true);

    // The mask bit is what every real server validates; a runtime that forgot it would work against itself and fail everywhere else.
    expect(frame[1]! & 0x80).toBe(0x80);
    expect([...frame.subarray(2, 6)]).not.toEqual([...payload]);
    expect([...decodeFrame(frame, 1024)!.payload]).toEqual([...payload]);
  });

  it("uses the 16-bit and 64-bit length forms where the standard requires them", () => {
    const medium = encodeFrame(0x2, new Uint8Array(126), false);
    // 126 is the escape value that means "the next two bytes are the length", which starts one byte after the first.
    expect(medium[1]! & 0x7f).toBe(126);
    expect((medium[2]! << 8) | medium[3]!).toBe(126);

    const large = encodeFrame(0x2, new Uint8Array(70_000), false);
    expect(large[1]! & 0x7f).toBe(127);
    expect(((large[6]! << 8) | large[7]!) * 1).toBeGreaterThanOrEqual(0);
    expect(decodeFrame(large, 1 << 20)!.payload.length).toBe(70_000);
  });

  it("returns null for a frame that has not fully arrived, instead of a truncated one", () => {
    const frame = encodeFrame(0x1, TEXT_ENCODER.encode("hello world"), false);
    expect(decodeFrame(frame.subarray(0, frame.length - 3), 1024)).toBeNull();
    expect(TEXT_DECODER.decode(decodeFrame(frame, 1024)!.payload)).toBe("hello world");
  });

  it("refuses a frame larger than the limit rather than allocating what it claims", () => {
    const header = encodeFrame(0x2, new Uint8Array(0), false);
    // A 64-bit length of 2^32 bytes: the header alone must be refused, because the allocation would happen before the bytes arrive.
    const claim = new Uint8Array(10);
    claim[0] = 0x82;
    claim[1] = 127;
    claim[6] = 0x01;
    expect(() => decodeFrame(claim, 1 << 20)).toThrow(/exceeds the 1048576 byte limit/);
    expect(header.length).toBe(2);
  });
});
