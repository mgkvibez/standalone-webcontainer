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
  KernelToProcessMessage,
  MessagePortLike,
  ProcessToKernelMessage,
  TransportEvent,
  TransportEventMessage,
  TransportReplyMessage,
  TransportRequestMessage,
  TransportSocketOpenMessage,
  TransportSocketUpstreamMessage,
} from "./process-transport.js";
import { relaySocket } from "./process-transport.js";
import { createRemoteWatcher, realTimerScheduler } from "./remote-watch.js";
import { InProcessRuntime } from "../runtime/in-process.js";
import type { Refusal } from "../runtime/refusal.js";
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
  /**
   * The process settled, with the status it left behind.
   *
   * `refusal` is present only when the runtime declined a capability on purpose and the program did not handle it (ADR-0014). It travels as
   * the refusal's own fields - code, capability, message, subject - and never as a sentence folded into stderr: the receiving side has to be
   * able to tell a by-design refusal from a crash, and a message it must parse cannot do that.
   */
  | { readonly type: "exit"; readonly code: number; readonly refusal?: Refusal }
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
    // The refusal is copied into the message as plain data. Structured clone strips the freeze, so the far side re-freezes it through
    // `createRefusal`; what must NOT happen is the far side reading stderr and deciding for itself, which is how this got lost.
    scope.postMessage({
      type: "exit",
      code: result.exitCode,
      ...(result.refusal === undefined ? {} : { refusal: { ...result.refusal } }),
    });
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
  /** Connections the kernel opened, by id, so a byte can find the socket it belongs to. */
  const relayed = new Map<number, (message: { readonly type: string; readonly data?: unknown; readonly reason?: unknown }) => void>();
  transport.onmessage = (event) => {
    const message = event.data as KernelToProcessMessage | undefined;
    if (message === undefined) return;
    if (message.type === "socket-open") {
      accept(message, relayed);
      return;
    }
    if (message.type === "socket-data" || message.type === "socket-end" || message.type === "socket-close") {
      const deliver = relayed.get(message.id);
      if (deliver === undefined) return;
      if (message.type === "socket-close") relayed.delete(message.id);
      // Narrowed explicitly: the union distinguishes the three by which fields they carry, and the relay reads them by name.
      deliver({
        type: message.type,
        ...("data" in message ? { data: message.data } : {}),
        ...("reason" in message ? { reason: message.reason } : {}),
      });
      return;
    }
    if (message.type !== "transport-request") return;
    void answer(message);
  };

  /**
   * Hand the connection to the program's own listener, through the same gateway a request goes through.
   *
   * The gateway's `upgrade` is the door ADR-0031 built, so nothing here re-implements the routing decision: this Worker owns the port registry
   * and the loader, and the gateway reads both. The refusal it returns is forwarded verbatim, because its two reasons ("nothing is listening"
   * and "no upgrade listener") are what a user needs told apart.
   */
  function accept(
    message: TransportSocketOpenMessage,
    relayed: Map<number, (message: { readonly type: string; readonly data?: unknown; readonly reason?: unknown }) => void>,
  ): void {
    const result = runtime.gateway.upgrade({ protocol: "http", port: message.port, path: message.path }, message.headers);
    if (!result.accepted) {
      transport?.postMessage({ type: "socket-refused", id: message.id, reason: result.reason } satisfies TransportSocketUpstreamMessage);
      return;
    }
    // `result.socket` is the kernel's end of the pair; the handler holds the other one. Relaying THIS end is what makes the two sides the same
    // code, and it is also why the handler's `101` is not lost: it is already queued here, and attaching the listener drains it.
    const deliver = relaySocket(result.socket, (reply) => transport?.postMessage(reply), message.id);
    relayed.set(message.id, deliver);
    // Accepted AFTER the relay is attached and BEFORE any byte can arrive: the kernel holds bytes until this message lands, so the ordering is
    // what guarantees the handshake cannot be delivered to a socket whose reader was not listening yet.
    transport?.postMessage({ type: "socket-accepted", id: message.id } satisfies TransportSocketUpstreamMessage);
  }

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
