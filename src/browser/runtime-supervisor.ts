import type { RuntimeRunOutcome, RuntimeRunRequest } from "../container/types.js";
import { InProcessRuntime } from "../runtime/in-process.js";
import { FileSystem } from "../vfs/index.js";
import type { WireRequest, WireResponse } from "../shims/http.js";

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

  async run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
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

  #loadProject(projectId: string, files: Readonly<Record<string, string>>): void {
    if (this.#projectId !== projectId) {
      this.dispose();
      const vfs = new FileSystem();
      this.#vfs = vfs;
      this.#runtime = new InProcessRuntime(vfs);
      this.#projectId = projectId;
    }
    const vfs = this.#vfs;
    if (vfs === null) throw new Error("runtime supervisor has no VFS");

    const nextPaths = new Set(Object.keys(files));
    for (const path of this.#mirroredFiles) {
      if (nextPaths.has(path)) continue;
      try {
        vfs.unlinkSync(path);
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
      if (existing === contents) continue;
      const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (parent !== "") vfs.mkdirSync(parent, { recursive: true });
      vfs.writeFileSync(path, contents);
    }
    this.#mirroredFiles.clear();
    for (const path of nextPaths) this.#mirroredFiles.add(path);
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
