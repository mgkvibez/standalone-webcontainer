/**
 * The command language the terminal speaks.
 *
 * This is a documented, finite command set, not a shell. There is no PATH search, no globbing, no pipes, no redirection
 * and no job control, and pretending otherwise would be the one thing a terminal must never do: show a prompt that lies
 * about what it can run. Anything outside the set is refused BY NAME, with the supported list offered.
 *
 * The tokenizer is deliberately small but not naive: quotes are honoured, because `echo "a b"` printing two arguments
 * would be an obvious wrong answer.
 */

import type { CommandBoundary } from "./types.js";

/** Commands that change terminal state or the project files. */
export const BUILTIN_COMMANDS = [
  "cd",
  "pwd",
  "ls",
  "cat",
  "mkdir",
  "touch",
  "rm",
  "echo",
  "clear",
  "help",
  "ps",
  "kill",
  "npx",
] as const;

/** Commands that start a runtime process. */
export const PROCESS_COMMANDS = ["node"] as const;

/** One recognised name the terminal declines, and why. */
export interface RefusedCommand {
  /** The sentence a user reads, verbatim. */
  readonly reason: string;
  /**
   * Present only when the terminal declines this permanently.
   *
   * Absent is the common case and it means "not built yet": pnpm's limited profile is an approved design the product has never
   * implemented (`docs/phase-6/pnpm-command-contract.md`), and a real shell is ADR-0009's deferred supersession. Those reach a
   * verdict as ordinary failures. A capability reported as a by-design refusal would both flatter the runtime and hide the work.
   */
  readonly boundary?: CommandBoundary;
}

/** Recognised, deliberately declined, with the reason a user needs. */
export const REFUSED_COMMANDS: Readonly<Record<string, RefusedCommand>> = {
  // Neither manager is implemented. Recorded as unimplemented rather than as policy: the pnpm profile is approved design that has
  // never run in this product, so scoring `pnpm install` UNSUPPORTED_BY_DESIGN would credit a decision nobody made.
  pnpm: { reason: "pnpm is not implemented in this terminal; npm is the supported package manager." },
  yarn: { reason: "yarn is not implemented in this terminal; npm is the supported package manager." },
  sh: { reason: "there is no shell to spawn: this terminal interprets a fixed command set itself." },
  bash: { reason: "there is no shell to spawn: this terminal interprets a fixed command set itself." },
  zsh: { reason: "there is no shell to spawn: this terminal interprets a fixed command set itself." },
};

/**
 * The one boundary the terminal keeps permanently, named once because a verdict quotes it.
 *
 * This is not "we have not built curl". There is no PATH, no process spawn and no shell, so a name outside the documented set can
 * never run here, and the terminal says so with the list it does support. That is the shape a fixture can legitimately prove.
 */
export const CLOSED_COMMAND_SET: CommandBoundary = {
  policy: "closed-command-set",
  reason: "there is no PATH, no shell and no process spawn, so only the documented commands can run here",
  alternative: "use node, npm, npx or one of the built-in file commands; type `help` for the list",
};

export type Command =
  | { readonly kind: "install"; readonly args: readonly string[] }
  | { readonly kind: "builtin"; readonly name: (typeof BUILTIN_COMMANDS)[number]; readonly args: readonly string[] }
  | { readonly kind: "process"; readonly name: (typeof PROCESS_COMMANDS)[number]; readonly args: readonly string[] }
  | { readonly kind: "refused"; readonly name: string; readonly reason: string; readonly boundary?: CommandBoundary }
  | { readonly kind: "empty" }
  /**
   * A line outside the closed set, or one that is not a line at all.
   *
   * `boundary` is what separates the two: an unknown NAME is a permanent boundary, while an unbalanced quote is a malformed user
   * input, which is a failure and not a policy the project chose.
   */
  | { readonly kind: "unsupported"; readonly name: string; readonly boundary?: CommandBoundary };

/** Split a line into tokens, honouring single and double quotes. Unbalanced quotes are an error, not a guess. */
export function tokenize(line: string): { readonly ok: true; readonly tokens: readonly string[] } | { readonly ok: false; readonly error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const character of line) {
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
    if (character === " " || character === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (quote !== null) return { ok: false, error: `unbalanced ${quote} quote` };
  if (started) tokens.push(current);
  return { ok: true, tokens };
}

export function parseCommand(line: string): Command {
  const tokenized = tokenize(line.trim());
  // A malformed line is the user's mistake, not a boundary we keep: no policy record, so it never reaches a by-design verdict.
  if (!tokenized.ok) return { kind: "unsupported", name: tokenized.error };

  const [head, ...rest] = tokenized.tokens;
  if (head === undefined || head === "") return { kind: "empty" };

  if ((BUILTIN_COMMANDS as readonly string[]).includes(head)) {
    return { kind: "builtin", name: head as (typeof BUILTIN_COMMANDS)[number], args: rest };
  }
  if ((PROCESS_COMMANDS as readonly string[]).includes(head)) {
    return { kind: "process", name: head as (typeof PROCESS_COMMANDS)[number], args: rest };
  }
  if (head === "npm") return { kind: "install", args: rest };
  const refusal = REFUSED_COMMANDS[head];
  if (refusal !== undefined && refusal.reason !== "") {
    return { kind: "refused", name: head, reason: refusal.reason, ...(refusal.boundary === undefined ? {} : { boundary: refusal.boundary }) };
  }

  return { kind: "unsupported", name: head, boundary: CLOSED_COMMAND_SET };
}

/**
 * Resolve `target` against `cwd`, POSIX-style. `..` above the root stays at the root rather than escaping it: a project
 * has one root and walking out of it is not a capability we offer.
 */
export function resolvePath(cwd: string, target: string): string {
  if (target === "" || target === ".") return normalize(cwd);
  const base = target.startsWith("/") ? "/" : cwd;
  const segments = `${base}/${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

export function normalize(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** The parent of a path, or `/` for a top-level entry. */
export function dirname(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function joinPath(...parts: readonly string[]): string {
  return normalize(parts.join("/"));
}
