/**
 * The container layer, against a fake runtime and a fake project.
 *
 * These are the semantics a terminal depends on: pids, states, exit codes, streaming output, termination, session
 * isolation and honest refusal. Proving them here means the browser tests only have to prove that the page wires them up.
 */

import { describe, expect, it } from "vitest";

import { Container } from "../../src/container/container.js";
import { parseCommand, resolvePath, tokenize } from "../../src/container/commands.js";
import type { ProcessRecord, ProjectFiles, RuntimeClient, RuntimeRunOutcome, RuntimeRunRequest } from "../../src/container/types.js";

class FakeProject implements ProjectFiles {
  readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, contents] of Object.entries(initial)) this.files.set(path, contents);
  }

  list(): readonly string[] {
    return [...this.files.keys()].sort();
  }

  listDirs(): readonly string[] {
    const dirs = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split("/").filter((part) => part !== "");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        dirs.add(current);
      }
    }
    return [...dirs].sort();
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  mkdir(path: string): boolean {
    if (this.listDirs().includes(path)) return false;
    this.files.set(`${path}/.keep`, "");
    return true;
  }

  remove(path: string): boolean {
    if (this.files.delete(path)) return true;
    return this.files.delete(`${path}/.keep`);
  }
}

interface FakeRuntimeOptions {
  readonly outcome?: Partial<RuntimeRunOutcome>;
  /** Scripted output, delivered chunk by chunk through onOutput before the run resolves. */
  readonly chunks?: ReadonlyArray<readonly ["stdout" | "stderr", string]>;
  readonly throwWith?: string;
}

class FakeRuntime implements RuntimeClient {
  readonly requests: RuntimeRunRequest[] = [];
  resets = 0;
  #hold: (() => void) | null = null;

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async run(request: RuntimeRunRequest): Promise<RuntimeRunOutcome> {
    this.requests.push(request);
    for (const [stream, text] of this.options.chunks ?? []) {
      request.onOutput(stream, text);
    }

    if (this.options.throwWith !== undefined) throw new Error(this.options.throwWith);

    if (this.options.outcome?.killed === true) {
      // A hard stop: the promise never settles on its own, so the test releases it.
      await new Promise<void>((resolve) => {
        this.#hold = resolve;
      });
    }

    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      killed: false,
      ...this.options.outcome,
    };
  }

  reset(): void {
    this.resets += 1;
    this.#hold?.();
  }
}

const containerWith = (
  options: { readonly project?: Record<string, string>; readonly runtime?: FakeRuntimeOptions } = {},
): { container: Container; project: FakeProject; runtime: FakeRuntime } => {
  const project = new FakeProject(options.project ?? { "/index.js": "console.log(1);", "/lib/util.js": "" });
  const runtime = new FakeRuntime(options.runtime ?? {});
  const container = new Container({ runtime, files: project, now: () => 1_000 });
  return { container, project, runtime };
};

const output = (container: Container, sessionId: string): string[] =>
  (container.findSession(sessionId)?.scrollback ?? []).map((line) => `${line.stream}:${line.text}`);

