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
import { createCountedWatchSource } from "../vfs/watch-iterator.js";
import { createLocalWatchSource, type WatchableFileSystem } from "../process/local-watch.js";
import type { WatchSourcePort } from "../vfs/port.js";
import { Duplex, PassThrough, pipeline, Readable, Transform, Writable } from "../shims/stream.js";
import { path } from "../shims/path.js";
import { createProcessShim, createSink, ProcessExit, type ProcessShim } from "../shims/process.js";
import { TickQueue } from "./ticks.js";
import {
  installDependencies,
  loadLockfile,
  readPackageManifest,
  type InstallReport,
  type PackageManifest,
  type RegistryClient,
} from "../npm/install.js";
import type { FileSystemPort } from "../vfs/port.js";
import { CommonJsLoader, type RuntimeGlobals } from "./commonjs.js";
import { createVirtualDate, createVirtualPerformance, Scheduler, type SchedulerEvidence, type TimerHandle } from "./scheduler.js";
import { ProcessRefusal, type Refusal } from "./refusal.js";

export interface RunOptions {
  /** Bounds awaits only; synchronous loops cannot be interrupted in-process. */
  readonly timeoutMs?: number;
  /**
   * Called with each chunk as the program writes it. Additive: when absent, behaviour is byte-identical to before.
   * Used by the container layer to feed a live terminal instead of waiting for the run to finish.
   */
  readonly onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /**
   * Working directory for the program, which is what a relative `fs` path resolves against and what `process.cwd()`
   * reports. Node takes it from the shell; a fixture step takes it from the project root it runs in.
   */
  readonly cwd?: string;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Let queued promise continuations finish, then return.
 *
 * A macrotask boundary, deliberately, not `await Promise.resolve()`: one microtask hop only lets the FIRST continuation
 * run, so a `.then` that queues another `.then` would still be pending. The microtask queue is empty by the time a timer
 * callback runs, which is the one cheap guarantee available in both a browser and Node.
 *
 * This waits for continuations only. Timers are the scheduler's job (`Scheduler.drain`), which runs after this so that
 * microtasks keep their Node precedence over timers.
 */
async function drainAfterEvaluation(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface ExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when an async gap exceeded `timeoutMs`; sync hangs cannot set this. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  /**
   * Why the timer queue stopped, and what it consumed (ADR-0013 amendment 2). Always present: a program that scheduled
   * nothing reports `queue-empty` with zero callbacks, which is evidence rather than an absence.
   */
  readonly scheduler: SchedulerEvidence;

  /**
   * Present only when an UNHANDLED refusal ended the program (ADR-0014). A program that caught the refusal and carried
   * on has none: it handled the refusal, so there is nothing to classify.
   */
  readonly refusal?: Refusal;}

export interface Runtime {
  run(entryPath: string, options?: RunOptions): Promise<ExecutionResult>;
}

export interface InstallIntoRuntimeOptions {
  /** Where packuments and tarballs come from. Injected, so nothing here reaches the network on its own. */
  readonly registry: RegistryClient;
  /** Project root in the VFS. Defaults to `/app`, which is where `run` resolves entry paths from. */
  readonly root?: string;
  /** Use this manifest instead of reading `<root>/package.json`. */
  readonly manifest?: PackageManifest;
  readonly includeDev?: boolean;
  /** Defaults to true, matching npm: an install updates the lockfile. */
  readonly writeLockfile?: boolean;
  readonly maxPackages?: number;
}

/** A port is only locally watchable if it can subscribe; a channel-backed client cannot and says so. */
const isWatchable = (vfs: FileSystemPort): vfs is FileSystemPort & WatchableFileSystem =>
  typeof (vfs as { subscribe?: unknown }).subscribe === "function";

export interface InProcessRuntimeOptions {
  /**
   * The port namespace this runtime binds into. Supplied so several runtimes in one page cannot see each
   * other's preview servers; a private one is created when omitted.
   */
  readonly registry?: PortRegistry;
  /**
   * Where `fs.watch` comes from.
   *
   * A runtime that OWNS its filesystem gets a local source built for it. A process Worker does not own the filesystem — the
   * kernel does — so it supplies a channel-backed source instead, and this is the seam that lets both use one shim without
   * the shim knowing which kind of runtime it is inside.
   */
  readonly watches?: WatchSourcePort;
}

export class InProcessRuntime implements Runtime {
  readonly #vfs: FileSystemPort;
  readonly #registry: PortRegistry;
  readonly #gateway: PreviewGateway;
  readonly #watches: WatchSourcePort | undefined;

