/**
 * The container: sessions, a process table, and command dispatch over the runtime host.
 *
 * What it is NOT: an operating system. There is no fork, no signal, no scheduler and no memory protection. Two facts
 * shape every decision here, and they are stated rather than hidden:
 *
 * 1. **Executions are serialised.** One Worker, one thread. A second `node` command queues behind the first; nothing is
 *    preempted. Concurrency would need one Worker per process, which is a P2 change to the host, not a change here.
 * 2. **A running script cannot be interrupted.** The only cancellation primitive is discarding the host (`reset()`), which
 *    stops everything in it. That is why `terminate()` is honest about being a hard stop, and why the process it kills is
 *    reported as `killed` rather than as an exit code the program never produced.
 *
 * The page owns project files (`ProjectFiles`); the host owns execution. This class owns neither, which is what lets it be
 * tested with a fake runtime and a fake project.
 */

import {
  basename,
  dirname,
  parseCommand,
  resolvePath,
  BUILTIN_COMMANDS,
  PROCESS_COMMANDS,
} from "./commands.js";
import type {
  LogLine,
  ProcessRecord,
  ProjectFiles,
  RuntimeClient,
  RuntimeRunOutcome,
  Session,
} from "./types.js";
import { installDependencies, loadLockfile, readPackageManifest, type RegistryClient } from "../npm/install.js";
import { VFSNotFoundError } from "../vfs/errors.js";

export interface ContainerOptions {
  readonly runtime: RuntimeClient;
  readonly files: ProjectFiles;
  /** Bundled, integrity-verified offline package corpus. */
  readonly registry?: RegistryClient;
  /** Real-time budget for a process. Defaults to 5 s; the runtime's own timeout only bounds async gaps. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class Container {
  readonly #runtime: RuntimeClient;
  readonly #files: ProjectFiles;
  readonly #registry: RegistryClient | undefined;
  readonly #dependencies = new Map<string, string>();
  #dependencyProjectId: string | undefined;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #sessions: Session[] = [];
  readonly #processes = new Map<number, ProcessRecord>();
  /** Partial lines per `sessionId:stream`, so a chunk boundary never invents a newline. */
  readonly #pending = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #nextPid = 1;
  #nextSession = 1;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ContainerOptions) {
    this.#runtime = options.runtime;
    this.#files = options.files;
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  sessions(): readonly Session[] {
    return this.#sessions;
  }

