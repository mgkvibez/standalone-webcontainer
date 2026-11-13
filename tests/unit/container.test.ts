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
import { createFakeRegistry } from "../helpers/registry.js";

class FakeProject implements ProjectFiles {
  readonly projectId = "test-project";
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

/**
 * An installed file's text.
 *
 * A snapshot carries installed files as the bytes they were extracted as, which is what keeps a wasm module loadable, so a test that cares about
 * source text decodes rather than assuming every entry is a string.
 */
const textOf = (files: Readonly<Record<string, unknown>> | undefined, path: string): string => {
  const contents = files?.[path];
  if (typeof contents === "string") return contents;
  if (contents instanceof Uint8Array) return new TextDecoder().decode(contents);
  throw new Error(`no contents at ${path}`);
};

class FakeRuntime implements RuntimeClient {
  readonly requests: RuntimeRunRequest[] = [];
  /** Every keystroke and resize the container forwarded, in order, so routing can be asserted rather than assumed. */
  readonly typed: { processId: number; text: string }[] = [];
  readonly resized: { processId: number; columns: number; rows: number }[] = [];
  /** Saved files handed to the live filesystem, in order: the seam that lets a running program see an edit. */
  readonly writes: { projectId: string; path: string; contents: string }[] = [];
  resets = 0;
  #hold: (() => void) | null = null;

  write(processId: number, text: string): void {
    this.typed.push({ processId, text });
  }

  resize(processId: number, columns: number, rows: number): void {
    this.resized.push({ processId, columns, rows });
  }

  writeFile(projectId: string, path: string, contents: string): void {
    this.writes.push({ projectId, path, contents });
  }

  /** Releases a held run, so a test can keep a process alive while it types into it. */
  release(): void {
    this.#hold?.();
  }

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
    expect(parseCommand("npm install")).toMatchObject({ kind: "install", args: ["install"] });
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
  it("installs from the injected offline registry into a volatile overlay", async () => {
    const project = new FakeProject({
      "/package.json": JSON.stringify({ dependencies: { "@corpus/hello": "^1.0.0" } }),
      "/index.js": 'console.log(require("@corpus/hello"));',
    });
    const runtime = new FakeRuntime();
    const registry = await createFakeRegistry({
      packages: { "@corpus/hello": [{ version: "1.0.0", files: { "index.js": 'module.exports = "installed";' } }] },
    });
    const container = new Container({ runtime, files: project, registry });
    const session = container.createSession();
    await container.execute(session.id, "npm install");
    const lockfile = project.read("/package-lock.json");
    expect(lockfile).not.toBeNull();
    expect(project.list().some((path) => path.includes("node_modules"))).toBe(false);
    await container.execute(session.id, "node index.js");
    expect(textOf(runtime.requests.at(-1)?.files, "/node_modules/@corpus/hello/index.js")).toContain("installed");
    expect(output(container, session.id)).toContain("stdout:added 1 package(s) from the offline corpus");
    await container.execute(session.id, "npm ci");
    expect(project.read("/package-lock.json")).toBe(lockfile);
    // A package argument is now a request the installer honours, so the corpus answers it the only way it can: not found.
    await container.execute(session.id, "npm install left-pad");
    expect(registry.fetched).toEqual(["@corpus/hello", "left-pad"]);
    // The double raises a plain error for an unpublished name, so the assertion is on the failure being reported and on nothing
    // being written for the package that failed, not on a code the double does not produce.
    expect(output(container, session.id).some((line) => line.includes("npm error:"))).toBe(true);
    expect(project.list().some((path) => path.includes("left-pad"))).toBe(false);
  });

