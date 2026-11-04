/**
 * Running a fixture's steps against the runtime (ADR-0009).
 *
 * The runner sequences steps and decides the verdict; this module is the part that knows what `npm install` and
 * `node x.js` DO. Two rules keep it honest:
 *
 * 1. A capability we have not built is reported as a HARNESS fault, never as the runtime refusing something on
 *    purpose. `npm run dev` is not implemented yet; that is our gap, and calling it UNSUPPORTED_BY_DESIGN would both
 *    flatter the runtime and pollute the bucket the gate counts as a legitimate result.
 * 2. A command the project itself gets wrong (a missing lockfile for `npm ci`, a script that exits non-zero) is
 *    reported as a normal exit code and stderr, exactly as a shell would. Fixtures assert on those, so turning them
 *    into harness exceptions would make the assertions unreachable.
 */

import type { RegistryClient } from "../npm/install.js";
import type { FixtureStep } from "./definition.js";
import { parseStepCommand, type CommandPlan } from "./command.js";
import type { StepRecord } from "./assertions.js";
import type { ExecuteStep, StepExecution } from "./runner.js";

/** The runtime capabilities a step can use. Narrow on purpose: the harness needs a slice, not a runtime. */
export interface StepRuntime {
  install(options: {
    readonly registry: RegistryClient;
    readonly root?: string;
    readonly includeDev?: boolean;
  }): Promise<{ readonly packages: readonly unknown[]; readonly warnings: readonly string[]; readonly usedLockfile: boolean }>;
  run(entryPath: string, options?: { readonly argv?: readonly string[] }): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
}

export interface StepExecutorOptions {
  readonly runtime: StepRuntime;
  readonly registry: RegistryClient;
  /** Project root inside the runtime's VFS. Defaults to `/app`. */
  readonly root?: string;
}

export function createStepExecutor(options: StepExecutorOptions): ExecuteStep {
  const root = options.root ?? "/app";

  return async (step: FixtureStep, index: number): Promise<StepExecution> => {
    const plan = parseStepCommand(step.command);
    if (plan.kind === "invalid") {
      return harnessFault(index, plan.reason);
    }
    if (plan.kind === "install") {
      return runInstall(plan, index, root, options);
    }
    if (plan.kind === "node") {
      return runNode(plan, index, root, options);
    }
    // run-script and exec need an npm script runner and .bin resolution, neither of which exists yet. Named rather
    // than approximated: running `npm run dev` as if it were `node dev` would score a different command.
    return harnessFault(
      index,
      `${describePlan(plan)} is not implemented yet: the harness has no ` +
        (plan.kind === "run-script" ? "npm script runner" : "node_modules/.bin resolution"),
    );
  };
}

interface InstallPlanLike {
  readonly kind: "install";
  readonly ci: boolean;
  readonly omitDev: boolean;
}

async function runInstall(
  plan: InstallPlanLike,
  index: number,
  root: string,
  options: StepExecutorOptions,
): Promise<StepExecution> {
  let report: Awaited<ReturnType<StepRuntime["install"]>>;
  try {
    report = await options.runtime.install({
      registry: options.registry,
      root,
      includeDev: !plan.omitDev,
    });
  } catch (error) {
    // The installer refusing the project (missing package.json, bad spec, refused package) is the project's problem,
    // not a harness bug: report npm-like failure so the fixture's own assertions can judge it.
    return {
      termination: "ok",
      detail: `install failed: ${message(error)}`,
      record: { index, exitCode: 1, stdout: "", stderr: `${message(error)}\n` },
    };
  }

  if (plan.ci && !report.usedLockfile) {
    // What npm ci actually does, minus deleting node_modules first: it refuses without a lockfile.
    return {
      termination: "ok",
      detail: "npm ci found no package-lock.json",
      record: {
        index,
        exitCode: 1,
        stdout: "",
        stderr: "npm error `npm ci` can only install packages when your package.json and package-lock.json are in " +
          "sync. Missing package-lock.json.\n",
      },
    };
  }

  const summary = [`installed ${report.packages.length} package(s)`];
  for (const warning of report.warnings) summary.push(`warning: ${warning}`);
  return {
    termination: "ok",
    detail: summary.join("\n"),
    record: { index, exitCode: 0, stdout: `${summary.join("\n")}\n`, stderr: "" },
  };
}

async function runNode(
  plan: { readonly kind: "node"; readonly entry: string; readonly args: readonly string[] },
  index: number,
  root: string,
  options: StepExecutorOptions,
): Promise<StepExecution> {
  const entry = plan.entry.startsWith("/") ? plan.entry : `${root.replace(/\/$/, "")}/${plan.entry}`;
  try {
    const result = await options.runtime.run(entry, { argv: ["node", plan.entry, ...plan.args] });
    const record: StepRecord = {
      index,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    return { termination: "ok", detail: `node ${plan.entry} exited ${result.exitCode}`, record };
  } catch (error) {
    // A thrown load error is the runtime being unable to execute the program at all. That is a finding about the
    // runtime, and the runner classifies `error` as RUNTIME_INCOMPATIBILITY.
    return { termination: "error", detail: message(error), record: null };
  }
}

function harnessFault(index: number, detail: string): StepExecution {
  return { termination: "harness-fault", detail, record: { index, exitCode: 1, stdout: "", stderr: `${detail}\n` } };
}

function describePlan(plan: CommandPlan): string {
  if (plan.kind === "run-script") return `npm run ${plan.script}`;
  if (plan.kind === "exec") return plan.bin;
  if (plan.kind === "node") return `node ${plan.entry}`;
  if (plan.kind === "install") return "npm install";
  return "command";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
