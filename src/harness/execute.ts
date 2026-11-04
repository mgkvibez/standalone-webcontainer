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
import { parseStepCommand } from "./command.js";
import { createRestriction, describeRestriction, type Restriction } from "./restriction.js";
import { ProjectError, readPackageScripts, resolveBin } from "./scripts.js";
import type { StepRecord } from "./assertions.js";
import type { Refusal } from "../runtime/refusal.js";
import type { ExecuteStep, StepExecution } from "./runner.js";

/** The runtime capabilities a step can use. Narrow on purpose: the harness needs a slice, not a runtime. */
export interface StepRuntime {
  install(options: {
    readonly registry: RegistryClient;
    readonly root?: string;
    readonly includeDev?: boolean;
  }): Promise<{ readonly packages: readonly unknown[]; readonly warnings: readonly string[]; readonly usedLockfile: boolean }>;
  readFileText(path: string): string | null;
  readDirNames(path: string): readonly string[];
  run(entryPath: string, options?: { readonly argv?: readonly string[]; readonly cwd?: string }): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    /** Present only when an unhandled refusal ended the program (ADR-0014). */
    readonly refusal?: Refusal;
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
      // A refused-by-policy command is not a defect. Only an unimplemented one is (ADR-0010 am. 2).
      if (plan.restriction !== undefined) return restricted(index, plan.restriction);
      return harnessFault(index, plan.reason);
    }
    if (plan.kind === "install") {
      return runInstall(plan, index, root, options);
    }
    if (plan.kind === "node") {
      return runNode(plan, index, root, options);
    }
    if (plan.kind === "run-script") {
      return runScript(plan, index, root, options, 0);
    }
    // A bare binary (`vite`, `tsc`) resolves through the installed packages' `bin` fields. `via` travels with the plan:
    // dropping it here made `npx tsc` look like a bare `tsc` and reported our limitation as a broken project.
    return runBin(plan.bin, plan.args, index, root, options, plan.via);

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

/** The runtime's result, classified: a run that carried an unhandled refusal is a refusal, not an ordinary exit. */
function fromRun(
  index: number,
  detail: string,
  result: Awaited<ReturnType<StepRuntime["run"]>>,
): StepExecution {
  const record: StepRecord = {
    index,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.refusal !== undefined) {
    return {
      termination: "unsupported",
      detail: `${detail}; refused ${result.refusal.capability} (${result.refusal.code})`,
      record,
      refusal: result.refusal,
    };
  }
  return { termination: "ok", detail, record };
}

async function runNode(
  plan: { readonly kind: "node"; readonly entry: string; readonly args: readonly string[] },
  index: number,
  root: string,
  options: StepExecutorOptions,
): Promise<StepExecution> {
  const entry = plan.entry.startsWith("/") ? plan.entry : `${root.replace(/\/$/, "")}/${plan.entry}`;
  try {
    const result = await options.runtime.run(entry, { argv: ["node", plan.entry, ...plan.args], cwd: root });
    return fromRun(index, `node ${plan.entry} exited ${result.exitCode}`, result);
  } catch (error) {
    // A thrown load error is the runtime being unable to execute the program at all. That is a finding about the
    // runtime, and the runner classifies `error` as RUNTIME_INCOMPATIBILITY.
    return { termination: "error", detail: message(error), record: null };
  }
}

/**
 * `npm run <script>`: look the command up in package.json and run it.
 *
 * The script body is itself a command line, so it goes through the same interpreter as a fixture step. That is the
 * whole reason a script containing `&&` reports a harness fault instead of being half-executed: there is no shell, and
 * running the first half of `vite build && tsc` would score something the author never wrote.
 *
 * Arguments after `--` are appended, which is what npm does: `npm run dev -- --port 3000` runs `vite --port 3000`.
 */
