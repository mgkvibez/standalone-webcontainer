/**
 * W-43: what a dependency's install script may do, and what this runtime will actually run.
 *
 * The policy is default-deny. A project opts in explicitly; nothing runs because a package asked. That is not a
 * compatibility choice but an authority one: an install already executes with program authority (it runs inside the
 * runtime, `src/runtime/in-process.ts`), so running a transitive `postinstall` means running code the user never read,
 * in the same realm as their own program, with no separate sandbox to inherit.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not spawn. It takes an injected executor, because the caller owns the process
 * table: the installer itself runs inside a process and this runtime has no `child_process` and no shell
 * (`src/container/commands.ts` refuses `sh`/`bash`/`zsh` by name and states there is no PATH and no process spawn).
 * Wiring a real executor is a kernel-level concern; this module is the policy, the ordering and the accounting.
 *
 * SUPPORTED FORMS. Only a single `node` or `npx` invocation, with no shell metacharacters. `node-gyp rebuild` is not
 * runnable and is not pretended to be: it is reported `skipped-unsupported` with the reason. A script that needs a
 * shell is a script this runtime cannot honour, and saying so is the honest outcome.
 */

import { InstallError } from "./install.js";

/** Default-deny. `allow` exists only because a project asked for it, in its own manifest. */
export type LifecyclePolicy = "deny" | "allow";

export type LifecycleState =
  | "skipped-policy"
  | "skipped-unsupported"
  | "ran"
  | "failed"
  | "timed-out"
  | "output-truncated";

/** npm's per-package order. `prepare` is deliberately absent: it is a root-package and git-dependency event. */
export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

export type LifecycleScriptName = (typeof LIFECYCLE_SCRIPTS)[number];

export interface LifecycleCandidate {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  /** Declared dependencies, used only to order execution deterministically. */
  readonly dependencies: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
}

export interface LifecycleLimits {
  readonly scriptTimeoutMs: number;
  readonly installTimeoutMs: number;
  readonly outputBytes: number;
}

export const DEFAULT_LIFECYCLE_LIMITS: LifecycleLimits = {
  scriptTimeoutMs: 30_000,
  installTimeoutMs: 120_000,
  outputBytes: 1024 * 1024,
};

export interface LifecycleExecution {
  readonly exitCode: number;
}

export interface LifecycleExecutorOptions {
  readonly timeoutMs: number;
  readonly onOutput: (chunk: string) => void;
  readonly signal: AbortSignal;
}

/** Injected by whoever owns the process table. This module never spawns. */
export type LifecycleExecutor = (
  argv: readonly string[],
  options: LifecycleExecutorOptions,
) => Promise<LifecycleExecution>;

