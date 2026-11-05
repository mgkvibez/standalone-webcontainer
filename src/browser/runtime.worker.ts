/**
 * The Worker half of P1a: this is the only place the runtime is ever constructed in a browser.
 *
 * Why a Worker at all, when the runtime is plain JavaScript and would run on the page: a synchronous infinite loop
 * cannot be interrupted once it starts. On the page it freezes the tab, the spinner, and the tab's ability to even ask
 * for help. In a Worker the same loop costs nothing but that Worker, which the page can `terminate()`. That is the
 * whole isolation story today, and it is worth stating plainly: a Worker is a separate thread, NOT a security boundary.
 * Code in it can still burn CPU, allocate memory, and a future network access would be just as real from there.
 *
 * The global scope here is typed by hand rather than by adding the `WebWorker` lib to the project's tsconfig, because
 * `WebWorker` and `DOM` both declare `self` and pulling both in makes the whole codebase's DOM typing contaminate the
 * runtime's. Two interface members are all this file needs.
 */

import { InProcessRuntime } from "../runtime/in-process.js";
import { FileSystem } from "../vfs/index.js";
import { APP_ROOT, DEFAULT_ENTRY, type ClientMessage, type RunRequest, type ServerMessage } from "./protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ClientMessage>) => void) | null;
  postMessage(message: ServerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

// One VFS and one runtime for the life of this Worker. Nothing is shared with the page, and nothing survives
// `terminate()`: that is the discard path the host relies on.
const vfs = new FileSystem();
const runtime = new InProcessRuntime(vfs);

function post(message: ServerMessage): void {
  scope.postMessage(message);
}

/** Write a request's files into the runtime's own filesystem, creating parents as needed. */
function writeProject(files: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(files)) {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (parent !== "") vfs.mkdirSync(parent, { recursive: true });
    vfs.writeFileSync(path, contents);
  }
}

async function handleRun(request: RunRequest): Promise<void> {
  try {
    writeProject(request.files);
    const entry = request.entry === "" ? DEFAULT_ENTRY : request.entry;
    const result = await runtime.run(entry, {
      argv: [...(request.argv ?? ["node", entry])],
      cwd: APP_ROOT,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
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
    });
  } catch (error) {
    // The runtime reports a crashing *program* as exitCode 1 with the stack on stderr, so reaching this branch means the
    // runtime itself failed. Surfacing it as an error rather than an empty result is the difference between "your code
    // printed nothing" and "we broke", and the page must not confuse the two.
    post({
      type: "error",
      id: request.id,
      code: "RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  }
}

scope.onmessage = (event: MessageEvent<ClientMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "ping":
      post({ type: "pong", id: message.id, lane: "in-process" });
      return;
    case "run":
      void handleRun(message);
      return;
  }
};

// Announce readiness so the page can distinguish "Worker booted" from "Worker booted and the runtime constructed".
post({ type: "pong", id: 0, lane: "in-process" });
