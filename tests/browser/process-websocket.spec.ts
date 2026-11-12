/**
 * A websocket to a server that lives in another Worker.
 *
 * The in-process lane was proven in `tests/unit/websocket.test.ts`, where both ends are in one global. This lane is the one the product
 * actually runs: the server is a program inside a `process-worker.ts`, its `upgrade` listener is a closure in THAT Worker, and the client is
 * the container's own `WebSocket` on the kernel side of a message channel. Nothing here stands in for a process.
 *
 * What only a real lane can prove: the handshake, the framing and the thread boundary composing. The three mechanisms fail differently and
 * each one alone is green — the accept key is checked in the unit lane, the framing in both, and the boundary in neither. Here a byte that
 * skipped the relay makes the client fail its accept-key check, which is how a silent transport shows up as a loud protocol error.
 */

import { expect, test } from "@playwright/test";

/** A websocket-echo server, written the way `ws` writes one, with no library: the point is that a real program can do it. */
const SOCKET_SERVER = `
const http = require("http");
const crypto = require("crypto");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// The opcode is a parameter, not a constant: a close frame answered with opcode 1 is a TEXT frame carrying close bytes, which the client
// correctly reads as a message and the test correctly sees as junk. Writing that bug into the fixture would have taught nothing.
function frame(opcode, payload) {
  const len = payload.length;
  const header = len < 126 ? new Uint8Array([0x80 | opcode, len]) : new Uint8Array([0x80 | opcode, 126, (len >> 8) & 255, len & 255]);
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

function take(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = (buffer[2] << 8) | buffer[3];
    offset = 4;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.slice(offset, offset + 4) : null;
  offset += maskBytes;
  const payload = buffer.slice(offset, offset + length);
  if (mask !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: offset + length };
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end("plain request to " + req.url);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\n" +
      "Upgrade: websocket\\r\\n" +
      "Connection: Upgrade\\r\\n" +
      "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n",
  );
  console.log("upgrade accepted on pid " + process.pid);
  let buffer = new Uint8Array(0);
  socket.on("data", (chunk) => {
    buffer = concat(buffer, chunk instanceof Uint8Array ? chunk : new Uint8Array(0));
    for (;;) {
      const parsed = take(buffer);
      if (parsed === null) return;
      buffer = buffer.slice(parsed.consumed);
      if (parsed.opcode === 0x1) socket.write(frame(0x1, parsed.payload));
      if (parsed.opcode === 0x8) {
        socket.write(frame(0x8, parsed.payload));
        socket.end();
        return;
      }
    }
  });
});

server.listen(3200, () => console.log("listening on 3200"));
`;

/** A server that answers requests and has no `upgrade` listener: the refusal a program meets before it implements one. */
const PLAIN_SERVER = `
const http = require("http");
const server = http.createServer((req, res) => res.end("no upgrades here"));
server.listen(3300, () => console.log("listening on 3300"));
`;

