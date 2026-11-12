/**
 * A websocket opened by a page in another realm, relayed through the preview shell, into a program in a process Worker.
 *
 * This is the W-25 lane (ADR-0033). Three layers only exist together:
 *
 * 1. A real iframe, same origin, running the client the preview serves (`public/preview-ws-client.js`). It has no container and no `upgrade`
 *    listener; all it can do is `postMessage`.
 * 2. The shell's translation (`toRuntimeSocketMessage`, `isSocketReply`), the same functions the real shell calls.
 * 3. A real program in a real `process-worker.ts` doing its own handshake, with the container's own `WebSocket` as the client on this side.
 *
 * What only this lane can show: that the page's `WebSocket` facade behaves enough like a browser's for code written against a browser (ready
 * states, the event order for a failure, `binaryType`) while the framing is done by the container's client several boundaries away. A byte lost
 * anywhere in the relay makes the accept-key check fail, which is how a silent transport shows up as a protocol error rather than a hang.
 */

import { expect, test } from "@playwright/test";

/** The same hand-written echo server the cross-Worker lane uses: a program, not a library. */
const SOCKET_SERVER = `
const http = require("http");
const crypto = require("crypto");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126
    ? new Uint8Array([0x80 | opcode, length])
    : new Uint8Array([0x80 | opcode, 126, (length >> 8) & 255, length & 255]);
  const out = new Uint8Array(header.length + length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

const server = http.createServer((req, res) => res.end("plain"));
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\n" +
    "Upgrade: websocket\\r\\n" +
    "Connection: Upgrade\\r\\n" +
    "Sec-WebSocket-Accept: " + accept + "\\r\\n" +
    "Sec-WebSocket-Protocol: echo\\r\\n\\r\\n",
  );
  let pending = new Uint8Array(0);
  let closed = false;
  const parse = () => {
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = (pending[2] << 8) | pending[3];
        offset = 4;
      }
      const maskBytes = masked ? 4 : 0;
      if (pending.length < offset + maskBytes + length) return;
      const mask = masked ? pending.slice(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = pending.slice(offset, offset + length);
      if (mask !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      pending = pending.slice(offset + length);
      if (opcode === 8) {
        if (!closed) {
          closed = true;
          socket.write(frame(8, payload));
          console.log("server saw close");
          socket.end();
        }
        return;
      }
      socket.write(frame(opcode === 2 ? 2 : 1, payload));
    }
  };
  socket.on("data", (chunk) => {
    const bytes = new Uint8Array(chunk);
    const merged = new Uint8Array(pending.length + bytes.length);
    merged.set(pending);
    merged.set(bytes, pending.length);
    pending = merged;
    parse();
  });
  socket.on("error", () => {});
});
server.listen(3200, () => console.log("socket server listening"));
`;

