/**
 * The fixture harness's runtime client: one thread, no Worker.
 *
 * The product runs every command in its own process Worker behind a kernel (`src/browser/runtime.worker.ts`). The harness cannot, and this
 * class is where that difference is stated rather than hidden: a fixture measures Node COMPATIBILITY — does this program behave like it
 * does under Node — and the thread it runs on is not part of that question. What it gives up is exactly what the process model added:
 * a `while (true)` in a fixture blocks this process until the guard kills it, and two fixtures cannot run concurrently.
 *
 * What it deliberately does NOT do is re-implement the interesting half. The `InProcessRuntime` is the same runtime a process Worker
 * builds, the `FileSystem` is the same filesystem the kernel owns, and the gateway is the same one a preview request reaches. This class
 * only wires them together per run and adapts the result shape.
 *
 * This replaced `RuntimeSupervisor`. That class existed to serialise runs and to rebuild a VFS per run; runs here are already serial, and
 * a fresh runtime per fixture is the isolation the supervisor was approximating.
 */

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createProjectMirror } from "../../src/process/project-mirror.js";
import type { RuntimeClient, RuntimeRunOutcome, RuntimeRunRequest } from "../../src/container/types.js";
import type { HttpProbe } from "../../src/harness/assertions.js";
import { createTerminal } from "../../src/terminal/pty.js";
import { previewRequestUrl } from "../../src/harness/preview-target.js";

/**
 * How long a run that owns a listening port is given to finish printing before its outcome is handed back.
 *
 * This affects CAPTURED OUTPUT ONLY. It cannot make a server ready: readiness is a real HTTP request (`tools/harness/readiness.ts`),
 * and a program that binds a port and prints nothing still gets no banner to point at.
 */
const HOLD_GRACE_MS = 250;

/** How often a live run's port registry is read while the program is still going. */
const PORT_POLL_MS = 5;

export class InProcessClient implements RuntimeClient {
  #files = new FileSystem();
  #runtime = new InProcessRuntime(this.#files);
  readonly #mirror = createProjectMirror();
  readonly #portListeners = new Set<(processId: number, ports: readonly number[]) => void>();