  constructor(vfs: FileSystemPort, options: InProcessRuntimeOptions = {}) {
    this.#vfs = vfs;
    this.#registry = options.registry ?? new PortRegistry();
    this.#gateway = new PreviewGateway({ registry: this.#registry });
    this.#watches = options.watches;
  }

  /**
   * The gateway a service worker calls. Exposed because the runtime is the only owner of both the port
   * registry and the module loader: a server created by user code is registered here, so routing it
   * requires this gateway rather than a second one that would see a different registry.
   */
  get gateway(): PreviewGateway {
    return this.#gateway;
  }

  /**
   * Read a text file from this runtime's VFS, or null when it is absent.
   *
   * Exists for tooling that has to inspect the project the runtime owns (npm scripts, `bin` entries, fixture files).
   * Every failure is reported as "absent" on purpose: this is a probe, and its callers already have a designed answer
   * for a missing file. Anything that needs to distinguish EACCES from ENOENT should use the VFS directly.
   */
  readFileText(path: string): string | null {
    try {
      const contents = this.#vfs.readFileSync(path, "utf8");
      return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
    } catch {
      return null;
    }
  }

  /** List a directory in this runtime's VFS, or an empty list when it cannot be read. Same contract as above. */
  readDirNames(path: string): readonly string[] {
    try {
      return this.#vfs.readdirSync(path);
    } catch {
      return [];
    }
  }

  /** The port namespace in use, for callers that need to inspect bindings. */
  get ports(): PortRegistry {
    return this.#registry;
  }