describe("command parsing", () => {
  it("splits on spaces and honours quotes", () => {
    expect(tokenize('node "my file.js" a b')).toEqual({ ok: true, tokens: ["node", "my file.js", "a", "b"] });
    expect(tokenize("echo 'a b' c")).toEqual({ ok: true, tokens: ["echo", "a b", "c"] });
  });

  it("reports unbalanced quotes instead of guessing", () => {
    expect(tokenize('echo "unclosed')).toEqual({ ok: false, error: 'unbalanced " quote' });
  });

  it("classifies the finite command set", () => {
    expect(parseCommand("node index.js")).toEqual({ kind: "process", name: "node", args: ["index.js"] });
    expect(parseCommand("pwd")).toEqual({ kind: "builtin", name: "pwd", args: [] });
    expect(parseCommand("npm install")).toMatchObject({ kind: "refused", name: "npm" });
    expect(parseCommand("cargo build")).toEqual({ kind: "unsupported", name: "cargo" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });

  it("resolves paths without escaping the project root", () => {
    expect(resolvePath("/app", "../etc")).toBe("/etc");
    expect(resolvePath("/", "../../x")).toBe("/x");
    expect(resolvePath("/app", "./a/../b")).toBe("/app/b");
  });
});

describe("sessions", () => {
  it("gives each session its own working directory and scrollback", async () => {
    const { container, project } = containerWith();
    project.mkdir("/src");
    const first = container.createSession("one");
    const second = container.createSession("two");

    await container.execute(first.id, "cd /src");
    await container.execute(first.id, "pwd");
    await container.execute(second.id, "pwd");

    expect(first.cwd).toBe("/src");
    expect(second.cwd).toBe("/");
    expect(output(container, first.id)).toContain("stdout:/src");
    expect(output(container, second.id)).toContain("stdout:/");
    expect(output(container, second.id)).not.toContain("stdout:/src");
  });

  it("keeps command history per session", async () => {
    const { container } = containerWith();
    const first = container.createSession();
    const second = container.createSession();
    await container.execute(first.id, "echo one");
    expect(first.history).toEqual(["echo one"]);
    expect(second.history).toEqual([]);
  });
});

describe("file commands", () => {
  it("lists, reads, creates and removes through the project files", async () => {
    const { container, project } = containerWith();
    const session = container.createSession();

    await container.execute(session.id, "ls");
    expect(output(container, session.id)).toContain("stdout:index.js  lib/");

    await container.execute(session.id, "cat index.js");
    expect(output(container, session.id)).toContain("stdout:console.log(1);");

    await container.execute(session.id, "touch notes.txt");
    expect(project.read("/notes.txt")).toBe("");

    await container.execute(session.id, "rm notes.txt");
    expect(project.read("/notes.txt")).toBe(null);
  });

  it("refuses to remove a non-empty directory rather than pretending -r exists", async () => {
    const { container, project } = containerWith();
    project.mkdir("/src");
    project.write("/src/a.js", "");
    const session = container.createSession();
    await container.execute(session.id, "rm src");
    expect(output(container, session.id).some((line) => line.includes("non-empty directory"))).toBe(true);
    expect(project.read("/src/a.js")).toBe("");
  });

  it("reports a missing file as an error on stderr, not stdout", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "cat nope.js");
    expect(output(container, session.id).some((line) => line.startsWith("stderr:cat: no such file"))).toBe(true);
  });
});

