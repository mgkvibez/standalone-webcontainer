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

async function handleRun(request: RunRequest): Promise<void> {
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
    });
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
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function attachTransport(port: MessagePort): void {
  port.onmessage = (event: MessageEvent<unknown>): void => {
    const message = event.data as Partial<TransportMessage> | null;
    if (
      message === null ||
      message.type !== "request" ||
      typeof message.id !== "string" ||
      typeof message.method !== "string" ||
      typeof message.url !== "string" ||
      !isStringRecord(message.headers) ||
      !(message.body instanceof Uint8Array)
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
      attachTransport(message.port);
      return;
    case "stop-servers":
      post({ type: "servers-stopped", id: message.id, ports: supervisor.stopServers(message.ports) });
      return;
  }
};
