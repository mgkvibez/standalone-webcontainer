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
import { PortRegistry, type ServeProtocol } from "../network/port-registry.js";
import type {
  MessagePortLike,
  ProcessToKernelMessage,
  TransportReplyMessage,
  TransportRequestMessage,
} from "./process-transport.js";
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
  /**
   * The reply channel for preview requests addressed to a server this process owns.
   *
   * Optional because a process started by a harness that never serves a preview does not need one, and a Worker that demanded it
   * would fail the moment someone ran a program with no server in it.
   */
  readonly transport?: MessagePortLike;
}

export type ProcessMessage =
  | { readonly type: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "failed"; readonly reason: string };

/**
 * A registry that tells the kernel when it changes.
 *
 * The kernel routes a preview request to a process by port, and the registry that knows the port is bound lives here, in the
 * serving Worker. Polling it from outside is impossible and diffing on a timer would make the preview list lag a `listen()`, so
 * the report happens at the only moment the answer changes: the bind or the release.
 */
class ReportingPortRegistry extends PortRegistry {
  readonly #report: (ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]) => void;

  constructor(report: (ports: readonly { readonly protocol: ServeProtocol; readonly port: number }[]) => void) {
    super();
    this.#report = report;
  }

  override bind(protocol: ServeProtocol, port: number, owner?: string): { readonly protocol: ServeProtocol; readonly port: number } {
    const binding = super.bind(protocol, port, owner);
    this.#report(this.list());
    return binding;
  }

  override release(protocol: ServeProtocol, port: number): boolean {
    const released = super.release(protocol, port);
    if (released) this.#report(this.list());
    return released;
  }
}

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
    const transport = start.transport;
    const registry = new ReportingPortRegistry((ports) => {
      const message: ProcessToKernelMessage = { type: "ports", ports };
      transport?.postMessage(message);
    });
    const runtime = new InProcessRuntime(fs, {
      registry,
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

    attachTransport(transport, runtime);

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


/**
 * Answer preview requests over the reply channel.
 *
 * The routing decision is the runtime's own gateway, not a second one built here: the gateway is the only thing that owns both the
 * port registry and the loader, so a request answered from anywhere else would see a different registry. The gateway also carries
 * the request deadline and the queue pump, which is what lets a handler that awaits `setTimeout` in a listening server answer at
 * all after its program body returned.
 *
 * A failure is reported as an error message rather than swallowed: the kernel turns it into a 500 that names the reason, and a
 * handler that throws is a bug in the program the preview is showing, not a transport fault.
 */
function attachTransport(transport: MessagePortLike | undefined, runtime: InProcessRuntime): void {
  if (transport === undefined) return;
  transport.onmessage = (event) => {
    const message = event.data as TransportRequestMessage | undefined;
    if (message === undefined || message.type !== "transport-request") return;
    void answer(message);
  };

  async function answer(message: TransportRequestMessage): Promise<void> {
    let reply: TransportReplyMessage;
    try {
      const response = await runtime.gateway.handle({
        method: message.request.method,
        url: message.request.url,
        // The shim's wire headers are already a plain record, so the boundary needs no conversion in either direction.
        headers: message.request.headers,
        body: message.request.body,
      });
      reply = {
        type: "transport-reply",
        id: message.id,
        response: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: response.body,
        },
      };
    } catch (error) {
      reply = { type: "transport-error", id: message.id, reason: (error as Error)?.message ?? String(error) };
    }
    transport?.postMessage(reply);
  }
}
