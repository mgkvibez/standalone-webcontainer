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
// P3-0: importing this module IS the capture. It runs during module evaluation, before the start message can arrive and
// before the loader compiles user code, so no user code can observe a realm that was not captured. Nothing is attached to
// globalThis and nothing is added to the facade: the bindings stay in that module's scope for the phases that restrict
// ambient capabilities. This is preparation, not isolation - user code shares this realm either way.
import "./quarantine.js";
import { removeAmbientCapabilities } from "./ambient-removal.js";
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
   * The trusted control channel, created by the host and transferred here.
   *
   * Everything the kernel believes about this process travels on it: output, exit, failure, the scheduler record and the port report.
   * The ordinary Worker channel is bootstrap only and is blinded the moment this port is in hand (see `scope.onmessage`), because
   * `postMessage` on it is reachable by user code and a forged `exit` used to settle the kernel with whatever status the program liked.
   *
   * A session token rides on every control message as WELL as the port, and it is freshness, not authentication: the port is the
   * authority (user code cannot reach a closure), and the token stops a port left over from an older process being believed by a
   * newer one that inherited the pid. Neither is asked to do the other's job.
   */
  readonly control: MessagePortLike;
  /** Freshness token for the control channel; see `control`. */
  readonly session: string;
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

/**
 * The private control channel, captured in module scope and never published.
 *
 * Not on the global, not in a shim, not in an export: user code reaches this only if it can read a closure, which JS does not allow.
 * `sendControl` is the single outbound door, so a future message type cannot accidentally travel on the forgeable channel.
 */
let control: MessagePortLike | null = null;

/** The session this Worker was booted with. Stamped on every outbound control message; the host refuses a mismatch. */
let session: string | null = null;

/**
 * The single outbound door for trusted process control.
 *
 * Every message carries the session it belongs to. The port is the authority - user code cannot reach this closure - and the session is
 * freshness: a port left over from an earlier process cannot be believed by a newer one, and the host checks both before it reads a field.
 */
function sendControl(message: object): void {
  control?.postMessage({ ...(message as Record<string, unknown>), session });
}

scope.onmessage = (event) => {
  const message = event.data;
  // Bootstrap only. Keystrokes and resizes used to arrive here; they moved to the control channel in W-19 P2, because a channel user
  // code can post on must never carry anything the kernel trusts. Anything except the first `start` is ignored, and the handler is
  // cleared once the port is in hand, so a program that reassigns `globalThis.onmessage` is talking to nobody.
  if (message?.type !== "start") return;
  // FAIL CLOSED. A Worker booted without the control port cannot report anything the kernel would believe, so it must not pretend
  // to run. Throwing here is a real error event on this Worker and the host turns that into a `failed` process; reporting the
  // problem over the ordinary channel instead would be the forgery path this channel exists to close.
  const bootstrap = message as { readonly control?: { readonly postMessage?: unknown } };
  if (bootstrap.control === undefined || typeof bootstrap.control.postMessage !== "function") {
    throw new Error("process bootstrap: the control port is missing, so this process cannot be supervised");
  }
  scope.onmessage = null;

  // Deliberately not awaited into a promise chain nobody observes: a rejection inside an async handler is invisible
  // outside this Worker (no `onerror` fires), which is how a silent process death looks like a hung test. Everything is
  // caught and reported as a message.
  void run(message);
};

async function run(start: StartMessage): Promise<void> {
  try {
    // FIRST, before anything can post: the port is in hand and the ordinary channel is already blinded by `scope.onmessage`.
    control = start.control;
    session = start.session;
    control.onmessage = (event) => {
      const message = event.data as { readonly type?: unknown; readonly text?: unknown; readonly columns?: unknown; readonly rows?: unknown };
      if (message?.type === "input" && typeof message.text === "string") {
        terminal?.write(message.text);
        return;
      }
      if (message?.type === "resize" && typeof message.columns === "number" && typeof message.rows === "number") {
        terminal?.resize(message.columns, message.rows);
      }
    };
    // P3-1: the control channel is installed, so the bootstrap has done everything it needs the ambient globals for, and no
    // user code has run yet. Capabilities go now - after the port, before the program - because removing them earlier would
    // break the bootstrap and removing them later would leave a window a program could use.
    removeAmbientCapabilities();

    const client = new SyscallClient({ buffer: start.buffer, sizes: start.sizes });
    const fs = createRemoteFileSystem(client, { timeoutMs: SYSCALL_TIMEOUT_MS });
    // Watching from inside a process is pulled over the same channel as everything else: the kernel owns the registry, this
    // Worker owns the polling client. A local source here would watch a filesystem this Worker does not have.
    const transport = start.transport;
    const registry = new ReportingPortRegistry((ports) => {
      const message: ProcessToKernelMessage = { type: "ports", ports };
      sendControl(message);
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
      sendControl({ type: "failed", reason: "no entry script in argv" });
      return;
    }

    const result = await runtime.run(entry, {
      argv: [...start.argv],
      ...(start.env === undefined ? {} : { env: start.env }),
      ...(start.cwd === undefined ? {} : { cwd: start.cwd }),
      onOutput: (channel, text) => {
        sendControl({ type: "output", channel, text });
      },
      // W-41: ADR-0035 records a throw that lands after the result was handed back, but a held-open process is still
      // `running` in the table, so the row would keep describing a crashed server as healthy. This is the only route from
      // that record to the kernel, and it is the same record - not a second opinion about what happened.
      onAfterRunFailure: (failure) => {
        sendControl({ type: "failed", reason: `${failure.name}: ${failure.message}`.replace(/^Error: Error: /, "Error: ") });
      },
      ...(terminal === null ? {} : { terminal }),
    });

    if (result.scheduler !== undefined) sendControl({ type: "scheduler", evidence: result.scheduler });
    // The refusal is copied into the message as plain data. Structured clone strips the freeze, so the far side re-freezes it through
    // `createRefusal`; what must NOT happen is the far side reading stderr and deciding for itself, which is how this got lost.
    sendControl({
      type: "exit",
      code: result.exitCode,
      ...(result.refusal === undefined ? {} : { refusal: { ...result.refusal } }),
    });
  } catch (error) {
    sendControl({ type: "failed", reason: (error as Error)?.message ?? String(error) });
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
