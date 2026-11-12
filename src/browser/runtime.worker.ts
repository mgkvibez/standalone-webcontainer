/**
 * The Worker half of the container.
 *
 * It holds a `ProcessKernel`: one filesystem per project, and ONE WORKER PER PROCESS behind it. That is the change ADR-0018 was
 * written for and the audit's W-1. The supervisor this replaced ran every command through a single queue, so a `npm run dev` that
 * never exits blocked the terminal and no server could outlive the command that started it.
 *
 * What the page sees does not change. A `run` still resolves with one outcome, having streamed its output as it was written, because
 * a terminal wants "the command finished, here is what it said". What changed is where the command runs: its own thread, served by
 * this one over a syscall channel, with its servers reachable through the transport broker.
 *
 * The page's project snapshot is still mirrored in at each command boundary, so the durable store stays the page's and the VFS stays
 * runtime state. Project isolation is by project id: switching projects disposes the kernel, which kills its processes and drops its
 * files.
 *
 * This Worker is a thread boundary, NOT a sandbox.
 */

import { ProcessKernel } from "../process/process-kernel.js";
import type { TransportEvent } from "../process/process-transport.js";
import { createProjectMirror } from "../process/project-mirror.js";
import type { ProjectFileContents } from "../container/types.js";
import type { ClientMessage, RunRequest, ServerMessage, SocketClose, SocketOpen, TransportMessage } from "./protocol.js";
import { createWebSocketClass } from "../shims/websocket.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ClientMessage>) => void) | null;
  postMessage(message: ServerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

const post = (message: ServerMessage): void => {
  scope.postMessage(message);
};

/**
 * The active project's kernel, and the identity it belongs to.
 *
 * One kernel per project, created on first use and disposed on a switch. A kernel owns a real `FileSystem` and real Workers, so it
 * cannot be shared between projects: disposing it is what makes `node_modules` and servers from one project invisible to the next.
 */
let kernel: ProcessKernel | null = null;
let kernelProjectId: string | null = null;
/** The diff between the page's snapshot and the kernel's filesystem, so a program's own writes survive a command boundary. */
const mirror = createProjectMirror();
/**
 * The page numbers RUNS; the kernel numbers PROCESSES. These two maps are the translation, and they are separate on purpose.
 *
 * They look like the same key and are not: a page's run id and its process id are independent, and for a while this file keyed output by
 * the PROCESS id, so a second run's output was posted with an id the client had no pending entry for and was silently dropped. One map
 * answers "which kernel process serves this page process", the other "which run is this process's stdout for".
 */
const processByRun = new Map<number, number>();
const runByPid = new Map<number, number>();
const transportPorts = new Map<number, MessagePort>();
/** Output collected per in-flight run, so the result reports exactly what the terminal was shown. */
const capture = new Map<number, { stdout: string; stderr: string }>();
const MAX_TRANSPORT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPORT_HEADER_COUNT = 128;
const MAX_TRANSPORT_HEADER_BYTES = 32 * 1024;

function activeKernel(projectId: string, files: Readonly<Record<string, ProjectFileContents>>): ProcessKernel {
  if (kernel !== null && kernelProjectId !== projectId) {
    // Switching projects is the only moment isolation can be broken, so it is the only place it is enforced.
    kernel.dispose();
    kernel = null;
    mirror.reset();
    processByRun.clear();
    runByPid.clear();
  }
  if (kernel === null) {
    kernel = new ProcessKernel({ onOutput: forwardOutput });
    kernelProjectId = projectId;
  }
  mirror.sync(kernel, files);
  return kernel;
}

async function handleRun(request: RunRequest): Promise<void> {
  const startedAt = Date.now();
  capture.set(request.id, { stdout: "", stderr: "" });
  let pid = 0;
  try {
    const target = activeKernel(request.projectId, request.files);
    pid = target.start({
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      ...(request.terminal === undefined ? {} : { terminal: request.terminal }),
      ...(request.timeoutMs > 0 ? { timeoutMs: request.timeoutMs } : {}),
    });
    processByRun.set(request.processId, pid);
    runByPid.set(pid, request.id);
    const settled = await target.settled(pid);
    const ports = target.ports().filter((binding) => binding.pid === pid && binding.protocol === "http").map((binding) => binding.port);
    const collected = capture.get(request.id) ?? { stdout: "", stderr: "" };
    post({
      type: "result",
      id: request.id,
      stdout: collected.stdout,
      stderr: collected.stderr,
      exitCode: settled.exitCode ?? (settled.timedOut ? 124 : 1),
      durationMs: Date.now() - startedAt,
      timedOut: settled.timedOut,
      // Passed through unchanged when the program reported it. A process that never settled its queue (killed, or a busy loop that had to
      // be terminated) has none, and the field is `unknown` precisely so "no evidence" stays distinguishable from "zero".
      scheduler: target.schedulerOf(pid),
      ...(ports.length === 0 ? {} : { previewPorts: ports }),
    });
    // Output arrived as `chunk` messages as it was written; the capture above is the same stream, collected, so a result can never
    // disagree with what the terminal showed.
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      code: "RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  } finally {
    capture.delete(request.id);
    processByRun.delete(request.processId);
    // Only this run's entry: a process held open by a server outlives the run, and its late output must not be attributed to whichever run
    // happens to be next.
    if (pid !== 0 && runByPid.get(pid) === request.id) runByPid.delete(pid);
  }
}

/**
 * Output is forwarded as it happens, so a terminal shows a program's output while it runs rather than once it has finished.
 *
 * The kernel reports by pid and the page addresses by run id, so the translation happens here, once, rather than in every message.
 */
function forwardOutput(pid: number, channel: "stdout" | "stderr", text: string): void {
  const runId = runByPid.get(pid);
  if (runId === undefined) return;
  const collected = capture.get(runId);
  if (collected !== undefined) {
    if (channel === "stdout") collected.stdout += text;
    else collected.stderr += text;
  }
  post({ type: "chunk", id: runId, stream: channel, text });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_TRANSPORT_HEADER_COUNT &&
    entries.every(([name, entry]) => typeof entry === "string" && name.length <= 256 && entry.length <= MAX_TRANSPORT_HEADER_BYTES) &&
    entries.reduce((size, [name, entry]) => size + name.length + entry.length, 0) <= MAX_TRANSPORT_HEADER_BYTES;
}

/**
 * The websockets open on one transport port, by the page's id.
 *
 * A connection outlives the message that opened it, so it cannot be a local inside a handler: something has to hold it while the page is idle,
 * and something has to close it when the page goes away.
 */
interface PageSocket {
  readonly socket: WebSocket;
  readonly detach: () => void;
}

const pageSocketsByPort = new WeakMap<MessagePort, Map<number, PageSocket>>();

/**
 * The class the container's own `WebSocket` is built from, with a connector that answers from this process's port table.
 *
 * One class for the whole worker: the connector takes the port from the message being served rather than from the URL, so every instance is
 * created per connection from this factory.
 */
function webSocketFor(port: number): typeof WebSocket {
  return createWebSocketClass(async (request) => {
    if (kernel === null) return { refusal: "No project is loaded." };
    // The two shapes are the same decision stated by two layers: the kernel says whether anybody accepted, the client wants a socket or a
    // sentence. Translated here rather than by making the client understand the kernel's vocabulary.
    const result = await kernel.upgrade(port, request.path, request.headers);
    return result.accepted ? { socket: result.socket } : { refusal: result.reason };
  });
}

/**
 * Frame payloads as bytes, or nothing.
 *
 * The container client is a browser `WebSocket` and honours `binaryType`, so it can hand over a Blob as easily as an ArrayBuffer. `openPageSocket`
 * sets `binaryType = "arraybuffer"` so that should not happen; this still accepts both, because a body silently dropped here is a binary frame a
 * page never receives, and that failure looks exactly like a server that sent nothing.
 */
function socketBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function openPageSocket(port: MessagePort, sockets: Map<number, PageSocket>, message: SocketOpen): void {
  const id = message.id;
  const live = kernel;
  if (live === null) {
    port.postMessage({ type: "socket-failed", id, message: "No project is loaded." });
    return;
  }
  const WebSocketClass = webSocketFor(message.port);
  let socket: WebSocket;
  try {
    const protocols = [...message.protocols];
    socket = protocols.length === 0
      ? new WebSocketClass(`ws://preview${message.path}`)
      : new WebSocketClass(`ws://preview${message.path}`, protocols);
  } catch (error) {
    port.postMessage({ type: "socket-failed", id, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  // The page speaks bytes, and this is where the container's client is told which form to hand over. Leaving the default ("blob") would deliver
  // every binary message as a Blob-nothing this boundary can copy.
  socket.binaryType = "arraybuffer";

  let closed = false;
  const finish = (code: number, reason: string, clean: boolean): void => {
    if (closed) return;
    closed = true;
    sockets.delete(id);
    port.postMessage({ type: "socket-closed", id, code, reason, clean });
  };

  socket.addEventListener("open", () => {
    port.postMessage({ type: "socket-opened", id, protocol: socket.protocol });
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === "string") {
      port.postMessage({ type: "socket-data", id, text: data });
      return;
    }
    const body = socketBytes(data);
    if (body === null) return;
    // Copied: the shim owns the buffer it handed over, and it is reused for the frames that follow.
    port.postMessage({ type: "socket-data", id, body: body.slice() });
  });
  socket.addEventListener("close", (event: CloseEvent) => finish(event.code, event.reason, event.wasClean));
  socket.addEventListener("error", () => {
    // A browser fires `error` and then `close`; a connection that never opened gets the sentence instead, because the page's handlers would
    // otherwise see a close for a socket they never saw open.
    if (socket.readyState === WebSocket.CONNECTING) finish(1006, "The connection could not be opened.", false);
  });

  sockets.set(id, {
    socket,
    detach: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  });
}

/** Validate a socket message and act on it. A bad message fails the connection it names, never the shared message handler. */
function handleSocketMessage(port: MessagePort, sockets: Map<number, PageSocket>, message: Partial<TransportMessage>): void {
  const id = typeof message.id === "number" && Number.isInteger(message.id) ? message.id : -1;
  if (id < 0) {
    port.postMessage({ type: "socket-failed", id: -1, message: "Invalid socket message." });
    return;
  }
  if (message.type === "socket-open") {
    const valid = typeof message.port === "number" && Number.isInteger(message.port) && message.port >= 1 && message.port <= 65535 &&
      typeof message.path === "string" && message.path.length > 0 && message.path.length <= 8192 &&
      Array.isArray(message.protocols) && message.protocols.every((entry) => typeof entry === "string" && entry.length <= 128);
    if (!valid) {
      port.postMessage({ type: "socket-failed", id, message: "Invalid socket request." });
      return;
    }
    openPageSocket(port, sockets, message as SocketOpen);
    return;
  }

  const entry = sockets.get(id);
  // A message for a socket that is already closed is dropped rather than refused: the page's own close and the server's race by construction,
  // and treating the loser as an error would report a failure on every clean shutdown.
  if (entry === undefined) return;

  if (message.type === "socket-send") {
    const text = typeof message.text === "string" ? message.text : undefined;
    const body = message.body instanceof Uint8Array ? message.body : undefined;
    if ((text === undefined) === (body === undefined)) {
      entry.detach();
      return;
    }
    try {
      entry.socket.send((text ?? body) as string | Uint8Array);
    } catch {
      // `send` on a socket that is closing throws InvalidStateError, which is the page's race to lose; the close event already told it.
      entry.detach();
    }
    return;
  }

  const request = message as Partial<SocketClose>;
  try {
    entry.socket.close(request.code ?? 1000, request.reason ?? "");
  } catch {
    entry.detach();
  }
}

function attachTransport(id: number, port: MessagePort): void {
  transportPorts.set(id, port);
  const detach = (): void => {
    if (transportPorts.get(id) !== port) return;
    transportPorts.delete(id);
    // A page that went away owns no sockets: leaving them open would keep a handler in the process writing frames nobody reads, and the server
    // would never learn its client is gone.
    for (const entry of sockets.values()) entry.detach();
    sockets.clear();
    port.close();
  };
  const sockets = new Map<number, PageSocket>();
  pageSocketsByPort.set(port, sockets);
  port.onmessage = (event: MessageEvent<unknown>): void => {
    const message = event.data as Partial<TransportMessage> | null;
    if (message !== null && (message.type === "socket-open" || message.type === "socket-send" || message.type === "socket-close")) {
      handleSocketMessage(port, sockets, message);
      return;
    }
    if (
      message === null ||
      message.type !== "request" ||
      typeof message.id !== "string" ||
      message.id.length > 256 ||
      typeof message.method !== "string" || !/^[A-Z]{1,16}$/.test(message.method) ||
      typeof message.url !== "string" || message.url.length > 8192 ||
      !isStringRecord(message.headers) ||
      !(message.body instanceof Uint8Array) || message.body.byteLength > MAX_TRANSPORT_BODY_BYTES
    ) {
      port.postMessage({ type: "error", id: typeof message?.id === "string" ? message.id : "", message: "Invalid transport request." });
      return;
    }
    const live = kernel;
    // One sink per request, and every event carries its id: the page routes by id, so two previews streaming at once cannot
    // interleave into each other's response.
    const requestId = message.id;
    const sink = (event: TransportEvent): void => {
      if (event.kind === "start") {
        if (!isStringRecord(event.headers)) return;
        port.postMessage({ type: "start", id: requestId, statusCode: event.statusCode, statusMessage: event.statusMessage, headers: event.headers });
        return;
      }
      const chunk = event.body instanceof Uint8Array ? event.body.slice() : new Uint8Array();
      port.postMessage({ type: "chunk", id: requestId, body: chunk }, [chunk.buffer]);
    };
    void (live === null
      ? Promise.resolve({ statusCode: 503, statusMessage: "", headers: { "content-type": "text/plain; charset=utf-8" }, body: new TextEncoder().encode("No project is loaded.") })
      : live.transport({
          method: message.method,
          url: message.url,
          headers: { ...message.headers },
          body: message.body,
        }, sink)
    ).then((response) => {
      if (response.body.byteLength > MAX_TRANSPORT_BODY_BYTES || !isStringRecord(response.headers)) {
        port.postMessage({ type: "error", id: message.id, message: "Preview response exceeds transport limits." });
        return;
      }
      const body = response.body.slice();
      port.postMessage({
        type: "response",
        id: message.id,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body,
        ...("streamed" in response && response.streamed === true ? { streamed: true } : {}),
      }, [body.buffer]);
    }).catch((error: unknown) => {
      port.postMessage({
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
  port.onmessageerror = detach;
  port.addEventListener("close", detach, { once: true });
  port.start();
}

scope.onmessage = (event: MessageEvent<ClientMessage>): void => {
  const message = event.data;
  switch (message.type) {
    case "ping":
      post({ type: "pong", id: message.id });
      return;
    case "run":
      void handleRun(message);
      return;
    case "connect-transport":
      attachTransport(message.id, message.port);
      return;
    case "disconnect-transport": {
      const port = transportPorts.get(message.id);
      if (port !== undefined) {
        transportPorts.delete(message.id);
        port.close();
      }
      post({ type: "transport-disconnected", id: message.id });
      return;
    }
    case "stop-servers":
      post({ type: "servers-stopped", id: message.id, ports: kernel?.stopServers(message.ports) ?? [] });
      return;
    case "input": {
      // Dropped when no run owns that process id: typing into a program that has exited is a no-op, not an error. The terminal itself
      // lives in the process Worker beside the program that reads it, so this is a message rather than a method call.
      const pid = processByRun.get(message.processId);
      if (pid !== undefined) kernel?.input(pid, message.text);
      return;
    }
    case "resize": {
      const pid = processByRun.get(message.processId);
      if (pid !== undefined) kernel?.resize(pid, message.columns, message.rows);
      return;
    }
  }
};