  processes(): readonly ProcessRecord[] {
    return [...this.#processes.values()].sort((left, right) => left.pid - right.pid);
  }

  running(): ProcessRecord | undefined {
    return [...this.#processes.values()].find((process) => process.state === "running" || process.state === "queued");
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  createSession(name?: string): Session {
    const index = this.#nextSession++;
    const session: Session = {
      id: `session-${index}`,
      name: name ?? `terminal ${index}`,
      cwd: "/",
      history: [],
      scrollback: [],
      processIds: [],
    };
    this.#sessions.push(session);
    this.#notify();
    return session;
  }

  findSession(id: string): Session | undefined {
    return this.#sessions.find((session) => session.id === id);
  }

  helpText(): string {
    return [
      "Supported commands:",
      "  node <file> [args...]   run a file through the runtime",
      `  ${BUILTIN_COMMANDS.join("  ")}`,
      "",
      "Supported package commands: npm install, npm ci (bundled offline corpus only).",
      "Not supported: npx, pnpm, yarn, sh, bash, zsh.",
      "No pipes, globbing, redirection, environment assignment or job control.",
    ].join("\n");
  }

  /** Run one line. Resolves when the line is finished, including any process it started. */
  async execute(sessionId: string, line: string): Promise<void> {
    const session = this.findSession(sessionId);
    if (session === undefined) throw new Error(`unknown session ${sessionId}`);

    const command = parseCommand(line);
    if (command.kind === "empty") return;

    session.history.push(line);
    this.#line(session, "input", `${session.cwd} $ ${line}`);

    switch (command.kind) {
      case "refused":
        this.#line(session, "system", `${command.name}: ${command.reason}`);
        this.#notify();
        return;
      case "unsupported":
        this.#line(session, "stderr", `${command.name}: not a supported command in this terminal. Type \`help\`.`);
        this.#notify();
        return;
      case "install":
        await this.#install(session, command.args);
        return;
      case "builtin":
        this.#builtin(session, command.name, command.args);
        this.#notify();
        return;
      case "process":
        await this.#startProcess(session, line, command.args);
        return;
    }
  }

  async #install(session: Session, args: readonly string[]): Promise<void> {
    if (this.#registry === undefined) {
      this.#line(session, "stderr", "npm: offline package corpus is unavailable");
      this.#notify();
      return;
    }
    const [subcommand, ...flags] = args;
    if (subcommand !== "install" && subcommand !== "i" && subcommand !== "ci") {
      this.#line(session, "stderr", `npm: unsupported command${subcommand === undefined ? "" : ` ${subcommand}`}`);
      this.#notify();
      return;
    }
    if (flags.some((flag) => !["--omit=dev", "--production"].includes(flag))) {
      this.#line(session, "stderr", "npm: only npm install/npm ci and --omit=dev are supported; package arguments and other flags are refused");
      this.#notify();
      return;
    }
    const projectId = this.#files.projectId ?? "default";
    if (this.#dependencyProjectId !== projectId) {
      this.#dependencies.clear();
      this.#dependencyProjectId = projectId;
    }
    const root = "/";
    try {
      const manifest = readPackageManifest({ readFileSync: (path) => {
        const contents = this.#files.read(path);
        if (contents === null) throw new VFSNotFoundError(path);
        return contents;
      } }, root);
      const lockfile = loadLockfile({ readFileSync: (path) => {
        const contents = this.#files.read(path);
        if (contents === null) throw new VFSNotFoundError(path);
        return contents;
      } }, root);
      if (subcommand === "ci" && lockfile === null) throw new Error("npm ci requires package-lock.json");
      const staged = new Map<string, string>();
      const report = await installDependencies(manifest, {
        registry: this.#registry,
        root,
        lockfile,
        requireLockfile: subcommand === "ci",
        includeDev: !flags.includes("--omit=dev") && !flags.includes("--production"),
        writeLockfile: subcommand !== "ci",
        vfs: {
          mkdirSync: () => undefined,
          writeFileSync: (path, data) => staged.set(path, typeof data === "string" ? data : new TextDecoder().decode(data)),
        },
      });
      if (subcommand === "ci" && !report.usedLockfile) throw new Error("npm ci requires a lockfile that pins the installed versions");
      if ((this.#files.projectId ?? "default") !== projectId) {
        throw new Error("active project changed while npm was installing; staged files were discarded");
      }
      const lockText = staged.get(`${root}package-lock.json`);
      if (lockText !== undefined) this.#files.write(`${root}package-lock.json`, lockText);
      this.#dependencies.clear();
      for (const [path, contents] of staged) if (path.includes("/node_modules/")) this.#dependencies.set(path, contents);
      this.#line(session, "stdout", `added ${report.packages.length} package(s) from the offline corpus`);
      for (const warning of report.warnings) this.#line(session, "stderr", `npm warning: ${warning}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#line(session, "stderr", `npm error: ${message}`);
    }
    this.#notify();
  }

  /** Hard-stop a process. Returns false when the pid is unknown or already finished. */
  terminate(pid: number): boolean {
    const process = this.#processes.get(pid);
    if (process === undefined) return false;
    if (process.state === "queued") {
      process.state = "killed";
      process.endedAt = this.#now();
      this.#notify();
      return true;
    }
    if (process.state !== "running") return false;

    // The only real cancellation we have: throw away the host that is stuck inside the script.
    this.#runtime.reset();
    process.state = "killed";
    process.endedAt = this.#now();
    this.#notify();
    return true;
  }

  // ---------------------------------------------------------------- processes

  async #startProcess(session: Session, line: string, args: readonly string[]): Promise<void> {
    const target = args[0];
    if (target === undefined) {
      this.#line(session, "stderr", "node: usage: node <file> [args...]");
      this.#notify();
      return;
    }
    if (target === "-e" || target === "--eval") {
      this.#line(session, "stderr", "node: -e is not supported here: create a file and run it.");
      this.#notify();
      return;
    }
    if (target.startsWith("-")) {
      this.#line(session, "stderr", `node: unsupported option ${target}`);
      this.#notify();
      return;
    }

    const entry = resolvePath(session.cwd, target);
    if (this.#files.read(entry) === null) {
      this.#line(session, "stderr", `node: cannot find module '${entry}'`);
      this.#notify();
      return;
    }

    const pid = this.#nextPid++;
    const process: ProcessRecord = {
      pid,
      sessionId: session.id,
      command: line.trim(),
      argv: ["node", entry, ...args.slice(1)],
      cwd: session.cwd,
      startedAt: this.#now(),
      state: "queued",
      stdout: "",
      stderr: "",
    };
    this.#processes.set(pid, process);
    session.processIds.push(pid);
    this.#notify();

    const task = this.#queue.then(() => this.#runProcess(session, process));
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  async #runProcess(session: Session, process: ProcessRecord): Promise<void> {
    if (process.state === "killed") {
      this.#line(session, "system", `[${process.pid}] killed before it started`);
      this.#notify();
      return;
    }

    process.state = "running";
    this.#notify();

    let outcome: RuntimeRunOutcome;
    try {
      outcome = await this.#runtime.run({
        files: this.#snapshotFiles(),
        entry: process.argv[1] ?? "/index.js",
        argv: process.argv,
        cwd: process.cwd,
        env: { PWD: process.cwd },
        timeoutMs: this.#timeoutMs,
        onOutput: (stream, text) => {
          // Live output: the terminal sees it while the process runs, and the record keeps the same text.
          this.#append(session, stream, text);
          if (stream === "stdout") process.stdout += text;
          else process.stderr += text;
          this.#notify();
        },
      });
    } catch (error) {
      this.#flush(session);
      process.state = "failed";
      process.endedAt = this.#now();
      const message = error instanceof Error ? error.message : String(error);
      this.#line(session, "stderr", `${basename(process.argv[1] ?? "node")}: ${message}`);
      this.#notify();
      return;
    }

    this.#flush(session);
    // Read the state back from the table: terminate() may have replaced it while we awaited, and the local variable is
    // narrowed by the compiler to the "running" it was assigned above.
    if (this.#processes.get(process.pid)?.state === "killed") {
      // terminate() already recorded the truth; a late outcome must not overwrite it with an exit code.
      this.#line(session, "system", `[${process.pid}] terminated`);
      this.#notify();
      return;
    }

    process.state = outcome.timedOut ? "failed" : "exited";
    process.exitCode = outcome.exitCode;
    process.endedAt = this.#now();
    this.#line(
      session,
      "system",
      outcome.timedOut
        ? `[${process.pid}] timed out after ${outcome.durationMs} ms (exit ${outcome.exitCode})`
        : `[${process.pid}] exited with code ${outcome.exitCode}`,
    );
    this.#notify();
  }

  // ---------------------------------------------------------------- builtins

  #builtin(session: Session, name: string, args: readonly string[]): void {
    switch (name) {
      case "cd": {
        const target = resolvePath(session.cwd, args[0] ?? "/");
        if (target === "/" || this.#files.listDirs().includes(target)) {
          session.cwd = target;
        } else {
          this.#line(session, "stderr", `cd: no such directory: ${args[0] ?? "/"}`);
        }
        return;
      }
      case "pwd":
        this.#line(session, "stdout", session.cwd);
        return;
      case "ls": {
        const target = resolvePath(session.cwd, args[0] ?? ".");
        if (target !== "/" && !this.#files.listDirs().includes(target)) {
          const file = this.#files.read(target);
          if (file !== null) {
            this.#line(session, "stdout", basename(target));
            return;
          }
          this.#line(session, "stderr", `ls: no such directory: ${args[0] ?? "."}`);
          return;
        }
        const entries = new Set<string>();
        for (const path of this.#files.list()) {
          if (dirname(path) === target) entries.add(basename(path));
        }
        for (const path of this.#files.listDirs()) {
          if (path !== "/" && dirname(path) === target) entries.add(`${basename(path)}/`);
        }
        if (entries.size === 0) return;
        this.#line(session, "stdout", [...entries].sort().join("  "));
        return;
      }
      case "cat": {
        if (args.length === 0) {
          this.#line(session, "stderr", "cat: usage: cat <file>");
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        const contents = this.#files.read(target);
        if (contents === null) {
          this.#line(session, "stderr", `cat: no such file: ${args[0] ?? ""}`);
          return;
        }
        for (const line of contents.split("\n")) this.#line(session, "stdout", line);
        return;
      }
      case "mkdir": {
        if (args.length === 0) {
          this.#line(session, "stderr", "mkdir: usage: mkdir <directory>");
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        if (!this.#files.mkdir(target)) this.#line(session, "stderr", `mkdir: already exists: ${args[0] ?? ""}`);
        return;
      }
      case "touch": {
        if (args.length === 0) {
          this.#line(session, "stderr", "touch: usage: touch <file>");
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        if (this.#files.read(target) === null) this.#files.write(target, "");
        return;
      }
      case "rm": {
        if (args.length === 0) {
          this.#line(session, "stderr", "rm: usage: rm <path>");
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        const isDirectory = this.#files.listDirs().includes(target);
        const hasChildren = isDirectory && (this.#files.list().some((path) => path.startsWith(`${target}/`)) ||
          this.#files.listDirs().some((path) => path.startsWith(`${target}/`)));
        if (isDirectory && hasChildren) {
          this.#line(session, "stderr", `rm: ${args[0] ?? ""} is a non-empty directory (recursive removal is not supported)`);
          return;
        }
        if (!this.#files.remove(target)) this.#line(session, "stderr", `rm: no such file or directory: ${args[0] ?? ""}`);
        return;
      }
      case "echo":
        this.#line(session, "stdout", args.join(" "));
        return;
      case "clear":
        session.scrollback.length = 0;
        return;
      case "help":
        for (const line of this.helpText().split("\n")) this.#line(session, "system", line);
        return;
      case "ps": {
        const processes = this.processes();
        if (processes.length === 0) {
          this.#line(session, "system", "no processes yet");
          return;
        }
        for (const process of processes) {
          this.#line(session, "system", `${process.pid}  ${process.state.padEnd(7)}  ${process.command}`);
        }
        return;
      }
      case "kill": {
        const pid = Number(args[0]);
        if (!Number.isInteger(pid)) {
          this.#line(session, "stderr", "kill: usage: kill <pid>");
          return;
        }
        if (!this.terminate(pid)) this.#line(session, "stderr", `kill: no running process with pid ${pid}`);
        return;
      }
      default:
        this.#line(session, "stderr", `${name}: not implemented`);
    }
  }

  // ---------------------------------------------------------------- plumbing

  #snapshotFiles(): Record<string, string> {
    const projectId = this.#files.projectId ?? "default";
    if (this.#dependencyProjectId !== projectId) {
      this.#dependencies.clear();
      this.#dependencyProjectId = projectId;
    }
    const snapshot: Record<string, string> = { ...Object.fromEntries(this.#dependencies) };
    for (const path of this.#files.list()) {
      const contents = this.#files.read(path);
      if (contents !== null) snapshot[path] = contents;
    }
    return snapshot;
  }

  #line(session: Session, stream: LogLine["stream"], text: string): void {
    session.scrollback.push({ stream, text });
  }

  #append(session: Session, stream: "stdout" | "stderr", text: string): void {
    const key = `${session.id}:${stream}`;
    const combined = `${this.#pending.get(key) ?? ""}${text}`;
    const parts = combined.split("\n");
    const tail = parts.pop() ?? "";
    for (const part of parts) session.scrollback.push({ stream, text: part });
    if (tail === "") this.#pending.delete(key);
    else this.#pending.set(key, tail);
  }

  #flush(session: Session): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${session.id}:${stream}`;
      const tail = this.#pending.get(key);
      if (tail !== undefined && tail !== "") session.scrollback.push({ stream, text: tail });
      this.#pending.delete(key);
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** The list of commands the terminal promises to run, for docs and for the UI's hint line. */
export const SUPPORTED_COMMANDS: readonly string[] = [...PROCESS_COMMANDS, ...BUILTIN_COMMANDS].sort();

