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

import { InProcessRuntime } from "../runtime/in-process.js";
import { FileSystem } from "../vfs/index.js";
import type { ClientMessage, RunRequest, ServerMessage } from "./protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ClientMessage>) => void) | null;
  postMessage(message: ServerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

const post = (message: ServerMessage): void => {
  scope.postMessage(message);
};

/** Materialise the project into a brand-new VFS. Parents are created first, so nesting depth does not matter. */
function seedVfs(files: Readonly<Record<string, string>>): FileSystem {
  const vfs = new FileSystem();
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const contents = files[path];
    if (contents === undefined) continue;
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (parent !== "") vfs.mkdirSync(parent, { recursive: true });
    vfs.writeFileSync(path, contents);
  }
  return vfs;
}

async function handleRun(request: RunRequest): Promise<void> {
  try {
    const vfs = seedVfs(request.files);
    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run(request.entry, {
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

scope.onmessage = (event: MessageEvent<ClientMessage>): void => {
  const message = event.data;
  switch (message.type) {
    case "ping":
      post({ type: "pong", id: message.id });
      return;
    case "run":
      void handleRun(message);
      return;
  }
};