describe("processes", () => {
  it("runs a file through the runtime and reports its exit code", async () => {
    const { container, runtime } = containerWith({ runtime: { outcome: { exitCode: 3 } } });
    const session = container.createSession();

    await container.execute(session.id, "node index.js");
    const [process] = container.processes();

    expect(process).toMatchObject({ state: "exited", exitCode: 3, cwd: "/" });
    expect(runtime.requests[0]?.entry).toBe("/index.js");
    expect(runtime.requests[0]?.argv).toEqual(["node", "/index.js"]);
    expect(output(container, session.id)).toContain("system:[1] exited with code 3");
  });

  it("passes arguments and the session working directory to the runtime", async () => {
    const { container, project, runtime } = containerWith();
    project.write("/src/main.js", "");
    const session = container.createSession();
    await container.execute(session.id, "cd /src");
    await container.execute(session.id, "node main.js --flag value");

    expect(runtime.requests[0]?.cwd).toBe("/src");
    expect(runtime.requests[0]?.argv).toEqual(["node", "/src/main.js", "--flag", "value"]);
    expect(runtime.requests[0]?.files["/src/main.js"]).toBe("");
  });

  it("streams stdout and stderr separately as the process writes", async () => {
    const { container } = containerWith({
      runtime: { chunks: [["stdout", "first\n"], ["stderr", "bad\n"], ["stdout", "second\n"]] },
    });
    const session = container.createSession();
    await container.execute(session.id, "node index.js");

    const lines = output(container, session.id);
    expect(lines).toContain("stdout:first");
    expect(lines).toContain("stderr:bad");
    expect(lines).toContain("stdout:second");
    // Order is preserved and the streams stay labelled.
    expect(lines.indexOf("stdout:first")).toBeLessThan(lines.indexOf("stderr:bad"));
  });

  it("joins chunk boundaries into whole lines", async () => {
    const { container } = containerWith({ runtime: { chunks: [["stdout", "par"], ["stdout", "tial\n"]] } });
    const session = container.createSession();
    await container.execute(session.id, "node index.js");
    expect(output(container, session.id)).toContain("stdout:partial");
  });

  it("reports a runtime throw as a failed process, not as a success", async () => {
    const { container } = containerWith({ runtime: { throwWith: "host exploded" } });
    const session = container.createSession();
    await container.execute(session.id, "node index.js");

    const [process] = container.processes();
    expect(process?.state).toBe("failed");
    expect(process?.exitCode).toBeUndefined();
    expect(output(container, session.id).some((line) => line.includes("host exploded"))).toBe(true);
  });

  it("stops a running process by discarding the host and records it as killed", async () => {
    const { container, runtime } = containerWith({ runtime: { outcome: { killed: true } } });
    const session = container.createSession();

    const running = container.execute(session.id, "node index.js");
    await Promise.resolve();
    await Promise.resolve();

    const [process] = container.processes();
    expect(process?.state).toBe("running");
    expect(container.terminate(process?.pid ?? 0)).toBe(true);
    await running;

    expect(runtime.resets).toBe(1);
    expect(container.processes()[0]?.state).toBe("killed");
    // No invented exit code: the program never produced one.
    expect(container.processes()[0]?.exitCode).toBeUndefined();
    expect(output(container, session.id)).toContain("system:[1] terminated");
  });

  it("runs a fresh process after a termination", async () => {
    const { container, runtime } = containerWith({ runtime: { outcome: { killed: true } } });
    const session = container.createSession();
    const running = container.execute(session.id, "node index.js");
    await Promise.resolve();
    await Promise.resolve();
    container.terminate(1);
    await running;

    // The same container serves the next command from a healthy host.
    expect(runtime.resets).toBe(1);
    await container.execute(session.id, "pwd");
    expect(output(container, session.id).at(-1)).toBe("stdout:/");
  });

  it("does not run a process that was killed while queued", async () => {
    const { container, runtime } = containerWith({ runtime: { outcome: { killed: true } } });
    const session = container.createSession();

    const first = container.execute(session.id, "node index.js");
    await Promise.resolve();
    await Promise.resolve();
    const second = container.execute(session.id, "node lib/util.js");
    await Promise.resolve();

    const queued = container.processes()[1];
    expect(queued?.state).toBe("queued");
    expect(container.terminate(queued?.pid ?? 0)).toBe(true);
    container.terminate(1);
    await Promise.all([first, second]);

    expect(runtime.requests).toHaveLength(1);
    expect(container.processes()[1]?.state).toBe("killed");
  });

  it("keeps pids and states independent of session identity", async () => {
    const { container } = containerWith();
    const first = container.createSession();
    const second = container.createSession();
    await container.execute(first.id, "node index.js");
    await container.execute(second.id, "node lib/util.js");

    const processes = container.processes();
    expect(processes.map((process) => process.pid)).toEqual([1, 2]);
    expect(processes.map((process) => process.sessionId)).toEqual([first.id, second.id]);
    expect(processes.every((process: ProcessRecord) => process.state === "exited")).toBe(true);
  });
});

describe("honest refusal", () => {
  it("refuses npm by name with a reason", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "npm install");
    const lines = output(container, session.id);
    expect(lines.some((line) => line.startsWith("system:npm:"))).toBe(true);
    expect(lines.some((line) => line.includes("not wired into the terminal"))).toBe(true);
  });

  it("refuses an unknown command and points at help", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "cargo build");
    expect(output(container, session.id).some((line) => line.includes("not a supported command"))).toBe(true);
  });

  it("refuses node -e instead of pretending to support it", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "node -e 'console.log(1)'");
    expect(runtime.requests).toHaveLength(0);
    expect(output(container, session.id).some((line) => line.includes("-e is not supported"))).toBe(true);
  });

  it("names a missing entry file rather than starting an empty run", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "node missing.js");
    expect(runtime.requests).toHaveLength(0);
    expect(output(container, session.id).some((line) => line.includes("cannot find module '/missing.js'"))).toBe(true);
  });
});
