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
    expect(parseStepCommand("npm install")).toEqual({ kind: "install", ci: false, omitDev: false, manager: "npm" });
    expect(parseStepCommand("npm i")).toEqual({ kind: "install", ci: false, omitDev: false, manager: "npm" });
    expect(parseStepCommand("npm ci")).toEqual({ kind: "install", ci: true, omitDev: false, manager: "npm" });
  });

  it("treats --production and --omit=dev as the same tree, and refuses contradictory flags", () => {
    expect(parseStepCommand("npm install --production")).toEqual({ kind: "install", ci: false, omitDev: true, manager: "npm" });
    expect(parseStepCommand("npm install --omit=dev")).toEqual({ kind: "install", ci: false, omitDev: true, manager: "npm" });
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

  // THREE TESTS REMOVED HERE (W-37, correctness phase). They drove `npx` through this interpreter, which gated a fetch with its own
  // offline-registry policy and reported a restriction or a harness fault depending on the shape of the spec. The product does not
  // work that way: `Container` resolves an installed binary by its BIN name and otherwise refuses by name, and every case those tests
  // pinned is now asserted against the Container in `container.npx.test.ts` (resolution, both refusal messages, the
  // installed-but-no-bin case, the missing binary). Keeping them would have kept a green assertion about a behaviour no user can
  // reach, which is the hazard the W-37 report names.

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

/**
 * The pnpm profile (Phase 6 R2, D-1 to D-4): a command vocabulary, not an engine.
 *
 * Two properties carry the contract. First, a supported pnpm command must carry the mandatory deviation record, because "passed
 * under a declared profile" and "passed while pretending" are different results. Second, every refusal states the approved
 * wording rather than a paraphrase, and is classified as a restriction rather than a harness fault, because this boundary is a
 * decision we made and not a gap someone should file as a bug.
 */
describe("the pnpm command vocabulary", () => {
  const plan = (command: string): ReturnType<typeof parseStepCommand> => parseStepCommand(command);

  it("treats install as the npm install under the profile", () => {
    const parsed = plan("pnpm install");
    expect(parsed.kind).toBe("install");
    if (parsed.kind !== "install") throw new Error("expected install");
    expect(parsed.manager).toBe("pnpm");
    expect(parsed.omitDev).toBe(false);
    expect(parsed.ci).toBe(false);
  });

  it("accepts both production spellings, as npm does", () => {
    for (const command of ["pnpm i --prod", "pnpm install --production"]) {
      const parsed = plan(command);
      expect(parsed.kind === "install" && parsed.omitDev).toBe(true);
    }
  });

  it("runs a script, with arguments forwarded after the separator", () => {
    expect(plan("pnpm run build -- --port 3000")).toEqual({
      kind: "run-script",
      script: "build",
      args: ["--port", "3000"],
    });
    expect(plan("pnpm test")).toEqual({ kind: "run-script", script: "test", args: [] });
  });

  it("lists scripts when run is given no name, rather than running nothing", () => {
    expect(plan("pnpm run").kind).toBe("list-scripts");
  });

  it("runs an installed binary, as pnpm does", () => {
    expect(plan("pnpm vite build")).toEqual({ kind: "exec", bin: "vite", args: ["build"] });
  });

  it("leaves npm plans marked as npm, so no deviation is claimed for them", () => {
    const parsed = plan("npm install");
    expect(parsed.kind === "install" && parsed.manager).toBe("npm");
  });

  it("refuses adding a dependency with the approved wording, as a restriction", () => {
    for (const command of ["pnpm add left-pad", "pnpm install left-pad"]) {
      const parsed = plan(command);
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind !== "invalid") throw new Error("expected refusal");
      // Verbatim from the contract's D-4 table: operation, intentionality, reason, alternative.
      expect(parsed.reason).toBe(
        "pnpm add <pkg>: intentionally not supported: dependency installation is limited to package.json, so a new package cannot be added at run time (instead: declare it in package.json)",
      );
      expect(parsed.restriction?.policy).toBe("pnpm-resolution");
    }
  });

  it("refuses the other unsupported operations by name, each with an alternative", () => {
    const refusals = [
      ["pnpm remove left-pad", /pnpm remove: intentionally not supported/],
      ["pnpm uninstall left-pad", /pnpm remove: intentionally not supported/],
      ["pnpm update", /pnpm update: intentionally not supported/],
      ["pnpm up", /pnpm update: intentionally not supported/],
      ["pnpm dlx cowsay", /pnpm dlx: intentionally not supported/],
      ["pnpm store path", /pnpm store: intentionally not supported/],
      ["pnpm link", /pnpm link: intentionally not supported/],
      ["pnpm publish", /pnpm publish: intentionally not supported/],
      ["pnpm patch", /pnpm patch: intentionally not supported/],
      ["pnpm workspace app test", /pnpm workspace: intentionally not supported/],
    ] as const;
    for (const [command, pattern] of refusals) {
      const parsed = plan(command);
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind !== "invalid") throw new Error("expected refusal");
      expect(parsed.reason).toMatch(pattern);
      // Every refusal is actionable: it says what to do instead.
      expect(parsed.reason).toMatch(/\(instead: .+\)$/);
      expect(parsed.restriction).toBeDefined();
    }
  });

  it("refuses a lockfile it cannot verify instead of ignoring it", () => {
    const parsed = plan("pnpm install --frozen-lockfile");
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") throw new Error("expected refusal");
    expect(parsed.reason).toContain("pnpm-lock.yaml is not parsed");
    expect(parsed.reason).toContain("use package-lock.json, which is verified");
  });

  it("refuses an unlisted flag rather than quietly changing the tree", () => {
    const parsed = plan("pnpm install --shamefully-hoist");
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toContain("intentionally not supported");
  });
});

// The pnpm profile's EXECUTOR tests are removed here too, for the same reason and on the Phase 3 ruling: the profile was implemented
// in this interpreter, the interpreter stopped being called five hours after it was written, and the product has never implemented
// pnpm at all. A test that ran `pnpm install` here and expected a PASS was evidence about a dead file, not about the product. What the
// product does instead is pinned where the product lives: `container.test.ts` (the decline and its wording) and
// `harness.refusal-classification.test.ts` (that the decline is an ordinary failure, never UNSUPPORTED_BY_DESIGN). The parser-level
// vocabulary above stays only because `parseStepCommand` is still a live import of the corpus check, and it goes when the module does.
