/**
 * The page half of P1a: DOM, buttons, and one Worker it talks to over a typed message protocol.
 *
 * No framework on purpose. There is one screen and four controls; a framework would be four dependencies and a build
 * surface for nothing. The page never constructs the runtime and never touches a VFS: if the runtime is reachable from
 * here, the Worker boundary has been broken somewhere.
 */

import {
  APP_ROOT,
  DEFAULT_ENTRY,
  workerFailure,
  type ClientMessage,
  type RunRequest,
  type ServerMessage,
} from "./protocol.js";

const DEFAULT_SOURCE = `const fs = require("fs");
const path = require("path");

fs.writeFileSync(path.join("${APP_ROOT}", "greeting.txt"), "hello from the runtime");
const greeting = fs.readFileSync("${APP_ROOT}/greeting.txt", "utf8");

console.log("stdout:", greeting);
console.error("stderr: this line is on the error stream");
setTimeout(() => console.log("timer: fired after 10 virtual ms"), 10);
console.log("argv:", process.argv.join(" "));
`;

const LOOP_SOURCE = `console.log("about to loop forever");
while (true) {
  // A synchronous loop cannot be interrupted from the same thread.
}
`;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`page is missing #${id}`);
  return found as T;
}

const statusEl = element<HTMLElement>("status");
const codeEl = element<HTMLTextAreaElement>("code");
const stdoutEl = element<HTMLPreElement>("stdout");
const stderrEl = element<HTMLPreElement>("stderr");
const resultEl = element<HTMLPreElement>("result");

let worker: Worker | null = null;
let nextId = 1;
const inflight = new Map<number, (message: ServerMessage) => void>();

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function startWorker(): Worker {
  // `new URL(..., import.meta.url)` is what lets the bundler see the Worker entry and emit it as its own chunk.
  const started = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
    type: "module",
    name: "standalone-webcontainer-runtime",
  });

  started.onmessage = (event: MessageEvent<ServerMessage>) => {
    const message = event.data;
    // The readiness ping uses id 0 and has no caller waiting for it.
    const settle = inflight.get(message.id);
    if (settle === undefined) {
      if (message.type === "pong" && message.id === 0) setStatus("worker ready");
      return;
    }
    inflight.delete(message.id);
    settle(message);
  };

  started.onerror = (event: ErrorEvent) => {
    renderFailure(workerFailure(event.message === "" ? "worker failed to start" : event.message));
    setStatus("worker error");
  };

  return started;
}

function ensureWorker(): Worker {
  worker ??= startWorker();
  return worker;
}

/**
 * Terminate and forget. Every in-flight promise is dropped, which is correct: their answers can no longer arrive, and a
 * later run must not be resolved by a reply from a Worker that no longer exists.
 */
function terminateWorker(): void {
  if (worker === null) return;
  worker.terminate();
  worker = null;
  inflight.clear();
  setStatus("worker terminated");
}

function send(message: ClientMessage): Promise<ServerMessage> {
  const target = ensureWorker();
  return new Promise<ServerMessage>((resolve) => {
    inflight.set(message.id, resolve);
    target.postMessage(message);
  });
}

function clearOutputs(): void {
  stdoutEl.textContent = "";
  stderrEl.textContent = "";
  resultEl.textContent = "";
}

function renderFailure(failure: ServerMessage & { type: "error" }): void {
  stderrEl.textContent = failure.stack ?? failure.message;
  resultEl.textContent = `error ${failure.code}: ${failure.message}`;
}

function render(message: ServerMessage): void {
  if (message.type === "error") {
    renderFailure(message);
    setStatus("failed");
    return;
  }
  if (message.type === "pong") return;

  stdoutEl.textContent = message.stdout;
  stderrEl.textContent = message.stderr;
  resultEl.textContent = [
    `exit code: ${message.exitCode}`,
    `duration: ${message.durationMs} ms`,
    `timed out: ${message.timedOut}`,
    `timers: ${message.scheduler.callbacks} callback(s), ${message.scheduler.virtualElapsedMs} virtual ms, stop=${message.scheduler.stop}`,
  ].join("\n");
  setStatus(message.exitCode === 0 ? "finished (exit 0)" : `finished (exit ${message.exitCode})`);
}

async function run(source: string): Promise<void> {
  clearOutputs();
  setStatus("running");
  const request: RunRequest = {
    type: "run",
    id: nextId++,
    files: { [DEFAULT_ENTRY]: source },
    entry: DEFAULT_ENTRY,
    argv: ["node", "index.js"],
    // Bounds async gaps only. The infinite-loop case exists to show what this cannot do.
    timeoutMs: 2000,
  };
  render(await send(request));
}

element<HTMLButtonElement>("run").addEventListener("click", () => {
  void run(codeEl.value);
});

element<HTMLButtonElement>("loop").addEventListener("click", () => {
  codeEl.value = LOOP_SOURCE;
  // Not awaited: a synchronous loop never resolves, and awaiting it would also freeze this handler's continuation.
  void run(LOOP_SOURCE);
});

element<HTMLButtonElement>("stop").addEventListener("click", () => {
  terminateWorker();
  resultEl.textContent = "worker terminated; the next run starts a fresh one";
});

codeEl.value = DEFAULT_SOURCE;

// Boot on load: the page's first act is a real run through the real runtime, so a working page is self-evidencing.
void (async () => {
  const pong = await send({ type: "ping", id: 0 });
  if (pong.type === "pong") setStatus(`worker ready (${pong.lane})`);
  await run(DEFAULT_SOURCE);
})();