test("a page in another realm opens a websocket to a program in a process Worker", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ socketServer }) => {
      // A hang with no message is the least useful failure there is, so every stage is named and the whole body is raced against a clock.
      let stage = "imports";
      const diagnostics: string[] = [];
      const note = (line: string): void => {
        diagnostics.push(`${stage}: ${line}`);
      };
      const work = async (): Promise<Record<string, unknown>> => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      const { createWebSocketClass } = await import(new URL("/src/shims/websocket.ts", location.origin).href);
      const { toRuntimeSocketMessage } = await import(new URL("/src/browser/socket-relay.ts", location.origin).href);

      const output: Record<number, string> = {};
      const kernel = new ProcessKernel({
        files: { "/socket-server.js": socketServer },
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

      stage = "start server";
      const pid = kernel.start({ argv: ["node", "/socket-server.js"] });
      if (!(await waitFor(() => (output[pid] ?? "").includes("socket server listening")))) {
        return { failure: "the server never listened", output };
      }

      // The runtime's side of the relay, wired the way `runtime.worker.ts` wires it: one container client per connection, its connector answered
      // by the kernel, which asks the process that owns the port.
      const WebSocketClass = createWebSocketClass(async (request: { port: number; path: string; headers: Record<string, string> }) => {
        const result = await kernel.upgrade(request.port, request.path, request.headers);
        return result.accepted ? { socket: result.socket } : { refusal: result.reason };
      });
      const open = new Map<number, InstanceType<typeof WebSocketClass>>();

      stage = "frame";
      // The previewed page, in its own realm, running the client the preview actually serves.
      const frame = document.createElement("iframe");
      frame.src = "/";
      document.body.append(frame);
      await new Promise<void>((resolve) => {
        // The load event, not `readyState`: the initial about:blank document is already "complete", so a readyState shortcut runs the client in a
        // document with no origin, which is exactly the failure this cost one round trip to find.
        frame.addEventListener("load", () => resolve(), { once: true });
        // A frame that never loads must not consume the whole test budget silently.
        setTimeout(resolve, 10_000);
      });
      note(`frame readyState=${String(frame.contentDocument?.readyState)}`);
      const frameWindow = frame.contentWindow as (Window & typeof globalThis) | null;
      if (frameWindow === null) return { failure: "no frame" };
      // Replace the document the frame loaded with an empty one that keeps the origin: the app's own scripts would otherwise run inside this
      // test and their errors would be indistinguishable from the client's.
      const document_ = frame.contentDocument;
      if (document_ === null) return { failure: "no frame document" };
      document_.open();
      document_.write("<!doctype html><html><head></head><body></body></html>");
      document_.close();
      const clientSource = await fetch("/preview-ws-client.js").then((response) => response.text());
      stage = "client";
      try {
        frameWindow.eval(clientSource);
      } catch (error) {
        note(`eval threw: ${error instanceof Error ? error.message : String(error)}`);
      }
      const installed = (frameWindow as unknown as { __swcPreviewWebSocket?: boolean }).__swcPreviewWebSocket === true;
      note(`installed=${installed}`);

      // The shell: page → runtime, refused or translated by the same functions the shell calls.
      const refusals: string[] = [];
      window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.source !== frameWindow || event.origin !== location.origin) return;
        const message = event.data as { type?: string };
        if (typeof message.type !== "string" || message.type.indexOf("socket-") !== 0) return;
        const translated = toRuntimeSocketMessage(message, { origin: location.origin, port: 3200 });
        if ("refusal" in translated) {
          refusals.push(translated.refusal);
          frameWindow.postMessage({ type: "socket-failed", id: (message as { id: number }).id, message: translated.refusal }, location.origin);
          return;
        }
        if (translated.type === "socket-open") {
          const socket = new WebSocketClass(`ws://localhost:${translated.port}${translated.path}`, ...(translated.protocols.length === 0 ? [] : [translated.protocols]));
          socket.binaryType = "arraybuffer";
          open.set(translated.id, socket);
          socket.addEventListener("open", () => frameWindow.postMessage({ type: "socket-opened", id: translated.id, protocol: socket.protocol }, location.origin));
          socket.addEventListener("message", (event: MessageEvent<unknown>) => {
            const data = event.data;
            note(`runtime message ${typeof data}/${String((data as { byteLength?: number; size?: number })?.byteLength ?? (data as { size?: number })?.size)}`);
            frameWindow.postMessage(
              typeof data === "string"
                ? { type: "socket-data", id: translated.id, text: data }
                : { type: "socket-data", id: translated.id, body: data },
              location.origin,
            );
          });
          socket.addEventListener("close", (event: CloseEvent) =>
            frameWindow.postMessage(
              { type: "socket-closed", id: translated.id, code: event.code, reason: event.reason, clean: event.wasClean },
              location.origin,
            ));
          socket.addEventListener("error", () => {
            // The container's client reports a failed handshake as `error` then `close`; the relay keeps that shape.
            if (socket.readyState === 0) frameWindow.postMessage({ type: "socket-failed", id: translated.id, message: "handshake failed" }, location.origin);
          });
          return;
        }
        const socket = open.get(translated.id);
        if (socket === undefined) return;
        if (translated.type === "socket-send") {
          note(`shell send text=${String(translated.text?.length)} bytes=${String(translated.body?.byteLength)}`);
          socket.send((translated.text ?? translated.body) as string | Uint8Array);
        }
        else socket.close();
      });

      stage = "socket";
      const pageResult = await new Promise<{ opened: boolean; protocol: string; echo: string | null; binary: number[] | null; closed: number; errorBeforeOpen: boolean }>(
        (resolve) => {
          frameWindow.addEventListener("error", (event: ErrorEvent) => {
        const stack = (event.error as { stack?: string } | null)?.stack ?? "";
        note(`frame error: ${event.message} ${stack.split("\n").slice(0, 3).join(" | ")}`);
      });
          const script = frameWindow.document.createElement("script");
          script.textContent = `
            try {
            const outcome = { opened: false, protocol: "", echo: null, binary: null, closed: 0, errorBeforeOpen: false };
            const socket = new WebSocket("ws://" + location.hostname + ":3200/live", "echo");
            socket.binaryType = "arraybuffer";
            let failed = false;
            socket.onerror = () => { if (!outcome.opened) { failed = true; outcome.errorBeforeOpen = true; } };
            socket.onopen = () => {
              outcome.opened = true;
              outcome.protocol = socket.protocol;
              socket.send("hello from the page");
              socket.send(new Uint8Array([1, 2, 3, 250]));
            };
            socket.onmessage = (event) => {
              if (typeof event.data === "string") outcome.echo = event.data;
              else outcome.binary = event.data instanceof ArrayBuffer ? Array.from(new Uint8Array(event.data)) : [];
              if (outcome.echo !== null && outcome.binary !== null) socket.close(1000, "done");
            };
            socket.onclose = (event) => { outcome.closed = event.code; window.__swcOutcome = outcome; };
            } catch (error) {
              window.__swcOutcome = { opened: false, protocol: "", echo: null, binary: null, closed: -1, errorBeforeOpen: true };
              window.__swcConstructError = String(error && error.message ? error.message : error);
            }
          `;
          frameWindow.document.head.append(script);
          const tick = (): void => {
            const holder = frameWindow as unknown as { __swcOutcome?: { opened: boolean; protocol: string; echo: string | null; binary: number[] | null; closed: number; errorBeforeOpen: boolean }; __swcConstructError?: string };
            const value = holder.__swcOutcome;
            if (holder.__swcConstructError !== undefined) note(`construct threw: ${holder.__swcConstructError}`);
            if (value !== undefined && value.closed !== 0) resolve(value);
            else setTimeout(tick, 20);
          };
          tick();
        },
      );

      // A second connection to a host that is not this one: the shell refuses it before anything reaches the runtime.
      const refusal = await new Promise<string>((resolve) => {
        const probe = frameWindow.document.createElement("script");
        probe.textContent = `
          const socket = new WebSocket("ws://elsewhere.example/live");
          let message = "";
          socket.onerror = () => {};
          socket.onclose = (event) => { window.__swcRefusal = message + " code=" + event.code; };
        `;
        frameWindow.document.head.append(probe);
        const tick = (): void => {
          const value = (frameWindow as unknown as { __swcRefusal?: string }).__swcRefusal;
          if (value !== undefined) resolve(value);
          else setTimeout(tick, 20);
        };
        tick();
      });

      const closedOnServer = await waitFor(() => (output[pid] ?? "").includes("server saw close"));

      kernel.kill(pid);
      return {
        installed,
        pageResult,
        refusals,
        refusal,
        closedOnServer,
        output,
        diagnostics,
      };
      };
      return Promise.race([
        work(),
        new Promise((resolve) => setTimeout(() => resolve({ failure: `timeout at ${stage}`, diagnostics }), 20_000)),
      ]);
    },
    { socketServer: SOCKET_SERVER },
  );

  const result = outcome as {
    failure?: string;
    diagnostics?: string[];
    installed: boolean;
    pageResult: { opened: boolean; protocol: string; echo: string | null; binary: number[] | null; closed: number; errorBeforeOpen: boolean };
    refusals: string[];
    refusal: string;
    closedOnServer: boolean;
  };
  if (result.failure !== undefined) throw new Error(`${result.failure}\n${(result.diagnostics ?? []).join("\n")}`);

  // The page ran the client the preview serves, not a stub.
  expect(result.installed).toBe(true);
  expect(result.pageResult.opened).toBe(true);
  expect(result.pageResult.protocol).toBe("echo");
  expect(result.pageResult.echo).toBe("hello from the page");
  // Binary arrives as an ArrayBuffer because the page set `binaryType`, and the bytes are the ones it sent.
  expect(result.pageResult.binary).toEqual([1, 2, 3, 250]);
  expect(result.pageResult.closed).toBe(1000);
  // The page's close reached the program: the relay half-closed rather than dropping the connection.
  expect(result.closedOnServer).toBe(true);
  // A URL to another host is refused by name, with the page told as a failed connection rather than a hang.
  expect(result.refusals.join(" ")).toContain("can only open a socket back to itself");
  expect(result.refusal).toContain("code=1006");
});