export interface LifecycleOutcome {
  readonly name: string;
  readonly version: string;
  readonly script: LifecycleScriptName;
  readonly command: string;
  readonly state: LifecycleState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly output: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

export interface LifecycleRunRequest {
  readonly candidates: readonly LifecycleCandidate[];
  readonly policy: LifecyclePolicy;
  readonly execute?: LifecycleExecutor;
  readonly limits?: Partial<LifecycleLimits>;
  readonly signal?: AbortSignal;
}

/** Characters that mean "a shell would be involved". Refused rather than half-implemented. */
const SHELL_METACHARACTERS = /[&|;<>$`(){}*?~\\\n\r]/;

export type ParsedScript = { readonly argv: readonly string[] } | { readonly reason: string };

/**
 * Parse a script into an argv, or refuse it by name.
 *
 * Quoting is honoured for spaces (`node "a b.js"`), because that is argument separation, not shell syntax. Anything
 * that implies a pipeline, a redirect, a substitution or a glob is refused with a reason the report carries.
 */
export function parseScriptForm(command: string): ParsedScript {
  const trimmed = command.trim();
  if (trimmed === "") return { reason: "empty script" };
  const metacharacter = SHELL_METACHARACTERS.exec(trimmed);
  if (metacharacter !== null) {
    return { reason: `needs a shell: contains ${JSON.stringify(metacharacter[0])}` };
  }
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of trimmed) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== null) return { reason: "needs a shell: unterminated quote" };
  if (started) argv.push(current);
  const [program] = argv;
  if (program === undefined) return { reason: "empty script" };
  if (program !== "node" && program !== "npx") {
    return { reason: `needs a shell or an unsupported binary: "${program}"` };
  }
  return { argv };
}

/**
 * Deterministic execution order: dependencies before dependents, then by name.
 *
 * Not npm's tree order, and not claimed to be. Our resolver hoists shallowly and settles a flat queue, so the tree has
 * no depth to walk; a stable topological order over the recorded dependency edges is what can be reproduced run to run.
 */
export function orderForExecution(candidates: readonly LifecycleCandidate[]): readonly LifecycleCandidate[] {
  const byName = new Map<string, LifecycleCandidate>();
  for (const candidate of candidates) if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
  const placed = new Set<string>();
  const ordered: LifecycleCandidate[] = [];
  const visit = (name: string, seen: ReadonlySet<string>): void => {
    if (placed.has(name) || seen.has(name)) return;
    const candidate = byName.get(name);
    if (candidate === undefined) return;
    const next = new Set(seen).add(name);
    for (const dependency of [...candidate.dependencies].sort()) visit(dependency, next);
    if (placed.has(name)) return;
    placed.add(name);
    ordered.push(candidate);
  };
  for (const name of [...byName.keys()].sort()) visit(name, new Set());
  return ordered;
}

function scriptsOf(candidate: LifecycleCandidate): readonly { script: LifecycleScriptName; command: string }[] {
  const declared: { script: LifecycleScriptName; command: string }[] = [];
  for (const script of LIFECYCLE_SCRIPTS) {
    const command = candidate.scripts[script];
    if (typeof command === "string" && command.trim() !== "") declared.push({ script, command });
  }
  return declared;
}

/**
 * Run (or refuse) every declared script under the policy, in order, within the limits.
 *
 * A failure throws `InstallError` so it cannot be mistaken for a successful install: the caller's verdict must not
 * survive a script that did not finish. A refusal never throws — it is a state, because refusing to run something is a
 * policy outcome and not an install failure.
 */
export async function runLifecycleScripts(request: LifecycleRunRequest): Promise<readonly LifecycleOutcome[]> {
  const limits: LifecycleLimits = { ...DEFAULT_LIFECYCLE_LIMITS, ...request.limits };
  const outcomes: LifecycleOutcome[] = [];
  const deadline = Date.now() + limits.installTimeoutMs;
  for (const candidate of orderForExecution(request.candidates)) {
    for (const { script, command } of scriptsOf(candidate)) {
      const base = {
        name: candidate.name,
        version: candidate.version,
        script,
        command,
        exitCode: null,
        durationMs: 0,
        output: "",
        outputBytes: 0,
        truncated: false,
      } as const;
      if (request.policy === "deny") {
        outcomes.push({ ...base, state: "skipped-policy" });
        continue;
      }
      const parsed = parseScriptForm(command);
      if (!("argv" in parsed)) {
        outcomes.push({ ...base, state: "skipped-unsupported" });
        continue;
      }
      if (request.execute === undefined) {
        // Allow with nowhere to run is a caller bug, not a package's problem: say so instead of reporting success.
        throw new InstallError("LIFECYCLE_NO_EXECUTOR", `${candidate.name}@${candidate.version} ${script}: policy is "allow" but no executor was supplied`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new InstallError("LIFECYCLE_TIMEOUT", `the install lifecycle budget of ${String(limits.installTimeoutMs)}ms was exhausted before ${candidate.name}@${candidate.version} ${script}`);
      }
      const started = Date.now();
      let captured = "";
      let capturedBytes = 0;
      let truncated = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(limits.scriptTimeoutMs, remaining));
      // Bounded execution does not depend on the executor's goodwill: the signal is offered to it, and this rejection
      // is the backstop if it ignores the signal or simply never resolves.
      const expired = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("lifecycle script exceeded its timeout")), { once: true });
      });
      let exitCode: number;
      try {
        const result = await Promise.race([request.execute(parsed.argv, {
          timeoutMs: Math.min(limits.scriptTimeoutMs, remaining),
          signal: controller.signal,
          onOutput: (chunk) => {
            if (truncated) return;
            capturedBytes += chunk.length;
            if (capturedBytes > limits.outputBytes) {
              captured += chunk.slice(0, Math.max(0, limits.outputBytes - (capturedBytes - chunk.length)));
              truncated = true;
              return;
            }
            captured += chunk;
          },
        }), expired]);
        exitCode = result.exitCode;
      } catch (error) {
        const aborted = controller.signal.aborted;
        const durationMs = Date.now() - started;
        if (aborted) {
          outcomes.push({ ...base, state: "timed-out", durationMs, output: captured, outputBytes: capturedBytes, truncated });
          throw new InstallError("LIFECYCLE_TIMEOUT", `${candidate.name}@${candidate.version} ${script} exceeded ${String(limits.scriptTimeoutMs)}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const durationMs = Date.now() - started;
      const state: LifecycleState = exitCode === 0 ? (truncated ? "output-truncated" : "ran") : "failed";
      outcomes.push({ ...base, state, exitCode, durationMs, output: captured, outputBytes: capturedBytes, truncated });
      if (exitCode !== 0) {
        throw new InstallError("LIFECYCLE_FAILED", `${candidate.name}@${candidate.version} ${script} exited ${String(exitCode)}`);
      }
    }
  }
  return outcomes;
}