  async run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    // ONE runtime per fixture, not per command, which is what W-28 turned out to need.
    //
    // The product keeps a kernel per project, so a command that leaves a server listening is still there for the next command. This
    // client used to build a fresh filesystem and runtime for every run, which is stricter about isolation and wrong about
    // continuity: fixture-13 starts a dev server, edits a file in a LATER step, and asks the same server what it now serves. With a
    // runtime per run, step 2's edit landed in a brand-new filesystem and the observation at the end of step 2 found no server on
    // port 3300 at all. Isolation between FIXTURES is preserved by `reset()`, which the runner calls once per definition.
    this.#mirror.reset();
    const target = this.#files;
    this.#mirror.sync(
      {
        readFile: () => null,
        writeFile: (path, contents) => {
          const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
          if (parent !== "") target.mkdirSync(parent, { recursive: true });
          target.writeFileSync(path, contents);
        },
        unlink: (path) => target.unlinkSync(path),
      },
      request.files,
    );

    const httpPorts = (): readonly number[] =>
      this.#runtime.ports
        .list()
        .filter((binding) => binding.protocol === "http")
        .map((binding) => binding.port);
    const before = new Set(httpPorts());
    const fresh = (): readonly number[] => httpPorts().filter((port) => !before.has(port));

    // The output is re-collected here as well as forwarded, because a run that is held open never returns its own stdout: its body
    // has not settled, so there is no outcome to read it from. Faking an outcome needs the bytes it already printed.
    const printed: string[] = [];
    const run = this.#runtime.run(request.entry, {
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      onOutput: (stream, text) => {
        if (stream === "stdout") printed.push(text);
        request.onOutput(stream, text);
      },
      ...(request.terminal === undefined ? {} : { terminal: createTerminal(request.terminal) }),
    });

    /**
     * The hold-open rule, applied where this client can see it (W-28).
     *
     * Node keeps a process alive for a listening server, so `run` would never return and a fixture's budget would end the step as a
     * TIMEOUT — the exact shape measured on fixtures 01 and 13. The product answers this in ProcessHost (`holdOpen`): the process
     * settles, but it is not retired. Here the same answer is a race: the first http port to appear settles the run and leaves the
     * program running, so its server can be probed, and its ports are reported the moment they exist rather than at a settle that
     * never comes.
     */
    const held = new Promise<readonly number[]>((resolve) => {
      const poll = setInterval(() => {
        const ports = fresh();
        if (ports.length > 0) resolve(ports);
      }, PORT_POLL_MS);
      // Unref'd where the host allows it, so a probe script does not fail to exit because of this timer.
      (poll as unknown as { unref?: () => void }).unref?.();
    });

    const settled = await Promise.race([
      run.then((result) => ({ kind: "settled" as const, result })),
      held.then((ports) => ({ kind: "held" as const, ports })),
    ]);

    if (settled.kind === "held") {
      // Report the ports immediately: a preview list must not wait for a settle that cannot come.
      for (const listener of this.#portListeners) listener(request.processId ?? 0, fresh());
      // A short grace so a banner printed just after bind() is captured. It cannot make an unready server ready.
      await Promise.race([run.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, HOLD_GRACE_MS))]);
      for (const listener of this.#portListeners) listener(request.processId ?? 0, fresh());
      return {
        stdout: printed.join(""),
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        killed: false,
        previewPorts: fresh(),
      };
    }

    // A run that went on after the hold must not become an unhandled rejection; its output already reached the caller.
    run.catch(() => undefined);
    const previewPorts = fresh();
    if (previewPorts.length > 0) {
      for (const listener of this.#portListeners) listener(request.processId ?? 0, previewPorts);
    }
    return { ...settled.result, killed: false, previewPorts };
  }

  /**
   * Discard this fixture's runtime, filesystem and servers.
   *
   * This is the isolation boundary now: one runtime lives for the length of a fixture so a server can outlive the command that
   * started it, and nothing survives into the next fixture. Servers are closed rather than abandoned, so a later fixture cannot be
   * answered by a port it never bound.
   */
  reset(): void {
    this.#runtime.closeServers();
    this.#files = new FileSystem();
    this.#runtime = new InProcessRuntime(this.#files);
  }

  /**
   * Ports as this runtime knows them right now, whether or not the run that bound them has settled.
   *
   * The observation the harness was missing: `containerPorts=[]` was the harness not asking, not the runtime not knowing.
   */
  boundPorts(): readonly number[] {
    return this.#runtime.ports
      .list()
      .filter((binding) => binding.protocol === "http")
      .map((binding) => binding.port);
  }

  /**
   * Ports a process is serving, as they appear.
   *
   * Single-threaded, so this is a poll of the same registry the product reads across a MessagePort boundary: the fact reported is
   * identical, only the transport differs. Called from `run`, so a listener sees a port the moment it is bound.
   */
  onPorts(listener: (processId: number, ports: readonly number[]) => void): () => void {
    this.#portListeners.add(listener);
    return () => this.#portListeners.delete(listener);
  }

  /** Deterministic shutdown: close every server this runtime started and report the ports that stopped answering. */
  stopServers(): readonly number[] {
    return this.#runtime.closeServers();
  }

  /** What a program wrote, which the project snapshot cannot show. */
  readFile(path: string): string | null {
    try {
      const value = this.#files.readFileSync(path.startsWith("/") ? path : `/${path}`, "utf8");
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }

  /**
   * Ask the preview gateway for a URL, exactly as the browser's proxy does.
   *
   * The gateway resolves the port from the URL, so a fixture's `http://localhost:3000/` target reaches the server the program started on
   * 3000. A response is evidence; only a gateway that throws is a probe fault.
   */
  async probe(url: string): Promise<HttpProbe> {
    const response = await this.#runtime.gateway.handle({
      method: "GET",
      url: previewRequestUrl(url),
      headers: {},
      body: new Uint8Array(0),
    });
    return { status: response.statusCode, body: new TextDecoder().decode(response.body) };
  }
}
