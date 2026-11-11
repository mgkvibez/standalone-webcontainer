/**
 * Splitting a package.json script body into the commands a shell would run.
 *
 * npm runs scripts with a shell, and the ecosystem writes `tsc && vite build` more often than it writes anything else. The container
 * used to take such a body apart by whitespace, find `node` at the front of it and hand the WHOLE line to the process launcher, which
 * then ran `node tsc && vite build` as far as the first command and reported exit 0. A build script whose second half never ran was
 * therefore green, which is the one failure mode this project exists to make impossible.
 *
 * What is implemented is the sequencing half of a shell: `&&` and `||`, left to right, with short-circuit. Not pipes, not redirection,
 * not subshells: those change what a program sees, and a container that half-implemented them would be lying about a shell it does not
 * have. A body using them keeps whatever behaviour a single command gives it today, which is at least honest.
 */

/** One command and the operator that follows it. `null` for the last one. */
export interface ScriptSegment {
  readonly command: string;
  readonly operator: "&&" | "||" | null;
}

/**
 * Quote-aware split on `&&` and `||`.
 *
 * Quotes matter: `--message "a && b"` is one argument, and splitting there would run a command nobody wrote. Backslash escapes are
 * honoured inside and outside quotes for the same reason.
 */
export function splitScriptLine(script: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] as string;

    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        const next = script[index + 1];
        if (next !== undefined) {
          current += character + next;
          index += 1;
          continue;
        }
      }
      if (character === quote) quote = null;
      current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "&" || character === "|") {
      const next = script[index + 1];
      // A single `&` or `|` is a pipe or a background job: neither is implemented, so it stays part of the command and the launcher
      // refuses it by name rather than this parser inventing a meaning for it.
      if (next === character) {
        // The operator attaches to the command before it. An empty command here means the body starts with an operator, which is a
        // syntax error rather than something to paper over: the caller sees a segment list that begins with no command and refuses it.
        const command = current.trim();
        if (command !== "") segments.push({ command, operator: character === "&" ? "&&" : "||" });
        current = "";
        index += 1;
        continue;
      }
    }

    current += character;
  }

  const last = current.trim();
  if (last !== "") segments.push({ command: last, operator: null });
  return segments;
}
