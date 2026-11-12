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
  TransportEvent,
  TransportEventMessage,
  TransportReplyMessage,
  TransportRequestMessage,
} from "./process-transport.js";
import { createRemoteWatcher, realTimerScheduler } from "./remote-watch.js";
import { InProcessRuntime } from "../runtime/in-process.js";
import { createTerminal, type Terminal } from "../terminal/pty.js";

interface ProcessScope {
  onmessage: ((event: MessageEvent<StartMessage | InputMessage | ResizeMessage>) => void) | null;
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
  /**
   * Terminal dimensions. The Terminal object is built HERE, beside the program that reads it, and keystrokes arrive as messages.
   *
   * Absent means the program has no terminal, which is the ordinary case for a fixture step or a build.
   */
  readonly terminal?: { readonly columns: number; readonly rows: number };
}

/** Typed text on its way to the program's stdin. Addressed to one Worker, so no pid is needed on the wire. */
interface InputMessage {
  readonly type: "input";
  readonly text: string;
}

interface ResizeMessage {
  readonly type: "resize";
  readonly columns: number;
  readonly rows: number;
}

export type ProcessMessage =
  | { readonly type: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "failed"; readonly reason: string }
  /**
   * The scheduler's evidence for this program's run, sent before the exit so a command boundary can report it.
   *
   * It has to cross the boundary as data because the object lives beside the program: the page has no access to the queue that actually
   * ran the timers, and a result field filled with a guess would be worse than an absent one.
   */
  | { readonly type: "scheduler"; readonly evidence: unknown };

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

/**
 * The live terminal, once the program has one.
 *
 * Module scope rather than a local in `run` because input arrives as its own message, possibly before the program has even started
 * listening for keys. Writing to a terminal before the program reads it is not lost: the pty buffers.
 */
let terminal: Terminal | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "input") {
    terminal?.write(message.text);
    return;
  }
  if (message?.type === "resize") {
    terminal?.resize(message.columns, message.rows);
    return;
  }
  if (message?.type !== "start") return;

  // Deliberately not awaited into a promise chain nobody observes: a rejection inside an async handler is invisible
  // outside this Worker (no `onerror` fires), which is how a silent process death looks like a hung test. Everything is
  // caught and reported as a message.
  void run(message);
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
    terminal = start.terminal === undefined ? null : createTerminal(start.terminal);

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
      ...(terminal === null ? {} : { terminal }),
    });

    if (result.scheduler !== undefined) scope.postMessage({ type: "scheduler", evidence: result.scheduler });
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
    // Every response leaves this Worker as it is written. There is no case for buffering here any more: the kernel decides whether a
    // caller wants events, and a sink nothing forwards is cheaper than a body copied twice for a stream nobody can see.
    const sink = message.stream === true
      ? (event: TransportEvent): void => {
        transport?.postMessage({ type: "transport-event", id: message.id, event } satisfies TransportEventMessage);
      }
      : undefined;
    try {
      const response = await runtime.gateway.handle({
        method: message.request.method,
        url: message.request.url,
        // The shim's wire headers are already a plain record, so the boundary needs no conversion in either direction.
        headers: message.request.headers,
        body: message.request.body,
      }, sink);
      reply = {
        type: "transport-reply",
        id: message.id,
        response: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: response.body,
          ...(response.streamed === true ? { streamed: true } : {}),
        },
      };
    } catch (error) {
      reply = { type: "transport-error", id: message.id, reason: (error as Error)?.message ?? String(error) };
    }
    transport?.postMessage(reply);
  }
}
