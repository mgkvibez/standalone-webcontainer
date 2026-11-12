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
import type { ClientMessage, RunRequest, ServerMessage, TransportMessage } from "./protocol.js";

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