test("a websocket handshake completes against a server inside a process Worker, and messages cross both ways", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ socketServer, plainServer }) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      const { createWebSocketClass } = await import(new URL("/src/shims/websocket.ts", location.origin).href);

      const output: Record<number, string> = {};
      const kernel = new ProcessKernel({
        files: { "/socket-server.js": socketServer, "/plain-server.js": plainServer },
        transportTimeoutMs: 3_000,
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };

      // The client the product would give a program on THIS side. The connector asks the kernel, which asks the process Worker: the answer
      // arrives as a message, which is the only reason this connector is allowed to be asynchronous.
      const WebSocketClass = createWebSocketClass(async (request: { port: number; path: string; headers: Record<string, string> }) => {
        const result = await kernel.upgrade(request.port, request.path, request.headers);
        return result.accepted ? { socket: result.socket } : { refusal: result.reason };
      });

      const socketPid = kernel.start({ argv: ["node", "/socket-server.js"] });
      const plainPid = kernel.start({ argv: ["node", "/plain-server.js"] });
      const bothListening = await waitFor(
        () => kernel.ports().some((binding: { port: number }) => binding.port === 3200) && kernel.ports().some((binding: { port: number }) => binding.port === 3300),
      );

      const result: Record<string, unknown> = { bothListening, socketPid, plainPid };

      // 1. A real handshake: the accept key is computed inside the process Worker from the key this client sent, so a byte lost on the way
      // would fail here as a protocol error rather than as a timeout.
      const echo = await new Promise<{ events: string[]; replied: string; error?: string }>((resolve) => {
        const socket = new WebSocketClass("ws://localhost:3200/live");
        const events: string[] = [];
        let replied = "";
        const done = (extra: { error?: string }): void => resolve({ events, replied, ...extra });
        socket.addEventListener("open", () => {
          events.push("open");
          socket.send("hello across the boundary");
        });
        socket.addEventListener("message", (event: { data: unknown }) => {
          replied = typeof event.data === "string" ? event.data : "";
          events.push("message");
          socket.close();
        });
        socket.addEventListener("close", () => {
          events.push("close");
          done({});
        });
        socket.addEventListener("error", (event: { message?: string }) => done({ error: event.message ?? "error" }));
        setTimeout(() => done({ error: "no answer within 10s" }), 10_000);
      });
      result.echo = echo;

      // 2. A port that serves requests and no upgrades, and a port nobody serves: the two refusals must be told apart.
      const refusalFor = async (url: string): Promise<string> =>
        await new Promise<string>((resolve) => {
          const socket = new WebSocketClass(url);
          socket.addEventListener("error", (event: { message?: string }) => resolve(event.message ?? "error"));
          socket.addEventListener("open", () => resolve("unexpectedly opened"));
          setTimeout(() => resolve("no answer within 10s"), 10_000);
        });
      result.plainRefusal = await refusalFor("ws://localhost:3300/live");
      result.absentRefusal = await refusalFor("ws://localhost:4999/live");

      // 3. Killing the process ends the connection instead of leaving a client that never speaks again.
      const second = await new Promise<{ socket?: unknown; error?: string }>((resolve) => {
        const socket = new WebSocketClass("ws://localhost:3200/second");
        (socket as unknown as EventTarget).addEventListener("open", () => resolve({ socket }));
        (socket as unknown as EventTarget).addEventListener("error", (event) => resolve({ error: (event as unknown as { message?: string }).message ?? "error" }));
        setTimeout(() => resolve({ error: "second connection did not open within 5s" }), 5_000);
      });
      result.second = second.error ?? "opened";
      if (second.socket === undefined) {
        result.output = output;
        return result;
      }
      const closedAfterKill = await new Promise<boolean>((resolve) => {
        (second.socket as unknown as EventTarget).addEventListener("close", () => resolve(true));
        kernel.kill(socketPid, "test kill");
        setTimeout(() => resolve(false), 5_000);
      });
      result.closedAfterKill = closedAfterKill;
      result.afterKill = await kernel.transport({
        method: "GET",
        url: "/preview/3200/x",
        headers: {},
        body: new Uint8Array(),
      }).then((response: { statusCode: number }) => response.statusCode);
      result.output = output;
      result.portsAfter = kernel.ports();
      return result;
    },
    { socketServer: SOCKET_SERVER, plainServer: PLAIN_SERVER },
  );

  expect(outcome.bothListening).toBe(true);
  expect(Object.values(outcome.output as Record<number, string>).join("")).toContain("upgrade accepted on pid");
  // The handshake, the frames and the close code all crossed a thread boundary to produce exactly this sequence. An `error` first would mean the
  // accept key, the framing or the relay disagreed with the other side, and the message says which.
  expect(outcome.echo).toEqual({ events: ["open", "message", "close"], replied: "hello across the boundary" });
  // Two refusals, told apart: this is the difference between a program that has not implemented upgrades and one that is not running.
  expect(String(outcome.plainRefusal)).toContain("no upgrade listener");
  expect(String(outcome.absentRefusal)).toContain("No preview server is listening on port 4999");
  // A connection to a killed process is over, not idle.
  expect(outcome.second).toBe("opened");
  expect(outcome.closedAfterKill).toBe(true);
  expect(outcome.afterKill).toBe(503);
  expect((outcome.portsAfter as { port: number }[]).some((binding) => binding.port === 3200)).toBe(false);
});