  it("installs a package named on the command line, in a project with no package.json", async () => {
    const project = new FakeProject({ "/index.js": "console.log(1);" });
    const runtime = new FakeRuntime();
    const registry = await createFakeRegistry({
      packages: { "@corpus/hello": [{ version: "1.0.0", files: { "index.js": 'module.exports = "installed";' } }] },
    });
    const container = new Container({ runtime, files: project, registry });
    const session = container.createSession();

    await container.execute(session.id, "npm install @corpus/hello");

    expect(output(container, session.id)).toContain("stdout:added 1 package(s) from the offline corpus");
    expect(project.read("/package-lock.json")).not.toBeNull();
    // npm does not invent a manifest either: the install records what it did in the lockfile and nothing else.
    expect(project.read("/package.json")).toBeNull();
    await container.execute(session.id, "node index.js");
    expect(textOf(runtime.requests.at(-1)?.files, "/node_modules/@corpus/hello/index.js")).toContain("installed");
  });

  it("carries a package's binary file into the runtime unchanged", async () => {
    // The bytes are deliberately not valid UTF-8: 0xff and 0xfe have no encoding, so any decode on the way turns them into replacement
    // characters and the comparison fails. This is the shape of the bug that stopped vite: an 11 MB wasm went through `TextDecoder` while the
    // container staged the install, and the runtime then reported `CompileError: unknown section code #0x20`, which names the wasm and blames
    // nothing real. A whole wasm module does not belong in a unit test, so the payload here is the header plus the two bytes that broke it.
    const blob = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80]);
    const project = new FakeProject({ "/index.js": 'console.log(1);' });
    const runtime = new FakeRuntime();
    const registry = await createFakeRegistry({
      packages: {
        "@corpus/binary": [{ version: "1.0.0", files: { "index.js": 'module.exports = "binary";', "blob.wasm": blob } }],
      },
    });
    const container = new Container({ runtime, files: project, registry });
    const session = container.createSession();

    await container.execute(session.id, "npm install @corpus/binary");
    await container.execute(session.id, "node index.js");

    const carried = runtime.requests.at(-1)?.files["/node_modules/@corpus/binary/blob.wasm"];
    expect(carried).toBeInstanceOf(Uint8Array);
    expect([...(carried as Uint8Array)]).toEqual([...blob]);
    // The project store stays text: node_modules is runtime state and is never written into the project's own files.
    expect(project.list().some((path) => path.includes("node_modules"))).toBe(false);
  });

  it("saves a named package into an existing package.json, and refuses an unsupported flag", async () => {
    const project = new FakeProject({ "/package.json": JSON.stringify({ name: "p", version: "1.0.0" }) });
    const registry = await createFakeRegistry({
      packages: { "@corpus/hello": [{ version: "1.0.0", files: { "index.js": "module.exports = 1;" } }] },
    });
    const container = new Container({ runtime: new FakeRuntime(), files: project, registry });
    const session = container.createSession();

    await container.execute(session.id, "npm install @corpus/hello@^1.0.0");
    const manifest = JSON.parse(project.read("/package.json") ?? "{}");
    expect(manifest.dependencies).toEqual({ "@corpus/hello": "^1.0.0" });

    await container.execute(session.id, "npm install --save-dev @corpus/hello");
    expect(output(container, session.id).some((line) => line.includes("only --omit=dev and --production are supported"))).toBe(true);
  });

  it("refuses a spec kind it does not implement by naming that kind", async () => {
    const registry = await createFakeRegistry({ packages: {} });
    const container = new Container({ runtime: new FakeRuntime(), files: new FakeProject(), registry });
    const session = container.createSession();
    await container.execute(session.id, "npm install git+https://example.com/x.git");
    expect(output(container, session.id).some((line) => line.includes("installing from a URL or a git remote is not supported"))).toBe(true);
    await container.execute(session.id, "npm install ./local-folder");
    expect(output(container, session.id).some((line) => line.includes("installing from a folder or a local tarball is not supported"))).toBe(true);
  });

  it("does not accept package arguments or make registry installs without an injected corpus", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "npm install");
    expect(output(container, session.id).some((line) => line.includes("offline package corpus is unavailable"))).toBe(true);
    await container.execute(session.id, "npm install left-pad");
    expect(output(container, session.id).some((line) => line.includes("offline package corpus is unavailable"))).toBe(true);
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

