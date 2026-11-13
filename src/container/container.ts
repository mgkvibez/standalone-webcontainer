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
  ProjectFileContents,
  ProjectFiles,
  RuntimeClient,
  RuntimeRunOutcome,
  Session,
} from "./types.js";
import { installDependencies, loadLockfile, readPackageManifest, type PackageManifest, type RegistryClient } from "../npm/install.js";
import { parseInstallSpec } from "../npm/spec.js";
import { splitScriptLine } from "./script-line.js";
import { VFSNotFoundError } from "../vfs/errors.js";

export interface ContainerOptions {
  readonly runtime: RuntimeClient;
  readonly files: ProjectFiles;
  /** Bundled, integrity-verified offline package corpus. */
  readonly registry?: RegistryClient;
  /**
   * Real-time budget for one program. `0` (the default) means no wall clock: a session's program ends when the user stops it.
   *
   * A caller that awaits a bounded answer (the fixture harness, a one-shot API call) passes a budget explicitly. See ADR-0034 for why the
   * default is not a number: a server's body never finishes, so a clock was the only thing ending one, and every previewed server was killed
   * five seconds after it appeared.
   */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 0;

/**
 * The size a session starts at, before any UI has measured the window.
 *
 * 80x24 because that is the terminal default every program assumes, so a program run before the first measurement sees the same
 * numbers it would in a real terminal that had not been resized.
 */
const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

/**
 * Put the requested dependencies back into the project's OWN package.json, preserving every other field.
 *
 * The installer reads a narrow view of that file - name, version, dependencies - and writing that view back is data loss. Measured in the
 * real-registry acceptance journey: `"scripts": { "dev": "vite" }` disappeared after `npm install`, and `npm run dev` then answered "missing
 * script: dev" for a file the test had just written. So the user's file is edited in place rather than regenerated: only the `dependencies` map
 * is replaced, and `type`, `private`, `scripts`, `devDependencies` and any field this runtime has never heard of survive an install.
 *
 * Returns null when the file is not a JSON object, in which case nothing is written: a manifest we cannot parse is a manifest we must not
 * overwrite.
 */
function mergeDependencies(raw: string | null, dependencies: Record<string, string>): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record: Record<string, unknown> = { ...(parsed as Record<string, unknown>), dependencies };
  return `${JSON.stringify(record, null, 2)}\n`;
}

export class Container {
  readonly #runtime: RuntimeClient;
  readonly #files: ProjectFiles;
  readonly #registry: RegistryClient | undefined;
  readonly #dependencies = new Map<string, ProjectFileContents>();
  #dependencyProjectId: string | undefined;
  #runtimeProjectId: string | null = null;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #sessions: Session[] = [];
  readonly #processes = new Map<number, ProcessRecord>();
  /** Partial lines per `sessionId:stream`, so a chunk boundary never invents a newline. */
  readonly #pending = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #chunks = new Set<(event: { sessionId: string; stream: "stdout" | "stderr"; text: string }) => void>();
  #nextPid = 1;
  #nextSession = 1;
  #queue: Promise<void> = Promise.resolve();
  /**
   * Exit status of the last command this container ran.
   *
   * `execute` returns void because a caller in the terminal does not need a number, but `&&` and `||` do: sequencing is meaningless
   * without a status to short-circuit on. Every place that finishes a command writes it here, including builtins, so a stale value from
   * an earlier line can never be what decides whether the rest of a script runs.
   */
  #lastExitCode = 0;

