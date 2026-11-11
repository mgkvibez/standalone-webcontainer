import type { FileSyncReport, ProjectFileContents, RuntimeRunOutcome, RuntimeRunRequest, RuntimeSyncRequest } from "../container/types.js";
import { InProcessRuntime } from "../runtime/in-process.js";
import { FileSystem } from "../vfs/index.js";
import type { WireRequest, WireResponse } from "../shims/http.js";
import type { Terminal } from "../terminal/pty.js";

export type SupervisedProcessState = "queued" | "running" | "exited" | "failed" | "stopped";

export interface SupervisedProcess {
  readonly id: number;
  readonly entry: string;
  state: SupervisedProcessState;
  ports: number[];
}

/**
 * A single-project, Worker-owned runtime supervisor.
 *
 * The page supplies the latest project snapshot at each command boundary. This supervisor mirrors changes into one VFS
 * and keeps the runtime's port/gateway registry alive between commands. The project store remains the durable source;
 * the VFS, installed packages and servers are volatile runtime state. Transport requests carry no origin information.
 */
export class RuntimeSupervisor {
  #projectId: string | null = null;
  #vfs: FileSystem | null = null;
  #runtime: InProcessRuntime | null = null;
  readonly #mirroredFiles = new Set<string>();
  readonly #processes = new Map<number, SupervisedProcess>();
  #runQueue: Promise<void> = Promise.resolve();
  #nextProcessId = 1;