/**
 * Interactive sessions: the container is the only thing between a keystroke and a program.
 *
 * These pin the routing rules, because every one of them is a chance to type into the wrong program: a size that outlives the
 * process that read it, input addressed to the process actually running, and input that goes nowhere when nothing is running
 * rather than to some earlier process's pid.
 */
describe("interactive sessions", () => {
  it("starts a session at 80x24 and tells the program it runs", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();

    expect([session.columns, session.rows]).toEqual([80, 24]);

    await container.execute(session.id, "node index.js");
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.terminal).toEqual({ columns: 80, rows: 24 });
  });

  it("types into the program that is running, not into the session's history", async () => {
    const { container, runtime } = containerWith({ runtime: { outcome: { killed: false } } });
    const session = container.createSession();

    // Typing with nothing running goes nowhere: this is a program's stdin, not a line editor.
    container.write(session.id, "ignored");
    expect(runtime.typed).toEqual([]);

    const running = container.execute(session.id, "node index.js");
    // The run is queued behind the container's queue, so the keystroke below lands while it is in flight.
    container.write(session.id, "hello\n");
    runtime.release();
    await running;

    expect(runtime.typed).toEqual([{ processId: 1, text: "hello\n" }]);
  });

  it("stops typing into a program once it has exited", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();

    await container.execute(session.id, "node index.js");
    container.write(session.id, "too late");

    // The process is over, so nothing is addressed. A stale pid would be worse: it could collide with a later process.
    expect(runtime.typed).toEqual([]);
  });

  it("carries a new size to the running program, and keeps it for the next one", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();

    // Nothing running: the size is still remembered, because the window does not shrink back when a program exits.
    container.resizeSession(session.id, 120, 40);
    expect([session.columns, session.rows]).toEqual([120, 40]);
    expect(runtime.resized).toEqual([]);

    await container.execute(session.id, "node index.js");
    expect(runtime.requests[0]?.terminal).toEqual({ columns: 120, rows: 40 });
  });

  it("forwards a resize to the program that is running", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();

    const running = container.execute(session.id, "node index.js");
    container.resizeSession(session.id, 100, 30);
    runtime.release();
    await running;

    expect(runtime.resized).toEqual([{ processId: 1, columns: 100, rows: 30 }]);
  });

  it("says nothing when the size did not change, because a TUI would redraw for nothing", () => {
    const { container, runtime } = containerWith();
    const session = container.createSession();

    container.resizeSession(session.id, 80, 24);
    expect(runtime.resized).toEqual([]);
  });

  it("refuses a nonsense size instead of carrying it", () => {
    const { container } = containerWith();
    const session = container.createSession();

    expect(() => container.resizeSession(session.id, 0, 24)).toThrow(RangeError);
    expect(() => container.resizeSession(session.id, 80, -1)).toThrow(RangeError);
    expect([session.columns, session.rows]).toEqual([80, 24]);
  });

  it("keeps sessions apart, so typing in one cannot reach another's program", async () => {
    const { container, runtime } = containerWith();
    const first = container.createSession();
    const second = container.createSession();

    const running = container.execute(first.id, "node index.js");
    container.write(second.id, "wrong session");
    runtime.release();
    await running;

    expect(runtime.typed).toEqual([]);
  });
});

/**
 * `npm run`, which eight of the twenty fixtures need and which was refused by name until now.
 *
 * The semantics being pinned are npm's, not ours: the script body is executed through this container, arguments are appended only
 * after `--`, a package-provided binary resolves through its `bin` field the way an `.bin` shim would, and a missing script is an
 * error that names it.
 */
