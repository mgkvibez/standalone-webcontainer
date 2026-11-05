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

  it("reads npx as resolution of an installed bin, not as an install", () => {
    expect(parseStepCommand("npx tsc -p tsconfig.json")).toEqual({
      kind: "exec",
      bin: "tsc",
      args: ["-p", "tsconfig.json"],
      via: "npx",
    });
    expect(parseStepCommand("npx --no-install cowsay hello")).toEqual({
      kind: "exec",
      bin: "cowsay",
      args: ["hello"],
      via: "npx",
    });
    // --yes and -y only suppress a prompt we never show.
    expect(parseStepCommand("npx --yes tsc --version")).toEqual({ kind: "exec", bin: "tsc", args: ["--version"], via: "npx" });
  });

  it("keeps a scoped package name intact, because its first @ is a scope and not a version", () => {
    expect(parseStepCommand("npx @scope/pkg run")).toEqual({ kind: "exec", bin: "@scope/pkg", args: ["run"], via: "npx" });
  });

  it("refuses a versioned npx spec by name, because npx would install it", () => {
    const latest = parseStepCommand("npx --yes shadcn@latest add button");
    expect(latest.kind).toBe("invalid");
    expect(latest.kind === "invalid" ? latest.reason : "").toMatch(/registry/);
    expect(latest.kind === "invalid" ? latest.reason : "").toContain("shadcn@latest");

    const scopedVersioned = parseStepCommand("npx @scope/pkg@1 run");
    expect(scopedVersioned.kind).toBe("invalid");
    expect(scopedVersioned.kind === "invalid" ? scopedVersioned.reason : "").toContain("@scope/pkg@1");
  });

  it("refuses an npx flag it does not implement, rather than ignoring it", () => {
    const result = parseStepCommand("npx --package=left-pad cowsay");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.reason : "").toContain("--package=left-pad");
  });

  it("requires a binary name after npx", () => {
    expect(parseStepCommand("npx --yes").kind).toBe("invalid");
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
      readFileText() {
        return null;
      },
      readDirNames() {
        return [];
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

  it("reports a missing package.json as npm's failure, not as a harness fault", async () => {
    const result = await executor(fakeRuntime())(step("npm run dev"), 1);

    // npm exits 1 and says so. The runtime is not implicated, and a harness fault here would be a false accusation.
    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(1);
    expect(result.record?.stderr).toMatch(/package\.json is missing/);
  });

  it("reports a script the project does not define by name, listing what it does define", async () => {
    const runtime = fakeRuntime({
      readFileText: (path) =>
        path.endsWith("/package.json") ? JSON.stringify({ scripts: { build: "vite build" } }) : null,
    });
    const result = await executor(runtime)(step("npm run dev"), 1);

    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(1);
    expect(result.record?.stderr).toMatch(/Missing script: "dev"/);
    expect(result.record?.stderr).toMatch(/available: build/);
  });

  it("refuses a script body that needs a shell, naming the script and the command", async () => {
    const runtime = fakeRuntime({
      readFileText: (path) =>
        path.endsWith("/package.json")
          ? JSON.stringify({ scripts: { build: "vite build && tsc -p ." } })
          : null,
    });
    const result = await executor(runtime)(step("npm run build"), 1);

    // Half of `vite build && tsc` is not the command the author wrote, and running it would score a fiction.
    expect(result.termination).toBe("harness-fault");
    expect(result.detail).toMatch(/script "build"/);
    expect(result.detail).toMatch(/needs a shell/);
  });

  it("runs an installed bin with the arguments forwarded after --", async () => {
    const seen: string[][] = [];
    const runtime = fakeRuntime({
      readDirNames: (path) => (path.endsWith("/node_modules") ? ["vite"] : []),
      readFileText: (path) => {
        if (path.endsWith("/package.json") && path.includes("/node_modules/vite")) {
          return JSON.stringify({ name: "vite", bin: { vite: "bin/vite.js" } });
        }
        if (path.endsWith("/package.json")) return JSON.stringify({ scripts: { dev: "vite" } });
        return null;
      },
      async run(entryPath, options) {
        seen.push([entryPath, ...(options?.argv ?? [])]);
        return { stdout: "ready\n", stderr: "", exitCode: 0 };
      },
    });

    const result = await executor(runtime)(step("npm run dev -- --port 3000 --host 127.0.0.1"), 1);

    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(0);
    expect(result.record?.stdout).toBe("ready\n");
    expect(seen).toEqual([["/app/node_modules/vite/bin/vite.js", "node", "/app/node_modules/vite/bin/vite.js", "--port", "3000", "--host", "127.0.0.1"]]);
  });

  it("reports a command no installed package provides as command not found", async () => {
    const runtime = fakeRuntime({
      readDirNames: (path) => (path.endsWith("/node_modules") ? ["other"] : []),
      readFileText: (path) =>
        path.endsWith("/package.json") && path.includes("/node_modules/other")
          ? JSON.stringify({ name: "other", bin: { other: "cli.js" } })
          : null,
    });
    const result = await executor(runtime)(step("vite build"), 1);

    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(1);
    expect(result.record?.stderr).toMatch(/command not found: vite/);
  });

  it("reports a missing npx target as our limitation, and a missing bare binary as the project's", async () => {
    const empty = fakeRuntime({
      readDirNames: (path) => (path.endsWith("/node_modules") ? ["other"] : []),
      readFileText: (path) =>
        path.endsWith("/package.json") && path.includes("/node_modules/other")
          ? JSON.stringify({ name: "other", bin: { other: "cli.js" } })
          : null,
    });

    // `npx tsc` with nothing installed would have made npx fetch it. Fetching is disabled by policy, and a policy we chose
    // is neither a defect to file nor a broken project to blame (ADR-0010 am. 2).
    const viaNpx = await executor(empty)(step("npx tsc -p tsconfig.json"), 1);
    expect(viaNpx.termination).toBe("restricted");
    expect(viaNpx.termination).not.toBe("harness-fault");
    expect(viaNpx.restriction?.policy).toBe("offline-registry");
    expect(viaNpx.restriction?.operation).toBe("npx tsc");
    expect(viaNpx.restriction?.alternative).toMatch(/package\.json/);
    expect(viaNpx.detail).toMatch(/offline-registry policy/);

    // The same binary written bare is a broken project: npm would say "command not found" in its own shell.
    const bare = await executor(empty)(step("tsc -p tsconfig.json"), 1);
    expect(bare.termination).toBe("ok");
    expect(bare.record?.exitCode).toBe(1);
    expect(bare.record?.stderr).toMatch(/command not found: tsc/);
  });

  it("presents an install-shaped npx as a policy restriction, and an unknown flag as our defect", async () => {
    const empty = fakeRuntime({ readDirNames: () => [], readFileText: () => null });

    const versioned = await executor(empty)(step("npx --yes shadcn@latest add button"), 1);
    expect(versioned.termination).toBe("restricted");
    expect(versioned.restriction?.policy).toBe("offline-registry");
    expect(versioned.restriction?.operation).toContain("shadcn@latest");

    // An unimplemented flag is our gap, not a policy: it stays a harness fault so it gets fixed.
    const unknownFlag = await executor(empty)(step("npx --package=left-pad cowsay"), 1);
    expect(unknownFlag.termination).toBe("harness-fault");
    expect(unknownFlag.restriction).toBeUndefined();
  });

  it("runs an npx target that an installed package does provide", async () => {
    const seen: string[][] = [];
    const installed = fakeRuntime({
      readDirNames: (path) => (path.endsWith("/node_modules") ? ["typescript"] : []),
      readFileText: (path) => {
        if (path.endsWith("/package.json") && path.includes("/node_modules/typescript")) {
          return JSON.stringify({ name: "typescript", bin: { tsc: "bin/tsc" } });
        }
        if (path.endsWith("/package.json")) return JSON.stringify({ name: "app", version: "1.0.0" });
        return null;
      },
      async run(entryPath, options) {
        seen.push([entryPath, ...(options?.argv ?? [])]);
        return { stdout: "tsc 5.0.0\n", stderr: "", exitCode: 0 };
      },
    });

    const result = await executor(installed)(step("npx --no-install tsc -p tsconfig.json"), 1);

    expect(result.termination).toBe("ok");
    expect(result.record?.exitCode).toBe(0);
    expect(seen).toEqual([["/app/node_modules/typescript/bin/tsc", "node", "/app/node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]]);
  });

  it("refuses a script that hides an install inside a run step", async () => {
    const runtime = fakeRuntime({
      readFileText: (path) =>
        path.endsWith("/package.json") ? JSON.stringify({ scripts: { setup: "npm install" } }) : null,
    });
    const result = await executor(runtime)(step("npm run setup"), 1);

    // The install budget and the run budget differ; folding one into the other would falsify both.
    expect(result.termination).toBe("harness-fault");
    expect(result.detail).toMatch(/must be its own install step/);
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
