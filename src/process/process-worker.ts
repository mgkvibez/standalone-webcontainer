/**
 * The process Worker entry.
 *
 * This is the file `ProcessHost` boots once per process. It is the difference between a process table that allocates
 * Workers and a runtime: the Worker receives a pid and a channel, builds a filesystem port over that channel, and hands
 * the real runtime a filesystem it does not own.
 *
 * The neat consequence is that nothing here knows what a VFS is. If the channel answers, the program runs; the same
 * program runs against the in-process `FileSystem` in every existing test.
 *
 * Output is forwarded as it is written, so a supervisor can show a program's output while it runs rather than only at
 * exit. This Worker is a thread boundary, NOT a sandbox: isolation is ADR-0019's job.
 */

import type { ChannelSizes } from "./syscall-channel.js";
import { SyscallClient } from "./syscall-channel.js";
import { createRemoteFileSystem } from "./remote-fs.js";
import { createRemoteWatcher, realTimerScheduler } from "./remote-watch.js";
import { InProcessRuntime } from "../runtime/in-process.js";

interface ProcessScope {
  onmessage: ((event: MessageEvent<StartMessage>) => void) | null;
  postMessage(message: ProcessMessage): void;
}

export interface StartMessage {
  readonly type: "start";
  readonly pid: number;
  /** `["node", "/main.js"]`, exactly as the in-process runtime is given it. */
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly buffer: SharedArrayBuffer;
  readonly sizes: ChannelSizes;
}

export type ProcessMessage =
  | { readonly type: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "failed"; readonly reason: string };

/**
 * How long one filesystem call may wait for the kernel.
 *
 * Longer than the channel's default because a kernel may be serving several processes and a cold install can do a lot of
 * small reads; short enough that a dead kernel shows up as a failed process rather than a hung Worker.
 */
const SYSCALL_TIMEOUT_MS = 30_000;

const scope = globalThis as unknown as ProcessScope;

scope.onmessage = (event) => {
  if (event.data?.type !== "start") return;
  const start = event.data;

  // Deliberately not awaited into a promise chain nobody observes: a rejection inside an async handler is invisible
  // outside this Worker (no `onerror` fires), which is how a silent process death looks like a hung test. Everything is
  // caught and reported as a message.
  void run(start);
};

async function run(start: StartMessage): Promise<void> {
  try {
    const client = new SyscallClient({ buffer: start.buffer, sizes: start.sizes });
    const fs = createRemoteFileSystem(client, { timeoutMs: SYSCALL_TIMEOUT_MS });
    // Watching from inside a process is pulled over the same channel as everything else: the kernel owns the registry, this
    // Worker owns the polling client. A local source here would watch a filesystem this Worker does not have.
    const runtime = new InProcessRuntime(fs, {
      watches: {
        watch: (path, watchOptions) =>
          createRemoteWatcher({
            transport: client,
            path,
            scheduler: realTimerScheduler,
            ...(watchOptions?.recursive === true ? { recursive: true } : {}),
          }),
      },
    });

    const entry = start.argv[1];
    if (entry === undefined) {
      scope.postMessage({ type: "failed", reason: "no entry script in argv" });
      return;
    }

    const result = await runtime.run(entry, {
      argv: [...start.argv],
      ...(start.env === undefined ? {} : { env: start.env }),
      ...(start.cwd === undefined ? {} : { cwd: start.cwd }),
      onOutput: (channel, text) => {
        scope.postMessage({ type: "output", channel, text });
      },
    });

    scope.postMessage({ type: "exit", code: result.exitCode });
  } catch (error) {
    scope.postMessage({ type: "failed", reason: (error as Error)?.message ?? String(error) });
  }
}