async function runScript(
  plan: { readonly kind: "run-script"; readonly script: string; readonly args: readonly string[] },
  index: number,
  root: string,
  options: StepExecutorOptions,
  depth: number,
): Promise<StepExecution> {
  if (depth > MAX_SCRIPT_DEPTH) {
    return harnessFault(index, `npm run recursed more than ${MAX_SCRIPT_DEPTH} levels at script "${plan.script}"`);
  }

  let scripts: Readonly<Record<string, string>>;
  try {
    scripts = readPackageScripts(options.runtime, root);
  } catch (error) {
    // A project with an unreadable package.json is the project's problem, and npm reports it as its own failure.
    if (error instanceof ProjectError) return projectFailure(index, `npm error ${error.message}`);
    return harnessFault(index, message(error));
  }

  const command = scripts[plan.script];
  if (command === undefined) {
    const available = Object.keys(scripts);
    const hint = available.length === 0 ? "no scripts are defined" : `available: ${available.join(", ")}`;
    return projectFailure(index, `npm error Missing script: "${plan.script}" (${hint})`);
  }

  const parsed = parseStepCommand(command);
  const forwarded = [...plan.args];
  switch (parsed.kind) {
    case "invalid":
      return harnessFault(
        index,
        `script "${plan.script}" is ${JSON.stringify(command)}, which needs a shell: ${parsed.reason}`,
      );
    case "node":
      return runNode({ kind: "node", entry: parsed.entry, args: [...parsed.args, ...forwarded] }, index, root, options);
    case "exec":
      return runBin(parsed.bin, [...parsed.args, ...forwarded], index, root, options, parsed.via);
    case "run-script":
      return runScript(
        { kind: "run-script", script: parsed.script, args: [...parsed.args, ...forwarded] },
        index,
        root,
        options,
        depth + 1,
      );
    case "install":
      // A script that installs is a script whose install step belongs in the fixture, not hidden inside a run step:
      // the install budget and the run budget are different, and swallowing one inside the other would falsify both.
      return harnessFault(index, `script "${plan.script}" runs "${command}", which must be its own install step`);
  }
}

/** Resolve a command name through the installed packages' `bin` fields and run it. */
async function runBin(
  bin: string,
  args: readonly string[],
  index: number,
  root: string,
  options: StepExecutorOptions,
  via?: "npx",
): Promise<StepExecution> {
  const resolved = resolveBin(options.runtime, root, bin);
  if (resolved === null) {
    if (via === "npx") {
      // npx's documented job is to fetch a missing package, and fetching is disabled by policy this milestone. That is a
      // chosen boundary, so it is reported as a restriction: neither a bug to file nor a broken project to blame.
      return restricted(
        index,
        createRestriction({
          policy: "offline-registry",
          operation: `npx ${bin}`,
          reason: "registry fetches are disabled by policy for this milestone",
          alternative: `declare ${bin} in package.json and install it from the project tree`,
        }),
      );
    }
    return projectFailure(index, `npm error command not found: ${bin}`);
  }

  try {
    // argv follows Node's convention: argv[0] is the executable, argv[1] the script being run.
    const result = await options.runtime.run(resolved.entryPath, {
      argv: ["node", resolved.entryPath, ...args],
    });
    return fromRun(index, `${bin} (${resolved.packageName}) exited ${result.exitCode}`, result);
  } catch (error) {
    return {
      termination: "error",
      detail: `${bin} (${resolved.packageName}) could not run: ${message(error)}`,
      record: null,
    };
  }
}

const MAX_SCRIPT_DEPTH = 5;

/** The project made a mistake: npm-shaped exit code and stderr, so the fixture's own assertions can judge it. */
function projectFailure(index: number, stderr: string): StepExecution {
  return {
    termination: "ok",
    detail: stderr,
    record: { index, exitCode: 1, stdout: "", stderr: `${stderr}\n` },
  };
}

/**
 * A step stopped by a policy we chose. Distinct from a harness fault on purpose: the run ended by design, not by a bug,
 * and the record explains which policy and what to do instead.
 */
function restricted(index: number, restriction: Restriction): StepExecution {
  const detail = describeRestriction(restriction);
  return {
    termination: "restricted",
    detail,
    record: { index, exitCode: 1, stdout: "", stderr: `${detail}\n` },
    restriction,
  };
}
function harnessFault(index: number, detail: string): StepExecution {
  return { termination: "harness-fault", detail, record: { index, exitCode: 1, stdout: "", stderr: `${detail}\n` } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