  processes(): readonly SupervisedProcess[] {
    return [...this.#processes.values()]
      .sort((left, right) => left.id - right.id)
      .map((process) => ({ ...process, ports: [...process.ports] }));
  }

  /**
   * `extras.terminal` is the Worker-built Terminal for this run, kept out of RuntimeRunRequest because that interface is the
   * container's and carries only plain data across the thread boundary.
   */
  async run(request: RuntimeRunRequest, extras: { terminal?: Terminal | null } = {}): Promise<RuntimeRunOutcome> {
    let outcome: RuntimeRunOutcome | undefined;
    const processId = request.processId ?? this.#nextProcessId++;
    const record: SupervisedProcess = { id: processId, entry: request.entry, state: "queued", ports: [] };
    this.#processes.set(processId, record);
    const task = this.#runQueue.then(async () => {
      try {
        this.#loadProject(request.projectId ?? "default", request.files);
        this.#processes.set(processId, record);
        record.state = "running";
        const runtime = this.#runtime;
        if (runtime === null) throw new Error("runtime supervisor failed to load a project");
        const before = new Set(runtime.ports.list().filter((binding) => binding.protocol === "http").map((binding) => binding.port));
        const result = await runtime.run(request.entry, {
          argv: [...request.argv],
          cwd: request.cwd,
          env: { ...request.env },
          timeoutMs: request.timeoutMs,
          onOutput: request.onOutput,
          ...(extras.terminal === undefined || extras.terminal === null ? {} : { terminal: extras.terminal }),
        });
        const started = runtime.ports.list()
          .filter((binding) => binding.protocol === "http" && !before.has(binding.port))
          .map((binding) => binding.port);
        record.ports = started;
        record.state = started.length > 0 && result.exitCode === 0 && !result.timedOut
          ? "running"
          : result.timedOut || result.exitCode !== 0
            ? "failed"
            : "exited";
        outcome = { ...result, killed: false, previewPorts: started };
      } catch (error) {
        record.state = "failed";
        throw error;
      }
    });
    this.#runQueue = task.then(() => undefined, () => undefined);
    await task;
    if (outcome === undefined) throw new Error("runtime supervisor completed without a run result");
    return outcome;
  }

  /** Pass a transport request to the active project's in-memory servers. */
  async handleTransport(request: WireRequest): Promise<WireResponse> {
    if (this.#runtime === null) return text(503, "No project runtime is loaded.");
    return this.#runtime.gateway.handle(request);
  }

  /**
   * Read a file from the live project VFS.
   *
   * A program's writes exist only here. The page supplies the project snapshot at each command boundary and the runtime's VFS is
   * the only place a `fs.writeFileSync` inside a program lands, so anything that wants to know what a program actually produced
   * (the fixture harness's `file-exists` assertion, and later a download or a diff) has to read the VFS rather than the snapshot.
   *
   * `null` means "nothing to read": a missing file, or a runtime that has been disposed. Both are the same answer to the only
   * question this method answers, and neither is an error.
   */
  readRuntimeFile(path: string): string | null {
    const vfs = this.#vfs;
    if (vfs === null) return null;
    try {
      const value = vfs.readFileSync(path.startsWith("/") ? path : `/${path}`, "utf8");
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }

  /** Stop servers owned by a process without throwing away the project VFS or other listening servers. */
  stopServers(ports: readonly number[]): readonly number[] {
    const stopped = this.#runtime?.gateway.closeServers(ports) ?? [];
    for (const process of this.#processes.values()) {
      if (process.state !== "running" || !process.ports.some((port) => stopped.includes(port))) continue;
      process.state = "stopped";
      process.ports = process.ports.filter((port) => !stopped.includes(port));
    }
    return stopped;
  }

  /** Drop the active project runtime and reject any requests that were waiting on its gateway. */
  dispose(): void {
    this.#runtime?.gateway.closeAll();
    this.#runtime?.gateway.closeServers();
    this.#runtime = null;
    this.#vfs = null;
    this.#projectId = null;
    this.#mirroredFiles.clear();
    this.#processes.clear();
  }

  /**
   * Load a project's files, creating its runtime the first time a project is seen.
   *
   * Returns what the mirroring did, so a caller can tell an applied change from a no-op instead of assuming both are the same thing.
   */
  #loadProject(projectId: string, files: Readonly<Record<string, ProjectFileContents>>): FileSyncReport {
    if (this.#projectId !== projectId) {
      this.dispose();
      const vfs = new FileSystem();
      this.#vfs = vfs;
      this.#runtime = new InProcessRuntime(vfs);
      this.#projectId = projectId;
    }
    return this.#mirror(files);
  }

  /**
   * Bring a loaded project's VFS up to date without starting a run.
   *
   * The VFS is the live filesystem: a program already running keeps the paths it opened, so a write here is what an editor's save looks like
   * from inside a dev server. Nothing is invented when no runtime is loaded — that is reported as `live: false`, because the next run mirrors
   * the snapshot and a caller told otherwise would believe a preview had been updated when nothing had been pushed.
   */
  async syncFiles(request: RuntimeSyncRequest): Promise<FileSyncReport> {
    const projectId = request.projectId ?? "default";
    if (this.#vfs === null || this.#projectId !== projectId) {
      return { live: false, written: [], removed: [] };
    }
    return this.#mirror(request.files, { authoritative: false, removed: request.removed ?? [] });
  }

  /**
   * Mirror files into the live VFS: write what differs, remove what is gone, leave everything else untouched.
   *
   * `authoritative` is the difference between a run and a save. A run carries the whole project, so a path it no longer mentions was deleted by
   * the page and must go. A save names only what it touched, so silence about a path means nothing and only the explicit list removes.
   */
  #mirror(
    files: Readonly<Record<string, ProjectFileContents>>,
    options: { readonly authoritative: boolean; readonly removed: readonly string[] } = { authoritative: true, removed: [] },
  ): FileSyncReport {
    const vfs = this.#vfs;
    if (vfs === null) throw new Error("runtime supervisor has no VFS");

    const written: string[] = [];
    const removed: string[] = [];
    const nextPaths = new Set(Object.keys(files));
    const gone = options.authoritative
      ? [...this.#mirroredFiles].filter((path) => !nextPaths.has(path))
      : options.removed;
    for (const path of gone) {
      try {
        vfs.unlinkSync(path);
        removed.push(path);
      } catch {
        // A runtime may already have removed the page-owned file; the incoming snapshot is authoritative.
      }
    }
    for (const [path, contents] of Object.entries(files)) {
      let existing: string | null = null;
      try {
        const value = vfs.readFileSync(path, "utf8");
        existing = typeof value === "string" ? value : new TextDecoder().decode(value);
      } catch {
        // Missing files are created below, with their parents.
      }
      // Only a string can be compared against a text read. A byte file is always written, because the comparison above decoded it and a decode is
      // not an equality test: two different byte sequences can decode to the same replacement-character text.
      if (typeof contents === "string" && existing === contents) continue;
      const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (parent !== "") vfs.mkdirSync(parent, { recursive: true });
      vfs.writeFileSync(path, contents);
      written.push(path);
    }
    if (options.authoritative) {
      this.#mirroredFiles.clear();
      for (const path of nextPaths) this.#mirroredFiles.add(path);
    } else {
      for (const path of nextPaths) this.#mirroredFiles.add(path);
      for (const path of removed) this.#mirroredFiles.delete(path);
    }
    return { live: true, written, removed };
  }
}

function text(statusCode: number, message: string): WireResponse {
  const body = new TextEncoder().encode(message);
  return {
    statusCode,
    statusMessage: "",
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(body.byteLength) },
    body,
  };
}