describe("npm run", () => {
  it("lists the scripts when given no name", async () => {
    const { container } = containerWith({
      project: { "/package.json": JSON.stringify({ name: "p", scripts: { dev: "vite", build: "vite build" } }) },
    });
    const session = container.createSession();
    await container.execute(session.id, "npm run");
    expect(output(container, session.id)).toContain("stdout:available scripts: dev, build");
  });

  it("runs a script through the container, with npm's two header lines", async () => {
    const { container, runtime } = containerWith({
      project: {
        "/package.json": JSON.stringify({ name: "app", version: "1.2.3", scripts: { start: "node index.js" } }),
        "/index.js": "console.log(1);",
      },
    });
    const session = container.createSession();
    await container.execute(session.id, "npm run start");

    const lines = output(container, session.id);
    expect(lines).toContain("stdout:> app@1.2.3 start");
    expect(lines).toContain("stdout:> node index.js");
    expect(runtime.requests.at(-1)?.entry).toBe("/index.js");
  });

  it("appends arguments only after --, which is npm's rule", async () => {
    const project = {
      "/package.json": JSON.stringify({ name: "app", scripts: { dev: "node server.js" } }),
      "/server.js": "",
    };
    const withSeparator = containerWith({ project });
    const first = withSeparator.container.createSession();
    await withSeparator.container.execute(first.id, "npm run dev -- --port 3000 --host 127.0.0.1");
    expect(withSeparator.runtime.requests.at(-1)?.argv.join(" ")).toContain("--port 3000 --host 127.0.0.1");

    const withoutSeparator = containerWith({ project });
    const second = withoutSeparator.container.createSession();
    await withoutSeparator.container.execute(second.id, "npm run dev --port 3000");
    // Silently forwarding these would run something the fixture never asked for: npm treats them as npm's own arguments and ignores them.
    expect(withoutSeparator.runtime.requests.at(-1)?.argv.join(" ")).not.toContain("--port");
  });

  it("resolves a package-provided binary through its bin field, the way an .bin shim would", async () => {
    const project = new FakeProject({
      "/package.json": JSON.stringify({ name: "app", dependencies: { tool: "^1.0.0" }, scripts: { dev: "tool --host 127.0.0.1" } }),
    });
    const runtime = new FakeRuntime();
    const registry = await createFakeRegistry({
      packages: { tool: [{ version: "1.0.0", bin: { tool: "bin/cli.js" }, files: { "bin/cli.js": "console.log('tool');" } }] },
    });
    const container = new Container({ runtime, files: project, registry });
    const session = container.createSession();

    await container.execute(session.id, "npm install");
    await container.execute(session.id, "npm run dev");

    const request = runtime.requests.at(-1);
    expect(request?.entry).toBe("/node_modules/tool/bin/cli.js");
    expect(request?.argv.join(" ")).toContain("--host 127.0.0.1");
  });

  it("names a missing script and lists what exists", async () => {
    const { container } = containerWith({
      project: { "/package.json": JSON.stringify({ name: "app", scripts: { dev: "node index.js" } }) },
    });
    const session = container.createSession();
    await container.execute(session.id, "npm run build");
    expect(output(container, session.id).some((line) => line.includes('missing script: "build"') && line.includes("available: dev"))).toBe(true);
  });

  it("says there is no package.json rather than inventing one", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "npm run dev");
    expect(output(container, session.id).some((line) => line.includes("ENOENT") && line.includes("no package.json"))).toBe(true);
  });

  it("refuses a script whose command nothing provides, by name", async () => {
    const { container } = containerWith({
      project: { "/package.json": JSON.stringify({ name: "app", scripts: { dev: "vite" } }) },
    });
    const session = container.createSession();
    await container.execute(session.id, "npm run dev");
    expect(
      output(container, session.id).some((line) => line.includes("vite: not a command in this container") && line.includes("provides a \"vite\" binary")),
    ).toBe(true);
  });

  it("stops a script that calls itself", async () => {
    const { container } = containerWith({
      project: { "/package.json": JSON.stringify({ name: "app", scripts: { loop: "npm run loop" } }) },
    });
    const session = container.createSession();
    await container.execute(session.id, "npm run loop");
    expect(output(container, session.id).some((line) => line.includes("nested more than 8 deep"))).toBe(true);
  });
});

