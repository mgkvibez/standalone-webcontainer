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

import { eventsModule } from "../shims/events.js";
import {
  createServer,
  IncomingMessage,
  METHODS,
  STATUS_CODES,
  Server,
  ServerResponse,
  type RequestListener,
} from "../shims/http.js";
import { PortRegistry } from "../network/port-registry.js";
import { PreviewGateway } from "../network/preview-gateway.js";
import { createFsShim, type FsShim } from "../shims/fs.js";
import { pendingAsyncWork } from "./async-work.js";
import type { SchedulerStop } from "./scheduler.js";
import { watchUnhandledRejections } from "./unhandled-rejections.js";
import { createCountedWatchSource } from "../vfs/watch-iterator.js";
import { createLocalWatchSource, type WatchableFileSystem } from "../process/local-watch.js";
import type { WatchSourcePort } from "../vfs/port.js";
import { Duplex, PassThrough, pipeline, Readable, Stream, Transform, Writable } from "../shims/stream.js";
import { path } from "../shims/path.js";
import { createProcessShim, createSink, ProcessExit, type ProcessShim } from "../shims/process.js";
import { createTtyShim } from "../shims/tty.js";
import assertModule from "../shims/assert.js";
import asyncHooks from "../shims/async-hooks.js";
import crypto from "../shims/crypto.js";
import https from "../shims/https.js";
import net from "../shims/net.js";
import { createModuleShim } from "../shims/module.js";
import { createOsShim } from "../shims/os.js";
import { createPerfHooksShim } from "../shims/perf-hooks.js";
import querystring from "../shims/querystring.js";
import stringDecoder from "../shims/string-decoder.js";
import childProcess from "../shims/child_process.js";
import dns from "../shims/dns.js";
import readline from "../shims/readline.js";
import tls from "../shims/tls.js";
import v8 from "../shims/v8.js";
import workerThreads from "../shims/worker_threads.js";
import url from "../shims/url.js";
import util from "../shims/util.js";
import zlib from "../shims/zlib.js";
import type { Terminal } from "../terminal/pty.js";
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
import { createCompleteHostFs, hostFsSourceFrom } from "./host-fs.js";
import { createRealmGlobals } from "./realm-globals.js";
import { createVirtualDate, createVirtualPerformance, Scheduler, type SchedulerEvidence, type TimerHandle } from "./scheduler.js";
import { ProcessRefusal, type Refusal } from "./refusal.js";

/**
 * Stop reasons that mean "the program had work left and a guard ended it".
 *
 * `queue-empty` and `no-refs-left` are not here on purpose: those are Node's own endings, where a suspended entry promise is dropped because
 * nothing could ever resume it, and Node exits 0. Everything in this set is a program Node would still be running, so it is reported as a timeout.
 */
