/**
 * What a fixture's command MEANS, as data (ADR-0009).
 *
 * A definition stores the command a user would type (`npm install`, `npm run dev -- --port 3000`). Running that
 * string needs an interpreter: there is no shell in a browser, and inventing one would mean implementing quoting,
 * pipes and expansion, each of which is a place to be subtly wrong. So the command is parsed into a small closed set
 * of plans, and anything outside it is refused by name instead of being guessed at.
 *
 * The parser is deliberately strict:
 * - shell syntax (`|`, `&&`, `;`, `>`, `$(...)`) is reported as invalid rather than partially honoured, because a
 *   fixture that pipes output is testing a shell we do not have, and silently running the left-hand side would score
 *   a different command than the one written down;
 * - unknown npm flags are an error, because `npm install --omit=dev` and `npm install --production` mean the tree
 *   differs, and quietly ignoring a flag is how a fixture stops testing what it says it tests.
 */

/** A dependency spec passed straight to `npm install`, which we do not support adding ad hoc. */
export interface InstallPlan {
  readonly kind: "install";
  /** `npm ci`: install exactly the lockfile, and fail when there is none. */
  readonly ci: boolean;
  /** `--production` / `--omit=dev`. */
  readonly omitDev: boolean;
}

export interface RunScriptPlan {
  readonly kind: "run-script";
  readonly script: string;
  /** Arguments after `--`, forwarded to the script itself. */
  readonly args: readonly string[];
}

export interface NodePlan {
  readonly kind: "node";
  readonly entry: string;
  readonly args: readonly string[];
}

/** A binary from `node_modules/.bin`, e.g. `vite`, `tsc`, `webpack`. */
export interface ExecPlan {
  readonly kind: "exec";
  readonly bin: string;
  readonly args: readonly string[];
  /**
   * Set when the command was written `npx <bin>`.
   *
   * It changes what a missing binary MEANS. A bare `vite` that is not installed is a broken project, so it is a project
   * failure. `npx vite` that is not installed is npm offering to fetch it, which is a harness limitation, and calling
   * that a project failure would blame the fixture for our missing feature.
   */
  readonly via?: "npx";
}

export interface InvalidPlan {
  readonly kind: "invalid";
  readonly reason: string;
}

export type CommandPlan = InstallPlan | RunScriptPlan | NodePlan | ExecPlan | InvalidPlan;

/** Install flags whose effect on the tree we understand. Anything else must be named in the plan. */
const KNOWN_INSTALL_FLAGS: readonly string[] = [
  "--production",
  "--omit=dev",
  "--omit=optional",
  "--include=dev",
  "--prefer-offline",
  "--no-audit",
  "--no-fund",
  "--silent",
  "--loglevel=error",
];

