/**
 * The Worker half of the container.
 *
 * One run at a time, one fresh runtime per run. The VFS is rebuilt from the request's file map, which is what makes project
 * isolation structural rather than a discipline: there is no long-lived filesystem to leak into, and a project switch needs
 * no cleanup step. The cost is re-seeding small text projects per run, which is negligible next to compiling them.
 *
 * Output is forwarded as it is written (`onOutput`), so the terminal shows a program's output while it runs. This Worker is
 * a thread boundary, NOT a sandbox.
 */

import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { createTerminal, type Terminal } from "../terminal/pty.js";
import type { ClientMessage, RunRequest, ServerMessage, TransportMessage } from "./protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ClientMessage>) => void) | null;
  postMessage(message: ServerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

const post = (message: ServerMessage): void => {
  scope.postMessage(message);
};

const supervisor = new RuntimeSupervisor();
const transportPorts = new Map<number, MessagePort>();
/**
 * Terminals for runs that are still alive, keyed by process id.
 *
 * The page cannot hold these: a Terminal is a live object with listeners, and the program that reads it runs HERE. So the page
 * sends dimensions with the run and keystrokes afterwards, and this map is how those messages find the right program. Entries are
 * removed when the run settles, so a later keystroke cannot reach a finished program.
 */
const terminals = new Map<number, Terminal>();
const MAX_TRANSPORT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPORT_HEADER_COUNT = 128;
const MAX_TRANSPORT_HEADER_BYTES = 32 * 1024;

async function handleRun(request: RunRequest): Promise<void> {
  const terminal = request.terminal === undefined ? null : createTerminal(request.terminal);
  if (terminal !== null) terminals.set(request.processId, terminal);
  try {
    const result = await supervisor.run({
      projectId: request.projectId,
      files: request.files,
      entry: request.entry,
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      onOutput: (stream, text) => {
        post({ type: "chunk", id: request.id, stream, text });
      },
    }, { terminal });
    post({
      type: "result",
      id: request.id,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      scheduler: result.scheduler,
      ...(result.previewPorts === undefined ? {} : { previewPorts: result.previewPorts }),
    });
  } catch (error) {
    post({
      type: "error",
      id: request.id,
      code: "RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  } finally {
    // The program is over, so nothing may still type into it. Deleting here rather than in the success path only means an
    // error run is cleaned up too.
    terminals.delete(request.processId);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_TRANSPORT_HEADER_COUNT &&
    entries.every(([name, entry]) => typeof entry === "string" && name.length <= 256 && entry.length <= MAX_TRANSPORT_HEADER_BYTES) &&
    entries.reduce((size, [name, entry]) => size + name.length + entry.length, 0) <= MAX_TRANSPORT_HEADER_BYTES;
}

function attachTransport(id: number, port: MessagePort): void {
  transportPorts.set(id, port);
  const detach = (): void => {
    if (transportPorts.get(id) !== port) return;
    transportPorts.delete(id);
    port.close();
  };
  port.onmessage = (event: MessageEvent<unknown>): void => {
    const message = event.data as Partial<TransportMessage> | null;
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
    void supervisor.handleTransport({
      method: message.method,
      url: message.url,
      headers: { ...message.headers },
      body: message.body,
    }).then((response) => {
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
      post({ type: "servers-stopped", id: message.id, ports: supervisor.stopServers(message.ports) });
      return;
    case "sync-files":
      // Deliberately not queued behind runs: an editor's save must reach the running dev server even while a command is executing, and the
      // supervisor's mirroring is synchronous filesystem work that cannot interleave with a run's own turn.
      void supervisor.syncFiles({
        ...(message.projectId === undefined ? {} : { projectId: message.projectId }),
        files: message.files,
        ...(message.removed === undefined ? {} : { removed: message.removed }),
      })
        .then((report) => {
          post({ type: "files-synced", id: message.id, live: report.live, written: report.written, removed: report.removed });
        })
        .catch((error: unknown) => {
          post({
            type: "error",
            id: message.id,
            code: "SYNC_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    case "input":
      // Dropped when no run owns that process id: typing into a program that has exited is a no-op, not an error.
      terminals.get(message.processId)?.write(message.text);
      return;
    case "resize":
      terminals.get(message.processId)?.resize(message.columns, message.rows);
      return;
  }
};