const UNFINISHED_STOPS: ReadonlySet<SchedulerStop> = new Set(["budget-exhausted", "callback-limit", "real-time-limit"]);

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
  /**
   * The terminal this program talks to, if it has one.
   *
   * Absent by default, and that absence is meaningful: a fixture, a test and a piped worker all run with
   * `process.stdin === null` and `tty.isatty()` false, which is the truthful answer for a program with no terminal. Passing
   * one makes `process.stdin`, `process.stdout.isTTY`, `process.stdout.columns` and the resize/interrupt signals real.
   *
   * The terminal is owned by the CALLER, not by the run: a UI keeps one across many programs, so its size and its buffered
   * input survive the exit of the program that was reading them.
   */
  readonly terminal?: Terminal;
  /**
   * Ceiling on real time spent WORKING, in milliseconds. Time spent waiting for input or a watcher is excluded, so this bounds
   * a spinning program rather than a patient one.
   *
   * Exposed for two reasons: a host may want a tighter bound than the default, and the exclusion itself is only observable with a
   * small one. Passing nothing keeps the scheduler's default.
   */
  readonly workCeilingMs?: number;
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
    const terminal = options.terminal ?? null;
    /**
     * `process.exit` is immediate in Node, and it is called from places this runtime does not control: a timer callback, or a
     * stdin handler that runs while the queue is idle. Both routes land here, record the code, and stop the scheduler, so no
     * timer queued before the exit still runs and the run reports the program's code rather than an uncaught exception.
     */
    let exitRequested: number | undefined;
    const requestExit = (code: number): void => {
      if (exitRequested !== undefined) return;
      exitRequested = code;
      scheduler.abort();
    };

    /**
     * A rejection nobody handles is a program failure, and Node's default answer to one is exit 1, not a quiet death.
     *
     * Measured: vite called `process.exit(1)` from an async continuation nobody awaited. The rejection belonged to no promise the
     * runtime held, so it escaped the program and killed the host process in Node, while a browser would have logged it as the page's
     * own. Worse, the run had already been reported as `exit 0`. Registering the host's `unhandledRejection` handler is what stops
     * that crash, and the reason is reported in the same shape an uncaught exception gets, which is the shape Node prints.
     */
    const rejections = watchUnhandledRejections((reason: unknown) => {
      const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      stderr.write(`Uncaught ${message}\n`);
      requestExit(1);
    });

    /**
     * Wraps stdin's listeners so an exit thrown from one stays inside the run.
     *
     * Input is delivered by the caller (`terminal.write`), which is not a scheduler callback: without this wrapper a
     * `process.exit` inside a `data` handler escaped into whoever delivered the keystroke, which in the browser is a worker
     * message handler that has no idea a program just ended.
     */
    const guardedStdin = (input: NonNullable<typeof terminal>["stdin"]): typeof input => {
      const wrappers = new WeakMap<object, object>();
      const wrap = (listener: unknown): unknown => {
        if (typeof listener !== "function") return listener;
        const existing = wrappers.get(listener as object);
        if (existing !== undefined) return existing;
        const wrapper = (...args: unknown[]): unknown => {
          try {
            return (listener as (...inner: unknown[]) => unknown)(...args);
          } catch (error) {
            if (error instanceof ProcessExit) {
              requestExit(error.code);
              return undefined;
            }
            throw error;
          }
        };
        wrappers.set(listener as object, wrapper);
        return wrapper;
      };
      return new Proxy(input, {
        get(target, property, receiver) {
          if (property === "on" || property === "once" || property === "off") {
            return (event: string, listener: unknown) => (target[property] as (e: string, l: unknown) => unknown)(event, wrap(listener));
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };

    const processShim: ProcessShim = createProcessShim({
      argv: options.argv !== undefined ? [...options.argv] : ["node", entryPath],
      cwd,
      env: options.env ?? {},
      stdout,
      stderr,
      ticks,
      terminal,
      stdin: terminal === null ? null : guardedStdin(terminal.stdin),
      onExit: requestExit,
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
    const scheduler = new Scheduler(
      {
        // A watcher and a waiting reader are both ref'd handles: either one keeps the loop alive, exactly as in Node. Without
        // the second term a program that only reads stdin exited before its first question could be answered.
        // ...and work that settles on a real thread (a wasm instantiation) is a ref'd handle too: esbuild-wasm's service is a Go program on a
        // WebAssembly.Module, and a build waiting for it must keep the process alive. Counted in async-work.ts, which explains why.
        keepAlive: () => (counted?.open() ?? 0) + (terminal?.stdin.live() === true ? 1 : 0) + pendingAsyncWork(),
        ...(options.workCeilingMs === undefined ? {} : { maxRealMs: options.workCeilingMs }),
      },
      (error: unknown) => {
        if (error instanceof ProcessExit) {
          // `process.exit` from a callback is not an uncaught exception: it is the program choosing its exit code, and nothing
          // queued before it may run.
          requestExit(error.code);
          return;
        }
        // Node would kill the process. Killing the run would make one bad callback look like a broken harness, so the error
        // is reported on stderr and draining continues deterministically.
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        stderr.write(`Uncaught ${message}\n`);
      },
    );

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
    // One clock instance, because `perf_hooks.performance` and the `performance` global must be the same object: a package that
    // measures itself would otherwise disagree with the scheduler its timers run on.
    const virtualPerformance = createVirtualPerformance(scheduler);
    // Annotated because the builtin table below closes over `loader` to reach `createRequire`, and inference cannot resolve a type
    // from a value that mentions itself.
    const loader: CommonJsLoader = new CommonJsLoader({
      fs: fsShim,
      builtins: {
        fs: fsShim,
        // Node makes these the same object, and vite relies on that shape: `fs.promises.readFile` and `require('fs/promises').readFile`
        // are called interchangeably across its chunks. One object, so they cannot diverge.
        "fs/promises": fsShim.promises,
        path,
        process: processShim,
        buffer: { Buffer },
        // The module IS the class, as in Node: vite's chunk writes `class WebSocket extends require$$0$7` after a default import from
        // `events`, and a namespace object fails there with "Class extends value #<Object> is not a constructor" despite the class
        // being present inside it. Same arrangement as `stream` below, for the same reason.
        events: eventsModule,
        // ADR-0015's six classes plus pipeline. Real behaviour, not import-only stubs: fixture 4 fails on this import alone,
        // and a stub would turn four honest failures into four unexplained ones.
        // `require("stream")` IS the legacy Stream constructor in Node, with the modern classes attached to it. Packages written
        // before Readable do `util.inherits(X, Stream)` and `Stream.call(this)`, so the module object itself must be callable.
        stream: Object.assign(Stream, { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline }),
        // Built from THIS run's terminal, so `tty.isatty(1)` answers about the terminal the program actually has rather than a
        // module-level guess. With no terminal every fd answers false, which is what Node reports for a pipe.
        tty: createTtyShim(terminal),
        // The builtins a real dependency graph requires, found by auditing express's 68 packages rather than by guessing
        // (tools/npm-audit-builtins.ts). Each is a real implementation or an honest refusal; see the file headers.
        zlib,
        util,
        crypto,
        querystring,
        url,
        string_decoder: stringDecoder,
        assert: assertModule,
        // Present because Node has it, refusing on every call because this runtime cannot spawn. The dependency chunk vite ships imports it at
        // module scope without ever asking to spawn on a boot path, which is not the same thing as needing a process.
        child_process: childProcess,
        // Node has it and vite imports it at module scope in three files. It answers IP literals and localhost and refuses everything else with a
        // typed ENOSYS, because there is no resolver in a browser sandbox and a made-up address would be worse than a refusal.
        dns,
        // The four vite's dependency chunk imports at module scope, each found by running it rather than by guessing: `v8` for a snapshot question,
        // `readline` for its banner and shortcut prompt, `tls` because its bundled HTTPS client requires it, and `worker_threads` for plugins that
        // ask for a worker. Each is a real answer where this runtime has one and a named refusal where it does not.
        v8,
        readline,
        tls,
        worker_threads: workerThreads,
        net,
        https,
        async_hooks: asyncHooks,
        // The front-end lane's first two modules, found by the same audit that ordered the express work, now extended to read ESM
        // specifiers as well: `import { performance } from "node:perf_hooks"` was invisible to a scan that only matched require().
        perf_hooks: createPerfHooksShim(virtualPerformance),
        // `createRequire` is what a modern ES module opens with. Both members resolve through the loader rather than duplicating its
        // table here, and the closures run long after the loader exists, so one source of truth is possible.
        module: createModuleShim({
          createRequire: (from) => loader.createRequire(from),
          builtinNames: () => loader.builtinNames(),
        }),
        os: createOsShim({ platform: processShim.platform, env: processShim.env }),
        // A per-runtime facade rather than the module itself: `createServer` must bind into THIS runtime's
        // registry and attach to THIS runtime's gateway, or a script's server would listen and never be
        // routable. Exported classes are passed through so `instanceof` still works for user code.
        http: {
          METHODS,
          STATUS_CODES,
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
    // Built first so the runtime's own global object can name itself: `self` is what a browser calls it, and a package that builds a scope
    // from `self` (the in-thread service inside esbuild-wasm) needs it to exist.
    // Written as a literal first so the object can name itself: `self` is what a browser calls this object, and a package that builds a scope
    // from `self` (the in-thread service inside esbuild-wasm) needs it to exist before it can enumerate anything.
    const runtimeGlobals = {
      Date: createVirtualDate(() => scheduler.now()),
      performance: virtualPerformance,
      setTimeout: ((fn: (...args: never[]) => void, delay?: number, ...args: unknown[]) =>
        scheduler.setTimeout(fn, delay ?? 0, ...args)) as RuntimeGlobals["setTimeout"],
      setInterval: ((fn: (...args: never[]) => void, delay?: number, ...args: unknown[]) =>
        scheduler.setInterval(fn, delay ?? 0, ...args)) as RuntimeGlobals["setInterval"],
      clearTimeout: ((handle: TimerHandle | number) => scheduler.clear(handle)) as RuntimeGlobals["clearTimeout"],
      clearInterval: ((handle: TimerHandle | number) => scheduler.clear(handle)) as RuntimeGlobals["clearInterval"],
      setImmediate: ((fn: (...args: never[]) => void, ...args: unknown[]) =>
        scheduler.setImmediate(fn, ...args)) as RuntimeGlobals["setImmediate"],
      self: undefined as unknown,
    } satisfies RuntimeGlobals;
    // The object a program sees as `self` is its own global object, the way a browser's is: the realm's constructors plus what this runtime owns.
    // Built as one object so a package that assembles a scope from `self` gets both.
    const globalObject = Object.assign(Object.create(null) as Record<string, unknown>, createRealmGlobals(), runtimeGlobals);
    /**
     * The `fs` a Go runtime compiled to `js/wasm` calls into, on the global because that is where esbuild-wasm looks: its loader installs its own
     * all-`ENOSYS` stub at `globalThis.fs` when one is absent and uses it for every file call. Providing ours decides WHO answers, not whether the
     * name exists: once a program loads esbuild, `self.fs` is there either way. Metadata only, and the reason is in `host-fs.ts`: the in-thread
     * service replaces `read` with a stdin-only implementation, so file bytes cannot cross into the Go side at all.
     */
    globalObject.fs = createCompleteHostFs(
      hostFsSourceFrom(this.#vfs),
      {
        cwd,
        write: (fd, text) => {
          if (fd === 1) stdout.write(text);
          else if (fd === 2) stderr.write(text);
        },
      },
    );
    // Set after the merge, not before: the merge copies the placeholder `self` in, and a global object whose own `self` is not itself is exactly
    // the kind of half-object this exists to avoid.
    globalObject.self = globalObject;
    runtimeGlobals.self = globalObject;

    loader.setRuntimeContext({
      process: processShim,
      console: consoleShim,
      Buffer,
      globals: runtimeGlobals,
    });

    let capturedRefusal: Refusal | undefined;

    /** One place decides what an escaped error means, so a synchronous throw and an await rejection report identically. */
    const programFailure = (error: unknown): number => {
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
    };

    /**
     * Load the entry module, and report an evaluation that is still in flight.
     *
     * A module whose body has top-level await cannot settle inside this call, so the promise comes back to the caller instead of
     * being dropped. Everything else is finished before `execute` returns, exactly as before.
     */
    const execute = (): { code: number; evaluation?: Promise<void> | undefined } => {
      try {
        const record = loader.loadFile(path.resolve(entryPath));
        return { code: 0, evaluation: record.evaluation };
      } catch (error) {
        return { code: programFailure(error) };
      }
    };

    // The program body, plus the tick drain that Node performs at the end of the turn. The flush is in `finally` so it
    // still runs when the body throws or calls process.exit, both of which leave queued ticks behind.
    //
    // It is async because a top-level-await entry has to be waited for, not because ordinary programs became asynchronous: with
    // no pending evaluation this function still runs start to finish in one synchronous turn, which is the ordering the
    // event-loop differential pins.
    const runBody = async (): Promise<{ code: number; timedOut: boolean }> => {
      try {
        const result = execute();
        if (result.evaluation !== undefined) {
          // The body is suspended, and what it is suspended on may be a timer of ours: `await new Promise((resolve) => setTimeout(resolve, 5))`
          // as an entry body deadlocked here until the queue was pumped while it waited. The pump also decides when the body has settled with
          // work still queued, which is the normal case and is left to `drain` below exactly as before.
          try {
            const outcome = await scheduler.drainWhile(result.evaluation);
            if (!outcome.settled && UNFINISHED_STOPS.has(outcome.stop)) {
              // A guard ended a program that had not finished: a timer past the virtual budget, a callback limit, or outside work that never
              // landed. Node would still be running, so the honest report is a timeout. Exit 0 here was a lie with consequences: `vite build`
              // awaited a wasm instantiation, the budget ran out from the polling timers, and the run claimed to have succeeded with no output.
              return { code: 124, timedOut: true };
            }
          } catch (error) {
            // A rejection here is a throw from the module's own body after its first await, so it is the program failing.
            return { code: programFailure(error), timedOut: false };
          }
        }
        return { code: result.code, timedOut: false };
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
      const outcome = await Promise.race([runBody(), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout") {
        timedOut = true;
        exitCode = 124; // coreutils convention for a timed-out command
      } else {
        exitCode = outcome.code;
        timedOut = outcome.timedOut;
      }
    } else {
      const outcome = await runBody();
      exitCode = outcome.code;
      timedOut = outcome.timedOut;
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

    // An exit requested from a callback or an input handler replaces the default code, and never looks like a clean run.
    if (exitRequested !== undefined) exitCode = exitRequested;

    // The program is over; its signal listeners go with it. The terminal stays (the caller owns it) but nothing from this run
    // is still attached to it, so the next resize cannot re-enter a scheduler that has already drained.
    processShim.dispose();
    // The observer goes with the run for the same reason the signal listeners do: a leaked `unhandledRejection` listener would keep
    // suppressing the host's own crash reporting for every run after this one.
    rejections.stop();

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