const SHELL_SYNTAX = /[|&;<>()`$]/;

export function parseStepCommand(command: string): CommandPlan {
  const tokens = tokenize(command);
  if (typeof tokens === "string") return { kind: "invalid", reason: tokens };
  if (tokens.length === 0) return { kind: "invalid", reason: "empty command" };

  const program = tokens[0] ?? "";
  const rest = tokens.slice(1);

  if (program === "npm") return parseNpm(rest);
  if (program === "npx") return parseNpx(rest);
  if (program === "node") {
    const entry = rest[0];
    if (entry === undefined) return { kind: "invalid", reason: "node: an entry file is required" };
    return { kind: "node", entry, args: rest.slice(1) };
  }
  return { kind: "exec", bin: program, args: rest };
}

/**
 * The npx flags we honour. `--yes`/`-y` only suppress a prompt we never show, and `--no-install` only forbids something
 * we refuse anyway, so both are accepted and have no further effect.
 */
const KNOWN_NPX_FLAGS: readonly string[] = ["--yes", "-y", "--no-install", "--no", "--quiet", "-q"];

/**
 * `npx`, in the limited form this harness can honour.
 *
 * Supported: `npx <bin> [args]` and `npx --no-install <bin> [args]`, where `<bin>` is provided by a package the project
 * already installed. That is resolution, not acquisition.
 *
 * Refused by name: a versioned or tagged package spec (`npx shadcn@latest add button`, `npx cowsay@1 hello`), because
 * npx would fetch and install a package the project does not declare, and a fixture that ran it would be testing a tree
 * its own package.json does not describe. Also refused by name: any flag not in the list above, so an unimplemented flag
 * cannot quietly change what the fixture tests.
 */
function parseNpx(rest: readonly string[]): CommandPlan {
  let spec: string | undefined;
  const args: string[] = [];
  for (const token of rest) {
    if (spec === undefined) {
      if (token.startsWith("-")) {
        if (!KNOWN_NPX_FLAGS.includes(token)) {
          return { kind: "invalid", reason: `npx ${token}: not interpreted by this harness` };
        }
        continue;
      }
      spec = token;
      continue;
    }
    args.push(token);
  }
  if (spec === undefined) return { kind: "invalid", reason: "npx: a binary name is required" };
  if (isVersionedSpec(spec)) {
    return {
      kind: "invalid",
      reason:
        `npx ${spec}: fetching a package from the registry is not supported; ` +
        `declare it in package.json and install it`,
    };
  }
  return { kind: "exec", bin: spec, args, via: "npx" };
}

/**
 * Whether a spec names a version or tag, i.e. whether npx would install something.
 *
 * `pkg@1`, `pkg@latest` and `@scope/pkg@1` are versioned. `@scope/pkg` is not: its first `@` belongs to the scope, and
 * reading it as a version would refuse a legitimate binary name.
 */
function isVersionedSpec(spec: string): boolean {
  const body = spec.startsWith("@") ? spec.slice(spec.indexOf("/") + 1) : spec;
  return body.includes("@");
}

function parseNpm(rest: readonly string[]): CommandPlan {
  const subcommand = rest[0];
  if (subcommand === undefined) return { kind: "invalid", reason: "npm: a subcommand is required" };
  const args = rest.slice(1);

  if (subcommand === "install" || subcommand === "i" || subcommand === "ci") {
    return parseInstall(subcommand === "ci", args);
  }
  if (subcommand === "run" || subcommand === "run-script") {
    return parseRunScript(args);
  }
  if (subcommand === "test") {
    // `npm test` is `npm run test`; the separator rule does not apply because there is no script name.
    return { kind: "run-script", script: "test", args: splitForwarded(args) };
  }
  return { kind: "invalid", reason: `npm ${subcommand}: not interpreted by this harness` };
}

function parseInstall(ci: boolean, args: readonly string[]): CommandPlan {
  const specs = args.filter((argument) => !argument.startsWith("-"));
  if (specs.length > 0) {
    // npm would add these to package.json and resolve them fresh. We would be installing a tree that does not match
    // the definition's project, so this is refused rather than approximated.
    return {
      kind: "invalid",
      reason: `npm install ${specs.join(" ")}: installing packages that are not in package.json is not supported; ` +
        "declare the dependency in the fixture's package.json",
    };
  }

  const unknown = args.filter((argument) => !KNOWN_INSTALL_FLAGS.includes(argument));
  if (unknown.length > 0) {
    return { kind: "invalid", reason: `npm install: unsupported flag(s) ${unknown.join(" ")}` };
  }

  const omitDev = args.includes("--production") || args.includes("--omit=dev");
  const includeDev = args.includes("--include=dev");
  if (omitDev && includeDev) {
    return { kind: "invalid", reason: "npm install: --production and --include=dev contradict each other" };
  }
  return { kind: "install", ci, omitDev };
}

function parseRunScript(args: readonly string[]): CommandPlan {
  const script = args[0];
  if (script === undefined || script.startsWith("-")) {
    return { kind: "invalid", reason: "npm run: a script name is required" };
  }
  return { kind: "run-script", script, args: splitForwarded(args.slice(1)) };
}

/**
 * npm forwards arguments only after a bare `--`. Anything before it belongs to npm, and pretending otherwise would
 * hand a script arguments that npm itself would have consumed.
 */
function splitForwarded(args: readonly string[]): readonly string[] {
  const separator = args.indexOf("--");
  return separator === -1 ? [] : args.slice(separator + 1);
}

/**
 * Split on whitespace, honouring single and double quotes. Returns a reason instead of throwing: the caller turns it
 * into a harness fault, and an exception here would be indistinguishable from a bug in the harness itself.
 */
function tokenize(command: string): readonly string[] | string {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const character of command) {
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
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (SHELL_SYNTAX.test(character)) {
      return `shell syntax ${JSON.stringify(character)} is not supported: this harness has no shell`;
    }
    current += character;
    started = true;
  }

  if (quote !== null) return `unterminated ${quote} quote`;
  if (started) tokens.push(current);
  return tokens;
}
