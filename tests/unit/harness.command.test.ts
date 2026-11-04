/**
 * The step interpreter: what a fixture's command string means, and what happens when we run it.
 *
 * Two properties matter more than any individual assertion here. First, shell syntax is refused rather than partly
 * honoured, because scoring half a command is worse than scoring none. Second, a capability we have not built is a
 * HARNESS fault, not a runtime refusal: the difference decides whether a missing feature looks like a design decision.
 */

import { describe, expect, it } from "vitest";

import { parseStepCommand } from "../../src/harness/command.js";
import { createStepExecutor, type StepRuntime } from "../../src/harness/execute.js";
import { decideVerdict, type StepRun } from "../../src/harness/runner.js";
import type { FixtureStep } from "../../src/harness/definition.js";

const step = (command: string): FixtureStep => ({
  kind: "install",
  command,
  timeoutClass: "install",
  purpose: "test step",
});

describe("parseStepCommand", () => {
  it("reads a plain install, including npm's aliases", () => {
    expect(parseStepCommand("npm install")).toEqual({ kind: "install", ci: false, omitDev: false });
    expect(parseStepCommand("npm i")).toEqual({ kind: "install", ci: false, omitDev: false });
    expect(parseStepCommand("npm ci")).toEqual({ kind: "install", ci: true, omitDev: false });
  });

  it("treats --production and --omit=dev as the same tree, and refuses contradictory flags", () => {
    expect(parseStepCommand("npm install --production")).toEqual({ kind: "install", ci: false, omitDev: true });
    expect(parseStepCommand("npm install --omit=dev")).toEqual({ kind: "install", ci: false, omitDev: true });
    const contradiction = parseStepCommand("npm install --production --include=dev");
    expect(contradiction.kind).toBe("invalid");
  });

  it("refuses an unknown install flag instead of ignoring it", () => {
    const plan = parseStepCommand("npm install --omit=optional --install-strategy=linked");
    expect(plan.kind).toBe("invalid");
    expect(plan.kind === "invalid" && plan.reason).toMatch(/install-strategy/);
  });

  it("refuses installing packages that are not in package.json", () => {
    const plan = parseStepCommand("npm install left-pad@1.3.0");
    expect(plan.kind).toBe("invalid");
    expect(plan.kind === "invalid" && plan.reason).toMatch(/not in package\.json/);
  });

  it("forwards script arguments only after a bare --, as npm does", () => {
    expect(parseStepCommand("npm run dev -- --port 3000 --host 127.0.0.1")).toEqual({
      kind: "run-script",
      script: "dev",
      args: ["--port", "3000", "--host", "127.0.0.1"],
    });
    // Without the separator npm keeps these as its own flags, so the script gets nothing.
    expect(parseStepCommand("npm run build --watch")).toEqual({ kind: "run-script", script: "build", args: [] });
  });

  it("maps npm test to the test script", () => {
    expect(parseStepCommand("npm test")).toEqual({ kind: "run-script", script: "test", args: [] });
  });

  it("parses node programs and bare binaries", () => {
    expect(parseStepCommand("node scripts/check.js --strict")).toEqual({
      kind: "node",
      entry: "scripts/check.js",
      args: ["--strict"],
    });
    expect(parseStepCommand("vite build")).toEqual({ kind: "exec", bin: "vite", args: ["build"] });
  });

  it("honours quotes so an argument may contain a space", () => {
    expect(parseStepCommand('node app.js --message "hello world"')).toEqual({
      kind: "node",
      entry: "app.js",
      args: ["--message", "hello world"],
    });
  });

  it("refuses shell syntax rather than silently dropping it", () => {
    for (const command of ["npm install && node x.js", "node x.js | tee log", "node x.js > out.txt", "node $(whoami)"]) {
      const plan = parseStepCommand(command);
      expect(plan.kind).toBe("invalid");
      expect(plan.kind === "invalid" && plan.reason).toMatch(/shell syntax/);
    }
  });

  it("reports an unterminated quote instead of guessing where the argument ends", () => {
    const plan = parseStepCommand('node app.js --message "unclosed');
    expect(plan.kind).toBe("invalid");
    expect(plan.kind === "invalid" && plan.reason).toMatch(/unterminated/);
  });
});