  constructor(options: ContainerOptions) {
    this.#runtime = options.runtime;
    this.#files = options.files;
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 0) {
      throw new RangeError(`timeoutMs must be zero or a positive number, received ${String(this.#timeoutMs)}`);
    }
    this.#now = options.now ?? (() => Date.now());
    // A server that keeps running never produces a run outcome, so its ports arrive here instead. Without this subscription a previewed server
    // works but is never offered for preview: the process list waits for an outcome that never comes.
    this.#runtime.onPorts?.((processId, ports) => {
      const process = this.#processes.get(processId);
      if (process === undefined || ports.length === 0) return;
      if (process.state !== "running" && process.state !== "queued") return;
      const known = process.previewPorts ?? [];
      if (known.length === ports.length && known.every((port, index) => port === ports[index])) return;
      process.previewPorts = [...ports];
      process.state = "running";
      this.#line(this.findSession(process.sessionId) ?? this.#sessions[0]!, "system", `[${process.pid}] server listening on port(s) ${ports.join(", ")}`);
      this.#notify();
    });
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

  /**
   * Hand a saved file to the running project.
   *
   * The editor's save writes to the page's own store, and the kernel only ever reads a project's files as a SNAPSHOT at the start of a run, so
   * a program that is already running would never see the change: a dev server could watch its module forever and hear nothing (W-26).
   * Nothing is staged here on purpose — a save before the first run needs no live write, because that run carries the whole snapshot.
   */
  pushFile(path: string, contents: string): void {
    // Only when a kernel is live for this project: `#runtimeProjectId` is set by the run that started it, and a save arriving before the first
    // run is carried by that run's own snapshot. Sending it earlier would write into nothing.
    if (this.#runtimeProjectId === null) return;
    this.#runtime.writeFile?.(this.#runtimeProjectId, path, contents);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Every chunk a program writes, exactly as it wrote it, before it is split into scrollback lines.
   *
   * Separate from `onChange` because the terminal pane needs the raw stream: scrollback deliberately holds whole lines, so a
   * program that prints a prompt and waits leaves its prompt in a pending buffer and the pane would show nothing until the user
   * pressed Enter. This is the tap that makes an interactive program visible while it is waiting.
   */
  onChunk(listener: (event: { sessionId: string; stream: "stdout" | "stderr"; text: string }) => void): () => void {
    this.#chunks.add(listener);
    return () => this.#chunks.delete(listener);
  }

  createSession(name?: string): Session {
    const index = this.#nextSession++;
    const session: Session = {
      id: `session-${index}`,
      name: name ?? `terminal ${index}`,
      cwd: "/",
      columns: DEFAULT_TERMINAL_COLUMNS,
      rows: DEFAULT_TERMINAL_ROWS,
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

  /**
   * Typed text, delivered to the program running in that session.
   *
   * Nothing happens when no program is running: this is the program's stdin, not a line editor. Line editing belongs to the
   * UI's prompt, and pretending to echo or to buffer a half-typed command here would put a second, worse editor in the path.
   */
  write(sessionId: string, text: string): void {
    const process = this.#runningIn(sessionId);
    if (process === undefined) return;
    this.#runtime.write?.(process.pid, text);
  }

  /**
   * Changes a session's window size and tells the program running in it.
   *
   * Stored on the session even with nothing running, because the size outlives the process: the next program to start in this
   * session should see the window the user actually has, not the 80 columns this container was built with.
   */
  resizeSession(sessionId: string, columns: number, rows: number): void {
    const session = this.findSession(sessionId);
    if (session === undefined) throw new Error(`unknown session ${sessionId}`);
    if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new RangeError(`terminal size must be positive integers, got ${columns}x${rows}`);
    }
    if (session.columns === columns && session.rows === rows) return;
    session.columns = columns;
    session.rows = rows;
    const process = this.#runningIn(sessionId);
    if (process !== undefined) this.#runtime.resize?.(process.pid, columns, rows);
    this.#notify();
  }

  /** The process a keystroke in this session belongs to, if one is running. */
  #runningIn(sessionId: string): ProcessRecord | undefined {
    let found: ProcessRecord | undefined;
    for (const process of this.#processes.values()) {
      if (process.sessionId !== sessionId) continue;
      if (process.state !== "running" && process.state !== "queued") continue;
      // The newest wins: a session runs one program at a time (the queue guarantees it), so this only settles ties left by a
      // process that has just ended.
      if (found === undefined || process.pid > found.pid) found = process;
    }
    return found;
  }

  helpText(): string {
    return [
      "Supported commands:",
      "  node <file> [args...]   run a file through the runtime",
      `  ${BUILTIN_COMMANDS.join("  ")}`,
      "",
      "Supported package commands: npm install, npm ci, npm run <script> [-- args].",
      "Not supported: npx, pnpm, yarn, sh, bash, zsh.",
      "No pipes, globbing, redirection, environment assignment or job control.",
    ].join("\n");
  }

  /** Run one line. Resolves when the line is finished, including any process it started. */
  async execute(sessionId: string, line: string, scriptDepth = 0): Promise<void> {
    const session = this.findSession(sessionId);
    if (session === undefined) throw new Error(`unknown session ${sessionId}`);

    const command = parseCommand(line);
    if (command.kind === "empty") return;

    session.history.push(line);
    this.#line(session, "input", `${session.cwd} $ ${line}`);

    switch (command.kind) {
      case "refused":
        // A command the container refuses by policy is a command that did not run, and sequencing has to see it that way.
        this.#line(session, "system", `${command.name}: ${command.reason}`);
        this.#lastExitCode = 1;
        this.#notify();
        return;
      case "unsupported":
        this.#line(session, "stderr", `${command.name}: not a supported command in this terminal. Type \`help\`.`);
        this.#lastExitCode = 1;
        this.#notify();
        return;
      case "install":
        await this.#install(session, command.args, scriptDepth);
        // `npm install` reports through the scrollback rather than an exit code, and it is a top-level command rather than a script
        // segment, so it neither reads nor sets the sequencing status. Saying so here is cheaper than a reader wondering.
        this.#lastExitCode = 0;
        return;
      case "builtin":
        this.#lastExitCode = 0;
        this.#builtin(session, command.name, command.args);
        this.#notify();
        return;
      case "process":
        await this.#startProcess(session, line, command.args);
        return;
    }
  }

  /**
   * `npm run <script> [-- args...]`, and `npm run` with no argument to list them.
   *
   * This was the single command standing between the front-end fixtures and any verdict at all: eight definitions start their app with
   * `npm run dev` or `npm run build`, and the container refused the subcommand by name. What is implemented here is npm's contract for
   * the parts that matter:
   *
   * - the script body comes from `package.json`, and is executed **through this container** like any other line, so a script that runs
   *   `node server.mjs` behaves exactly like typing it;
   * - a bare `vite` (or any package-provided binary) resolves the way npm's `.bin` shim does: the package's `bin` field names the
   *   entry file, and that file is run with `node`. We have no symlinks, so the resolution is done here rather than faked on disk;
   * - arguments are appended **only after `--`**, which is npm's rule and not pedantry: `npm run dev --port 3000` passes nothing, and
   *   silently forwarding it would run something the fixture never asked for;
   * - a missing script is an error naming the script, and a script naming something this container cannot run is refused by name rather
   *   than attempted.
   *
   * Recursion is bounded: `npm run a` where `a` is `npm run b` is legal npm, so a depth counter stops a script that calls itself.
   */
  async #runScript(session: Session, args: readonly string[], depth = 0): Promise<void> {
    if (depth > 8) {
      this.#line(session, "stderr", "npm error: scripts nested more than 8 deep; refusing to recurse");
      this.#notify();
      return;
    }
    const raw = this.#files.read("/package.json");
    if (raw === null) {
      this.#line(session, "stderr", "npm error: ENOENT: no package.json in this project, so there are no scripts to run");
      this.#notify();
      return;
    }
    let manifest: { name?: unknown; version?: unknown; scripts?: unknown };
    try {
      manifest = JSON.parse(raw) as { name?: unknown; version?: unknown; scripts?: unknown };
    } catch (error) {
      this.#line(session, "stderr", `npm error: package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      this.#notify();
      return;
    }
    const scripts: Record<string, string> = {};
    if (typeof manifest.scripts === "object" && manifest.scripts !== null) {
      for (const [name, value] of Object.entries(manifest.scripts as Record<string, unknown>)) {
        if (typeof value === "string") scripts[name] = value;
      }
    }

    const [name, ...rest] = args;
    if (name === undefined) {
      const names = Object.keys(scripts);
      this.#line(session, "stdout", names.length === 0 ? "no scripts defined" : `available scripts: ${names.join(", ")}`);
      this.#notify();
      return;
    }
    const script = scripts[name];
    if (script === undefined) {
      this.#line(
        session,
        "stderr",
        `npm error: missing script: "${name}"${Object.keys(scripts).length === 0 ? " (package.json defines no scripts)" : ` (available: ${Object.keys(scripts).join(", ")})`}`,
      );
      this.#notify();
      return;
    }

    // npm appends arguments only after `--`; anything before it belongs to npm, not to the script.
    const separator = rest.indexOf("--");
    const extra = separator === -1 ? [] : rest.slice(separator + 1);
    const composed = `${script.trim()}${extra.length === 0 ? "" : ` ${extra.join(" ")}`}`;
    const projectName = typeof manifest.name === "string" ? manifest.name : "project";
    const projectVersion = typeof manifest.version === "string" ? manifest.version : "0.0.0";
    this.#line(session, "stdout", `> ${projectName}@${projectVersion} ${name}`);
    this.#line(session, "stdout", `> ${composed}`);

    const segments = splitScriptLine(composed);
    if (segments.length === 0) {
      this.#line(session, "stderr", "npm error: the script is empty");
      this.#notify();
      return;
    }
    if (segments[segments.length - 1]?.operator !== null) {
      // `build &&` is a syntax error in a shell. Running the first half and calling it done would be the same silent green this
      // sequencing exists to prevent.
      this.#line(session, `stderr`, "npm error: the script ends with an operator and no command after it");
      this.#notify();
      this.#lastExitCode = 1;
      return;
    }

    for (const segment of segments) {
      const resolved = this.#resolveScriptLine(session, segment.command);
      if (resolved === null) {
        // A segment this container cannot run fails the script, whether or not an `||` follows: the operator's meaning is "run the
        // next command if this one failed", and a refusal by name is a failure to run, not a command that returned non-zero.
        this.#lastExitCode = 1;
        return;
      }
      await this.execute(session.id, resolved, depth + 1);
      if (segment.operator === "&&" && this.#lastExitCode !== 0) return;
      if (segment.operator === "||" && this.#lastExitCode === 0) return;
    }
  }

  /**
   * Turns a script body into a line this container can run, or refuses it by name.
   *
   * The only rewriting is npm's own: a first token that names a package's binary becomes `node <entry>`. Everything else is left
   * exactly as written, because a container that quietly reinterpreted a script would make the verdict a statement about the rewriter.
   */
  #resolveScriptLine(session: Session, composed: string): string | null {
    const parts = composed.split(/\s+/).filter((part) => part !== "");
    const [head, ...tail] = parts;
    if (head === undefined) {
      this.#line(session, "stderr", "npm error: the script is empty");
      this.#notify();
      return null;
    }
    if (head === "node" || head === "npm") return composed;

    const entry = this.#findPackageBinary(head);
    if (entry !== null) return ["node", entry, ...tail].join(" ");

    this.#line(
      session,
      "stderr",
      `${head}: not a command in this container, and no installed package provides a "${head}" binary`,
    );
    this.#notify();
    return null;
  }

  /**
   * Reads a path that may live in the installed dependency tree rather than in the project's own files.
   *
   * Installed packages are held separately from the project (they are runtime state, re-seeded per run), so a lookup that only asked
   * the project store found nothing and reported "no installed package provides a vite binary" while vite was installed. One helper,
   * used by every lookup here, is what keeps that from becoming a habit.
   */
  #readInstalled(path: string): string | null {
    const found = this.#dependencies.get(path) ?? this.#files.read(path);
    // The callers are manifest and shebang readers, so bytes become text here rather than at every call site.
    return typeof found === "string" || found === null ? found : new TextDecoder().decode(found);
  }

  /** The entry file a package's `bin` field declares for `name`, or null when nothing provides it. */
  #findPackageBinary(name: string): string | null {
    const manifestText = this.#readInstalled(`/node_modules/${name}/package.json`);
    if (manifestText === null) return null;
    let manifest: { bin?: unknown };
    try {
      manifest = JSON.parse(manifestText) as { bin?: unknown };
    } catch {
      return null;
    }
    const bin = manifest.bin;
    let relative: string | undefined;
    if (typeof bin === "string") relative = bin;
    else if (typeof bin === "object" && bin !== null) {
      const entry = (bin as Record<string, unknown>)[name];
      if (typeof entry === "string") relative = entry;
    }
    if (relative === undefined) return null;
    const path = relative.startsWith("/") ? relative : `/node_modules/${name}/${relative.replace(/^\.\//, "")}`;
    return this.#readInstalled(path) === null ? null : path;
  }

  async #install(session: Session, args: readonly string[], scriptDepth = 0): Promise<void> {
    const [subcommand, ...flags] = args;
    // `npm run` is handled before the registry guard, because running a project's own scripts needs no registry at all. Leaving it
    // behind the guard meant a container built without one answered "offline corpus is unavailable" to `npm run dev`.
    if (subcommand === "run" || subcommand === "run-script") {
      await this.#runScript(session, flags, scriptDepth);
      return;
    }
    if (this.#registry === undefined) {
      this.#line(session, "stderr", "npm: offline package corpus is unavailable");
      this.#notify();
      return;
    }
    if (subcommand !== "install" && subcommand !== "i" && subcommand !== "ci") {
      this.#line(session, "stderr", `npm: unsupported command${subcommand === undefined ? "" : ` ${subcommand}`}`);
      this.#notify();
      return;
    }
    const requested: { name: string; range: string }[] = [];
    for (const token of flags) {
      if (token.startsWith("-")) continue;
      try {
        requested.push(parseInstallSpec(token));
      } catch (error) {
        this.#line(session, "stderr", `npm error: ${error instanceof Error ? error.message : String(error)}`);
        this.#notify();
        return;
      }
    }
    if (flags.some((flag) => flag.startsWith("-") && !["--omit=dev", "--production"].includes(flag))) {
      this.#line(session, "stderr", "npm: only --omit=dev and --production are supported; other flags are refused");
      this.#notify();
      return;
    }
    if (subcommand === "ci" && requested.length > 0) {
      this.#line(session, "stderr", "npm error: npm ci installs exactly the lockfile and takes no package arguments");
      this.#notify();
      return;
    }
    const projectId = this.#files.projectId ?? "default";
    this.#activateProject(projectId);
    if (this.#dependencyProjectId !== projectId) {
      this.#dependencies.clear();
      this.#dependencyProjectId = projectId;
    }
    const root = "/";
    try {
      const reader = { readFileSync: (path: string) => {
        const contents = this.#files.read(path);
        if (contents === null) throw new VFSNotFoundError(path);
        return contents;
      } };
      // `npm install <pkg>` has to work in a project with no manifest at all: that is fixture 8's shape and npm's own behaviour,
      // and npm does not invent a package.json either. The manifest exists only in memory for this install.
      let manifest: PackageManifest;
      let manifestExists = true;
      try {
        manifest = readPackageManifest(reader, root);
      } catch {
        manifestExists = false;
        manifest = { name: "project", version: "0.0.0", dependencies: {} };
      }
      if (requested.length > 0) {
        const dependencies: Record<string, string> = { ...(manifest.dependencies ?? {}) };
        for (const spec of requested) dependencies[spec.name] = spec.range;
        manifest = { ...manifest, dependencies };
      }
      const lockfile = loadLockfile({ readFileSync: (path) => {
        const contents = this.#files.read(path);
        if (contents === null) throw new VFSNotFoundError(path);
        return contents;
      } }, root);
      if (subcommand === "ci" && lockfile === null) throw new Error("npm ci requires package-lock.json");
      const staged = new Map<string, ProjectFileContents>();
      const report = await installDependencies(manifest, {
        registry: this.#registry,
        root,
        lockfile,
        requireLockfile: subcommand === "ci",
        includeDev: !flags.includes("--omit=dev") && !flags.includes("--production"),
        writeLockfile: subcommand !== "ci",
        // Staged as-is. The installer hands over `Uint8Array` for every file it extracts from a tarball, and a decode here is what turned
        // esbuild's wasm into an unloadable module: a package's bytes are part of its interface, not an encoding detail.
        vfs: {
          mkdirSync: () => undefined,
          writeFileSync: (path, data) => staged.set(path, data),
        },
      });
      if (subcommand === "ci" && !report.usedLockfile) throw new Error("npm ci requires a lockfile that pins the installed versions");
      if ((this.#files.projectId ?? "default") !== projectId) {
        throw new Error("active project changed while npm was installing; staged files were discarded");
      }
      // npm saves a requested dependency into package.json when there is one, and leaves the tree alone when there is not.
      if (requested.length > 0 && manifestExists) {
        const merged = mergeDependencies(this.#files.read(`${root}package.json`), manifest.dependencies ?? {});
        if (merged !== null) this.#files.write(`${root}package.json`, merged);
      }
      const lockContents = staged.get(`${root}package-lock.json`);
      // The lockfile is text by definition, so it is decoded here rather than at the staging write, which has to stay byte-faithful for every
      // other file: decoding at the write is what corrupted esbuild's wasm.
      if (lockContents !== undefined) {
        this.#files.write(
          `${root}package-lock.json`,
          typeof lockContents === "string" ? lockContents : new TextDecoder().decode(lockContents),
        );
      }
      this.#dependencies.clear();
      for (const [path, contents] of staged) if (path.includes("/node_modules/")) this.#dependencies.set(path, contents);
      this.#line(session, "stdout", `added ${report.packages.length} package(s) from ${this.#registry.origin ?? "the registry"}`);
      for (const warning of report.warnings) this.#line(session, "stderr", `npm warning: ${warning}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#line(session, "stderr", `npm error: ${message}`);
    }
    this.#notify();
  }

  /**
   * A system line with no command behind it.
   *
   * For a notice the page raises before the user types anything - a dependency tree being rebuilt from a lockfile, or that rebuild failing -
   * because the alternative is a scrollback that starts mid-story and a person who cannot tell why `npm run dev` worked a minute ago.
   */
  announce(sessionId: string, text: string): void {
    const session = this.findSession(sessionId);
    if (session === undefined) return;
    this.#line(session, "system", text);
    this.#notify();
  }

  /** Whether an installed tree is in memory. False after a reload, which is when a project's lockfile is worth reinstalling from. */
  hasDependencies(): boolean {
    return this.#dependencies.size > 0;
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

    if (process.previewPorts !== undefined && process.previewPorts.length > 0) {
      this.#runtime.stopServers?.(process.previewPorts);
      process.state = "killed";
      process.endedAt = this.#now();
      this.#line(this.findSession(process.sessionId) ?? this.#sessions[0]!, "system", `[${process.pid}] server stopped`);
      this.#notify();
      return true;
    }

    // The only real cancellation we have: throw away the host that is stuck inside the script.
    this.#runtime.reset();
    for (const running of this.#processes.values()) {
      if (running.state !== "running") continue;
      running.state = "killed";
      running.endedAt = this.#now();
      const owner = this.findSession(running.sessionId);
      if (owner !== undefined) this.#line(owner, "system", `[${running.pid}] terminated with runtime reset`);
    }
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
    // Installed packages live beside the project's own files, so the existence check has to look where the runtime will look. Without
    // this, `node node_modules/vite/bin/vite.js` reported "cannot find module" for a file that had just been installed.
    if (this.#readInstalled(entry) === null) {
      this.#line(session, "stderr", `node: cannot find module '${entry}'`);
      this.#notify();
      return;
    }

    this.#activateProject(this.#files.projectId ?? "default");

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
        projectId: this.#files.projectId ?? "default",
        processId: process.pid,
        files: this.#snapshotFiles(),
        entry: process.argv[1] ?? "/index.js",
        argv: process.argv,
        cwd: process.cwd,
        env: { PWD: process.cwd },
        timeoutMs: this.#timeoutMs,
        // The program gets a terminal sized like the session, so `process.stdout.columns` matches the window the user sees.
        terminal: { columns: session.columns, rows: session.rows },
        onOutput: (stream, text) => {
          // The raw tap first, so an interactive pane sees the text before the line splitter holds back a partial line.
          for (const listener of this.#chunks) listener({ sessionId: session.id, stream, text });
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
      this.#lastExitCode = 1;
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
      // Terminated is not success: a `&&` after a killed program must not go on to run the rest of the script.
      this.#lastExitCode = 1;
      this.#notify();
      return;
    }

    if (!outcome.timedOut && outcome.exitCode === 0 && (outcome.previewPorts?.length ?? 0) > 0) {
      process.previewPorts = [...(outcome.previewPorts ?? [])];
      process.state = "running";
      this.#lastExitCode = 0;
      this.#line(session, "system", `[${process.pid}] server listening on port(s) ${process.previewPorts.join(", ")}`);
      this.#notify();
      return;
    }
    if ((outcome.previewPorts?.length ?? 0) > 0) this.#runtime.stopServers?.(outcome.previewPorts ?? []);
    process.state = outcome.timedOut ? "failed" : "exited";
    process.exitCode = outcome.exitCode;
    this.#lastExitCode = outcome.exitCode;
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
          this.#lastExitCode = 1;
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
        this.#lastExitCode = 1;
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
        this.#lastExitCode = 1;
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        const contents = this.#files.read(target);
        if (contents === null) {
          this.#line(session, "stderr", `cat: no such file: ${args[0] ?? ""}`);
        this.#lastExitCode = 1;
          return;
        }
        for (const line of contents.split("\n")) this.#line(session, "stdout", line);
        return;
      }
      case "mkdir": {
        if (args.length === 0) {
          this.#line(session, "stderr", "mkdir: usage: mkdir <directory>");
        this.#lastExitCode = 1;
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        if (!this.#files.mkdir(target)) this.#line(session, "stderr", `mkdir: already exists: ${args[0] ?? ""}`);
      this.#lastExitCode = 1;
        return;
      }
      case "touch": {
        if (args.length === 0) {
          this.#line(session, "stderr", "touch: usage: touch <file>");
        this.#lastExitCode = 1;
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        if (this.#files.read(target) === null) this.#files.write(target, "");
        return;
      }
      case "rm": {
        if (args.length === 0) {
          this.#line(session, "stderr", "rm: usage: rm <path>");
        this.#lastExitCode = 1;
          return;
        }
        const target = resolvePath(session.cwd, args[0] ?? "");
        const isDirectory = this.#files.listDirs().includes(target);
        const hasChildren = isDirectory && (this.#files.list().some((path) => path.startsWith(`${target}/`)) ||
          this.#files.listDirs().some((path) => path.startsWith(`${target}/`)));
        if (isDirectory && hasChildren) {
          this.#line(session, "stderr", `rm: ${args[0] ?? ""} is a non-empty directory (recursive removal is not supported)`);
        this.#lastExitCode = 1;
          return;
        }
        if (!this.#files.remove(target)) this.#line(session, "stderr", `rm: no such file or directory: ${args[0] ?? ""}`);
      this.#lastExitCode = 1;
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
        this.#lastExitCode = 1;
          return;
        }
        if (!this.terminate(pid)) this.#line(session, "stderr", `kill: no running process with pid ${pid}`);
      this.#lastExitCode = 1;
        return;
      }
      default:
        this.#line(session, "stderr", `${name}: not implemented`);
      this.#lastExitCode = 1;
    }
  }

  // ---------------------------------------------------------------- plumbing

  #snapshotFiles(): Record<string, ProjectFileContents> {
    const projectId = this.#files.projectId ?? "default";
    if (this.#dependencyProjectId !== projectId) {
      this.#dependencies.clear();
      this.#dependencyProjectId = projectId;
    }
    const snapshot: Record<string, ProjectFileContents> = { ...Object.fromEntries(this.#dependencies) };
    for (const path of this.#files.list()) {
      const contents = this.#files.read(path);
      if (contents !== null) snapshot[path] = contents;
    }
    return snapshot;
  }

  #activateProject(projectId: string): void {
    if (this.#runtimeProjectId !== null && this.#runtimeProjectId !== projectId) {
      this.#runtime.reset();
      for (const process of this.#processes.values()) {
        if (process.state !== "running") continue;
        process.state = "killed";
        process.endedAt = this.#now();
        const owner = this.findSession(process.sessionId);
        if (owner !== undefined) this.#line(owner, "system", `[${process.pid}] stopped because the active project changed`);
      }
    }
    this.#runtimeProjectId = projectId;
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

