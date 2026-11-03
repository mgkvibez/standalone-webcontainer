/**
 * The unified `Runtime` interface (ADR-0001: both lanes sit behind one
 * interface) and the Phase-1 in-process implementation.
 *
 * HONEST LIMITATION, stated here rather than discovered later: an in-process
 * runtime cannot preempt synchronous user code. `while (true) {}` will hang this
 * process. Timeout enforcement is therefore the WORKER's job — ADR-0002 #2 puts
 * the runtime in a dedicated worker precisely so `terminate()` exists. The
 * `timeoutMs` option below bounds async gaps only, and says so in its result.
 */
import { Buffer } from "buffer";

import { EventEmitter } from "../shims/events.js";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
  type RequestListener,
} from "../shims/http.js";
import { PortRegistry } from "../network/port-registry.js";
import { PreviewGateway } from "../network/preview-gateway.js";
import { createFsShim, type FsShim } from "../shims/fs.js";
import { path } from "../shims/path.js";
import { createProcessShim, createSink, ProcessExit, type ProcessShim } from "../shims/process.js";
import { FileSystem } from "../vfs/index.js";
import { CommonJsLoader } from "./commonjs.js";

export interface RunOptions {
  /** Bounds awaits only; synchronous loops cannot be interrupted in-process. */
  readonly timeoutMs?: number;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when an async gap exceeded `timeoutMs`; sync hangs cannot set this. */
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface Runtime {
  run(entryPath: string, options?: RunOptions): Promise<ExecutionResult>;
}

export interface InProcessRuntimeOptions {
  /**
   * The port namespace this runtime binds into. Supplied so several runtimes in one page cannot see each
   * other's preview servers; a private one is created when omitted.
   */
  readonly registry?: PortRegistry;
}

export class InProcessRuntime implements Runtime {
  readonly #vfs: FileSystem;
  readonly #registry: PortRegistry;
  readonly #gateway: PreviewGateway;

  constructor(vfs: FileSystem, options: InProcessRuntimeOptions = {}) {
    this.#vfs = vfs;
    this.#registry = options.registry ?? new PortRegistry();
    this.#gateway = new PreviewGateway({ registry: this.#registry });
  }

  /**
   * The gateway a service worker calls. Exposed because the runtime is the only owner of both the port
   * registry and the module loader: a server created by user code is registered here, so routing it
   * requires this gateway rather than a second one that would see a different registry.
   */
  get gateway(): PreviewGateway {
    return this.#gateway;
  }

  /** The port namespace in use, for callers that need to inspect bindings. */
  get ports(): PortRegistry {
    return this.#registry;
  }

  async run(entryPath: string, options: RunOptions = {}): Promise<ExecutionResult> {
    const started = Date.now();
    const stdout = createSink();
    const stderr = createSink();
    const processShim: ProcessShim = createProcessShim({
      argv: options.argv !== undefined ? [...options.argv] : ["node", entryPath],
      env: options.env ?? {},
      stdout,
      stderr,
    });

    const consoleShim = {
      log: (...args: unknown[]) => {
        stdout.write(`${args.map((value) => formatForConsole(value)).join(" ")}\n`);
      },
      error: (...args: unknown[]) => {
        stderr.write(`${args.map((value) => formatForConsole(value)).join(" ")}\n`);
      },
      warn: (...args: unknown[]) => {
        stderr.write(`${args.map((value) => formatForConsole(value)).join(" ")}\n`);
      },
      info: (...args: unknown[]) => {
        stdout.write(`${args.map((value) => formatForConsole(value)).join(" ")}\n`);
      },
    };

    const fsShim: FsShim = createFsShim(this.#vfs);
    const loader = new CommonJsLoader({
      fs: fsShim,
      builtins: {
        fs: fsShim,
        path,
        process: processShim,
        buffer: { Buffer },
        events: { EventEmitter },
        // A per-runtime facade rather than the module itself: `createServer` must bind into THIS runtime's
        // registry and attach to THIS runtime's gateway, or a script's server would listen and never be
        // routable. Exported classes are passed through so `instanceof` still works for user code.
        http: {
          createServer: (handler?: RequestListener): Server => {
            const server = createServer(handler, { registry: this.#registry });
            this.#gateway.attach(server);
            return server;
          },
          Server,
          IncomingMessage,
          ServerResponse,
        },
      },
    });
    loader.setRuntimeContext({ process: processShim, console: consoleShim, Buffer });

    const execute = (): number => {
      try {
        loader.loadFile(path.resolve(entryPath));
        return 0;
      } catch (error) {
        if (error instanceof ProcessExit) return error.code;
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        stderr.write(`${message}\n`);
        return 1;
      }
    };

    let exitCode: number;
    let timedOut = false;

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      // Race only the boundary between turns: `execute` runs synchronously, so if
      // it finishes the timer is cleared; if it hangs, nothing here can help.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
      });
      const outcome = await Promise.race([Promise.resolve(execute()), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout") {
        timedOut = true;
        exitCode = 124; // coreutils convention for a timed-out command
      } else {
        exitCode = outcome;
      }
    } else {
      exitCode = execute();
    }

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      timedOut,
      durationMs: Date.now() - started,
    };
  }
}

/** `console.log` formatting for the values a script realistically prints. */
const formatForConsole = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value instanceof Uint8Array) return `<Buffer ${Array.from(value).join(" ")}>`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
