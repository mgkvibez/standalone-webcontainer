import { describe, expect, it } from "vitest";
import { createProcessShim, createSink } from "../../src/shims/process.js";
import { createTerminal } from "../../src/terminal/pty.js";

/**
 * A sink that says `isTTY: true` must carry the TTY API, because callers branch on the flag and then call the methods.
 *
 * `vite build` does: it reads `process.stdout.isTTY`, and then calls `process.stdout.clearLine(0)` to redraw its banner. This shim
 * answered the flag and threw on the call (`process.stdout.clearLine is not a function`), which failed fixtures 11 and 18 for a
 * reason that had nothing to do with the build. The pair of tests below is the rule: the claim and the API arrive together, or
 * neither does.
 */
const sinkWith = () => {
  const written: string[] = [];
  const sink = createSink((text) => written.push(text));
  return { sink, written };
};

describe("a sink attached to a terminal", () => {
  it("carries isTTY, the live size, and the four cursor methods Node's tty.WriteStream has", () => {
    const { sink } = sinkWith();
    const process = createProcessShim({ stdout: sink, terminal: createTerminal({ columns: 100, rows: 40 }) });

    expect(process.stdout.isTTY).toBe(true);
    expect(process.stdout.columns).toBe(100);
    expect(process.stdout.rows).toBe(40);
    for (const method of ["clearLine", "cursorTo", "moveCursor", "clearScreenDown"] as const) {
      expect(typeof process.stdout[method]).toBe("function");
    }
  });

  it("writes the ANSI the caller asked for, which is what a terminal does", () => {
    const { sink, written } = sinkWith();
    const process = createProcessShim({ stdout: sink, terminal: createTerminal() });

    process.stdout.clearLine?.(0);
    process.stdout.cursorTo?.(0);
    process.stdout.moveCursor?.(2, 0);
    process.stdout.clearScreenDown?.();

    expect(written).toContain("\u001b[2K"); // clear the whole line
    expect(written).toContain("\r"); // column 0 is a carriage return, as in Node
    expect(written).toContain("\u001b[2C"); // two columns right
    expect(written).toContain("\u001b[0J"); // clear to the end of the screen
  });

  it("keeps the size live rather than copying it at construction", () => {
    const { sink } = sinkWith();
    const terminal = createTerminal({ columns: 80, rows: 24 });
    const process = createProcessShim({ stdout: sink, terminal });

    terminal.resize(120, 50);

    expect(process.stdout.columns).toBe(120);
    expect(process.stdout.rows).toBe(50);
  });
});

describe("a sink with no terminal", () => {
  it("does not claim to be a tty and offers no cursor methods, because that is what a pipe looks like", () => {
    const { sink } = sinkWith();
    const process = createProcessShim({ stdout: sink });

    expect(process.stdout.isTTY).toBeUndefined();
    expect(process.stdout.clearLine).toBeUndefined();
  });
});