describe("saving into a live project (W-26)", () => {
  /**
   * The kernel reads a project's files as a SNAPSHOT when a run starts, so a save made later never reaches a program that is already running
   * unless the page hands it over. This is that seam: without it a dev server watches its module forever and hears nothing, which is exactly
   * what the browser lane showed before it existed.
   */
  it("hands a save to the running project", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession("one");
    await container.execute(session.id, "node index.js");

    container.pushFile("/app.js", "document.title = v2;");

    // The project id the run was started with, so the write lands in the same kernel the program is running in.
    expect(runtime.writes).toEqual([
      { projectId: "test-project", path: "/app.js", contents: "document.title = v2;" },
    ]);
  });

  it("drops a save made before anything was running, because the next run carries it", () => {
    const { container, runtime } = containerWith();

    container.pushFile("/app.js", "v1");

    // Not a swallowed error: the first run sends the whole snapshot, so a live write here would have nowhere to go.
    expect(runtime.writes).toEqual([]);
  });

  it("sends later saves to the same live project", async () => {
    const { container, runtime } = containerWith();
    const session = container.createSession("one");
    await container.execute(session.id, "node index.js");

    container.pushFile("/app.js", "v2");
    container.pushFile("/app.js", "v3");

    expect(runtime.writes.map((write) => write.contents)).toEqual(["v2", "v3"]);
  });
});

/**
 * The status of the last line, exposed because something other than a human reads it.
 *
 * The fixture harness inferred a command's exit status from the text on stderr. A refused command writes its reason to the SYSTEM
 * stream, matched no pattern, and was recorded as exiting 0 — so `npx tsc -p tsconfig.json` PASSED an exit-code assertion in
 * `fixture-12` while never running. These tests pin the status at the source so no caller has to infer it again.
 */
describe("the last exit status", () => {
  it("is 1 for a command refused by policy, which is the case that was being read as success", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    // `npx` itself is implemented now, so the case is a command this container still refuses BY POLICY, which is the shape that
    // writes to the system stream. That stream is the whole defect: a stderr-only reader saw nothing and called it success.
    await container.execute(session.id, "pnpm install");
    expect(container.lastExitCode).toBe(1);
    expect(output(container, session.id)).toContain("system:pnpm: pnpm is not available in the terminal yet (P1b).");
  });

  it("is 1 for a command this terminal does not implement at all", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "frobnicate --now");
    expect(container.lastExitCode).toBe(1);
  });

  it("is 0 for a command that succeeded, and reads the process's own code when one ran", async () => {
    const done = containerWith();
    const first = done.container.createSession();
    await done.container.execute(first.id, "cd /lib");
    expect(done.container.lastExitCode).toBe(0);
    await done.container.execute(first.id, "node index.js");
    expect(done.container.lastExitCode).toBe(0);

    const refused = containerWith({ runtime: { outcome: { exitCode: 2 } } });
    const second = refused.container.createSession();
    await refused.container.execute(second.id, "node index.js");
    expect(refused.container.lastExitCode).toBe(2);
  });

  it("is 0 for an install that wrote packages and 1 for one that failed", async () => {
    const project = new FakeProject({
      "/package.json": JSON.stringify({ dependencies: { "@corpus/hello": "^1.0.0" } }),
    });
    const registry = await createFakeRegistry({
      packages: { "@corpus/hello": [{ version: "1.0.0", files: { "index.js": 'module.exports = "installed";' } }] },
    });
    const container = new Container({ runtime: new FakeRuntime(), files: project, registry, now: () => 1_000 });
    const session = container.createSession();

    await container.execute(session.id, "npm install");
    expect(container.lastExitCode).toBe(0);
    // The double raises a plain error for an unpublished name, and the install reports it rather than throwing.
    await container.execute(session.id, "npm install left-pad");
    expect(container.lastExitCode).toBe(1);
  });

  it("is 1 when an install is asked for with no registry at all", async () => {
    const { container } = containerWith();
    const session = container.createSession();
    await container.execute(session.id, "npm install");
    expect(container.lastExitCode).toBe(1);
  });
});
