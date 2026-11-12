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

export class InProcessClient implements RuntimeClient {
  #files = new FileSystem();
  #runtime = new InProcessRuntime(this.#files);
  readonly #mirror = createProjectMirror();

  async run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    // A fresh filesystem and runtime per run, seeded from the request's snapshot. The product's container does this diffing at each
    // command boundary against a kernel that outlives the run; here the fixture is the whole world, so starting clean is both simpler
    // and stricter: nothing one fixture writes can be seen by the next.
    this.#files = new FileSystem();
    this.#runtime = new InProcessRuntime(this.#files);
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

    const before = new Set(this.#runtime.ports.list().filter((binding) => binding.protocol === "http").map((binding) => binding.port));
    const result = await this.#runtime.run(request.entry, {
      argv: [...request.argv],
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      onOutput: request.onOutput,
      ...(request.terminal === undefined ? {} : { terminal: createTerminal(request.terminal) }),
    });
    const previewPorts = this.#runtime.ports
      .list()
      .filter((binding) => binding.protocol === "http" && !before.has(binding.port))
      .map((binding) => binding.port);
    return { ...result, killed: false, previewPorts };
  }

  /**
   * Nothing to discard between fixtures, because each one gets a fresh runtime.
   *
   * Kept as a no-op rather than removed: the interface asks a client whether it can reset, and "always already reset" is a different
   * answer from "cannot".
   */
  reset(): void {
    return undefined;
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