  /**
   * Install dependencies into this runtime's VFS, the way `npm install` would in `<root>`.
   *
   * This lives on the runtime rather than beside it for one reason: the loader resolves `require` against THIS
   * VFS, so an install into a different one produces packages that exist and are unreachable. Owning the VFS is
   * what makes the composition correct by construction.
   *
   * npm semantics are followed where they matter: an existing `package-lock.json` pins the tree and is read
   * automatically, and the lockfile is rewritten afterwards. Reading it automatically is the difference between
   * `npm install` and `npm install --no-package-lock`, and it is what makes a second install offline-capable.
   */
  async install(options: InstallIntoRuntimeOptions): Promise<InstallReport> {
    const root = options.root ?? "/app";
    const manifest = options.manifest ?? readPackageManifest(this.#vfs, root);
    return installDependencies(manifest, {
      registry: options.registry,
      vfs: this.#vfs,
      root,
      lockfile: loadLockfile(this.#vfs, root),
      // npm installs devDependencies by default; --omit=dev is the opt-out. The installer's own default is the
      // conservative one (top-level callers say what they mean), and the facade restores npm's behaviour here so
      // that a project's own install brings its test tooling with it.
      includeDev: options.includeDev ?? true,
      ...(options.writeLockfile === undefined ? {} : { writeLockfile: options.writeLockfile }),
      ...(options.maxPackages === undefined ? {} : { maxPackages: options.maxPackages }),
    });
  }

  async run(entryPath: string, options: RunOptions = {}): Promise<ExecutionResult> {
    const started = Date.now();
    const onOutput = options.onOutput;
    const stdout = createSink(onOutput === undefined ? undefined : (text) => onOutput("stdout", text));
    const stderr = createSink(onOutput === undefined ? undefined : (text) => onOutput("stderr", text));
    const cwd = options.cwd ?? "/";
    const ticks = new TickQueue();
    const processShim: ProcessShim = createProcessShim({
      argv: options.argv !== undefined ? [...options.argv] : ["node", entryPath],
      cwd,
      env: options.env ?? {},
      stdout,
      stderr,
      ticks,
    });

    // One scheduler per execution, created before any user code runs: its construction is the wall-clock baseline both
    // Date.now() and performance.timeOrigin are measured from (ADR-0013 amendment 2).
    // One watch source per execution, counted, because the scheduler has to know whether anything is still outstanding: an
    // open watcher is a reference that keeps the loop alive, exactly as in Node.
    //
    // A process Worker does not own the filesystem (the kernel does), so it supplies a channel-backed source. A runtime that
    // does own it gets a local one. A port that can do neither leaves watching unavailable, and the shim refuses by name
    // rather than handing back a watcher that never fires.
    const counted =
      this.#watches !== undefined
        ? createCountedWatchSource(this.#watches)
        : isWatchable(this.#vfs)
          ? createCountedWatchSource(createLocalWatchSource(this.#vfs))
          : undefined;
    const scheduler = new Scheduler({ keepAlive: counted?.open ?? ((): number => 0) }, (error: unknown) => {
      // Node would kill the process. Killing the run would make one bad callback look like a broken harness, so the error
      // is reported on stderr and draining continues deterministically.
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      stderr.write(`Uncaught ${message}\n`);
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

    const fsShim: FsShim = createFsShim(this.#vfs, {
      cwd,
      ...(counted === undefined ? {} : { watches: counted.source }),
    });
    const loader = new CommonJsLoader({
      fs: fsShim,
      builtins: {
        fs: fsShim,
        path,
        process: processShim,
        buffer: { Buffer },
        events: { EventEmitter },
        // ADR-0015's six classes plus pipeline. Real behaviour, not import-only stubs: fixture 4 fails on this import alone,
        // and a stub would turn four honest failures into four unexplained ones.
        stream: { Readable, Writable, Duplex, Transform, PassThrough, pipeline },
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
    loader.setRuntimeContext({
      process: processShim,
      console: consoleShim,
      Buffer,
      globals: {
        Date: createVirtualDate(() => scheduler.now()),
        performance: createVirtualPerformance(scheduler),
        setTimeout: ((fn: (...args: never[]) => void, delay?: number, ...args: unknown[]) =>
          scheduler.setTimeout(fn, delay ?? 0, ...args)) as RuntimeGlobals["setTimeout"],
        setInterval: ((fn: (...args: never[]) => void, delay?: number, ...args: unknown[]) =>
          scheduler.setInterval(fn, delay ?? 0, ...args)) as RuntimeGlobals["setInterval"],
        clearTimeout: ((handle: TimerHandle | number) => scheduler.clear(handle)) as RuntimeGlobals["clearTimeout"],
        clearInterval: ((handle: TimerHandle | number) => scheduler.clear(handle)) as RuntimeGlobals["clearInterval"],
        setImmediate: ((fn: (...args: never[]) => void, ...args: unknown[]) =>
          scheduler.setImmediate(fn, ...args)) as RuntimeGlobals["setImmediate"],
      },
    });

    let capturedRefusal: Refusal | undefined;

    const execute = (): number => {
      try {
        loader.loadFile(path.resolve(entryPath));
        return 0;
      } catch (error) {
        if (error instanceof ProcessExit) return error.code;
        if (error instanceof ProcessRefusal) {
          // Unhandled: it escaped evaluation, so it terminated the program and the step is a refusal, not a failure.
          capturedRefusal = error.refusal;
          stderr.write(`${error.stack ?? error.message}\n`);
          return 1;
        }
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        stderr.write(`${message}\n`);
        return 1;
      }
    };

    // The program body, plus the tick drain that Node performs at the end of the turn. The flush is in `finally` so it
    // still runs when the body throws or calls process.exit, both of which leave queued ticks behind.
    const runBody = (): number => {
      try {
        return execute();
      } finally {
        ticks.flushNow();
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
      const outcome = await Promise.race([Promise.resolve(runBody()), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout") {
        timedOut = true;
        exitCode = 124; // coreutils convention for a timed-out command
      } else {
        exitCode = outcome;
      }
    } else {
      exitCode = runBody();
    }

    // The timer queue runs to termination BEFORE the output is read, and before the continuation drain: a callback that
    // logs, and a `.then` inside that callback, must both be in the snapshot (ADR-0013 amendment 2).
    if (!timedOut) {
      try {
        // Promise continuations settle BEFORE the timer queue. Node runs every microtask before the first timer callback,
        // so a `.then` chain must complete even when the timer was registered first. The old order drained timers first
        // and made `m1,timer,m2` out of a program Node runs as `m1,m2,timer` (differential case
        // `microtask-starvation`). The boundary is a macrotask, which lets the whole chain run rather than one hop.
        await drainAfterEvaluation();
        // Then the timer queue, which drains to quiescence internally and lets continuations run between its passes
        // (fixture 4 schedules its timer from a `pipeline` callback, which is the case a single pass missed).
        await scheduler.drain();
        // Ticks queued by a timer callback keep their precedence over the microtasks that follow it.
        ticks.flushNow();
        // Callbacks that logged, and any continuation they queued, are only in the snapshot after this. Without it,
        // `console.log` inside a `.then` wrote into a sink nobody had read yet, which is indistinguishable from the
        // program printing nothing (ADR-0013).
        await drainAfterEvaluation();
      } catch (error) {
        // A throw from inside a callback or continuation belongs to THIS run. Letting it escape became an uncaught
        // exception that killed the harness process, which would have taken every later fixture down with it.
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        stderr.write(`${message}\n`);
        exitCode = 1;
      }
    }

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      timedOut,
      durationMs: Date.now() - started,
      scheduler: scheduler.evidence,
      // Spread rather than `refusal: undefined`, so the field is absent instead of present-and-empty.
      ...(capturedRefusal === undefined ? {} : { refusal: capturedRefusal }),
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