describe("createStepExecutor", () => {
  const fakeRuntime = (overrides: Partial<StepRuntime> = {}): StepRuntime & { installs: number } => {
    const calls = { installs: 0 };
    const runtime: StepRuntime & { installs: number } = {
      get installs() {
        return calls.installs;
      },
      async install() {
        calls.installs += 1;
        return { packages: [{}, {}], warnings: [], usedLockfile: true };
      },
      async run() {
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
      ...overrides,
    };
    return runtime;
  };

  const executor = (runtime: StepRuntime): ReturnType<typeof createStepExecutor> =>
    createStepExecutor({ runtime, registry: { packument: async () => ({ versions: {} }) as never, tarball: async () => new Uint8Array() } });

  it("runs an install step through the runtime and reports what npm would have printed", async () => {
    const runtime = fakeRuntime();
    const result = await executor(runtime)(step("npm install"), 0);
    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(0);
    expect(result.record?.stdout).toContain("installed 2 package(s)");
    expect(runtime.installs).toBe(1);
  });

  it("maps --omit=dev onto includeDev: false", async () => {
    let seen: boolean | undefined;
    const runtime = fakeRuntime({
      async install(options: { includeDev?: boolean }) {
        seen = options.includeDev;
        return { packages: [], warnings: [], usedLockfile: true };
      },
    });
    await executor(runtime)(step("npm install --omit=dev"), 0);
    expect(seen).toBe(false);
  });

  it("fails npm ci with npm's own message when there is no lockfile", async () => {
    const runtime = fakeRuntime({
      async install() {
        return { packages: [], warnings: [], usedLockfile: false };
      },
    });
    const result = await executor(runtime)(step("npm ci"), 0);
    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(1);
    expect(result.record?.stderr).toContain("can only install packages when your package.json");
  });

  it("reports a refusing installer as an npm failure, not a harness crash", async () => {
    const runtime = fakeRuntime({
      async install() {
        throw new Error("MISSING_PACKAGE_JSON: no package.json at /app/package.json");
      },
    });
    const result = await executor(runtime)(step("npm install"), 0);
    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(1);
    expect(result.record?.stderr).toContain("MISSING_PACKAGE_JSON");
  });

  it("reports an unimplemented command as a harness fault, not as a runtime refusal", async () => {
    const result = await executor(fakeRuntime())(step("npm run dev -- --port 3000"), 1);
    expect(result.termination).toBe("harness-fault");
    expect(result.detail).toMatch(/npm script runner/);

    // The distinction matters downstream: a harness fault becomes HARNESS_BUG, never UNSUPPORTED_BY_DESIGN.
    const steps: StepRun[] = [
      { index: 1, kind: "run", command: "npm run dev -- --port 3000", termination: result.termination, detail: result.detail, record: result.record, elapsedMs: 1 },
    ];
    expect(decideVerdict(steps, []).classification).toBe("HARNESS_BUG");
  });

  it("refuses shell syntax at execution time too, so a definition cannot smuggle one in", async () => {
    const result = await executor(fakeRuntime())(step("npm install && rm -rf /"), 0);
    expect(result.termination).toBe("harness-fault");
    expect(result.detail).toMatch(/shell syntax/);
  });

  it("runs a node step and keeps its exit code, which is what exit-code assertions read", async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime({
      async run(entry: string, options?: { argv?: readonly string[] }) {
        calls.push(`${entry} ${(options?.argv ?? []).join(" ")}`);
        return { stdout: "", stderr: "boom\n", exitCode: 3 };
      },
    });
    const result = await executor(runtime)(step("node scripts/check.js --strict"), 0);
    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(3);
    expect(calls[0]).toBe("/app/scripts/check.js node scripts/check.js --strict");
  });

  it("classifies a runtime that cannot load the program as a runtime incompatibility", async () => {
    const runtime = fakeRuntime({
      async run() {
        throw new Error("Cannot find module '/app/missing.js'");
      },
    });
    const result = await executor(runtime)(step("node missing.js"), 0);
    expect(result.termination).toBe("error");
    expect(result.detail).toMatch(/Cannot find module/);
  });
});
