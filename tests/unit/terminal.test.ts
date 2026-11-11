/**
 * The terminal, and the three shims that report it.
 *
 * The reason this file exists in this shape: every claim a program makes about being interactive comes from here
 * (`process.stdin.isTTY`, `tty.isatty(1)`, `process.stdout.columns`, `SIGWINCH`). Getting one wrong changes program behaviour
 * silently, in both directions: a false `isTTY` makes a CLI refuse to be interactive, and a true one makes it paint cursor
 * escapes into a buffer that cannot interpret them.
 *
 * So each test pins a fact a real terminal guarantees, and the awkward ones are the point: input typed before anything is
 * listening (a keystroke typed while the prompt is still starting up must not vanish), and resize that does not change the size
 * (a TUI that redraws for no reason is a bug you can see).
 */

import { describe, expect, it } from "vitest";
import { createTerminal, DEFAULT_COLUMNS, DEFAULT_ROWS } from "../../src/terminal/pty.js";
import { createProcessShim } from "../../src/shims/process.js";
import { createTtyShim } from "../../src/shims/tty.js";

describe("the terminal", () => {
  it("starts at 80x24, like a terminal that has not been told otherwise", () => {
    const terminal = createTerminal();
    expect(terminal.columns).toBe(DEFAULT_COLUMNS);
    expect(terminal.rows).toBe(DEFAULT_ROWS);
    expect(terminal.size()).toEqual({ columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS });
  });

  it("delivers typed text to a listener, in order", () => {
    const terminal = createTerminal();
    const seen: string[] = [];
    terminal.stdin.on("data", (chunk) => seen.push(chunk));

    terminal.write("a");
    terminal.write("bc");

    // Chunks are delivered as written: no coalescing and no line splitting, because the program asked for bytes.
    expect(seen).toEqual(["a", "bc"]);
  });

  it("keeps input typed before anything was listening", () => {
    const terminal = createTerminal();
    // Typed while the prompt is still starting: a real tty buffers this in the line discipline.
    terminal.write("early");

    const seen: string[] = [];
    terminal.stdin.on("data", (chunk) => seen.push(chunk));

    // Flushed as ONE chunk on attach, then live from there, so no byte is lost and none is reordered.
    expect(seen).toEqual(["early"]);
    terminal.write("late");
    expect(seen).toEqual(["early", "late"]);
  });

  it("emits SIGWINCH only when the size actually changes", () => {
    const terminal = createTerminal();
    let fired = 0;
    terminal.on("SIGWINCH", () => {
      fired += 1;
    });

    terminal.resize(120, 40);
    expect([terminal.columns, terminal.rows]).toEqual([120, 40]);
    expect(fired).toBe(1);

    // Same size again: Node's tty is silent here, and so is this. A TUI that redraws on every notification would flicker.
    terminal.resize(120, 40);
    expect(fired).toBe(1);
  });

  it("tells every SIGWINCH listener, and stops when one unsubscribes", () => {
    const terminal = createTerminal();
    const calls: string[] = [];
    const stopA = terminal.on("SIGWINCH", () => calls.push("a"));
    terminal.on("SIGWINCH", () => calls.push("b"));

    terminal.resize(100, 30);
    expect(calls).toEqual(["a", "b"]);

    stopA();
    terminal.resize(101, 31);
    expect(calls).toEqual(["a", "b", "b"]);
  });

  it("ends input once, and drops anything written after", () => {
    const terminal = createTerminal();
    let ends = 0;
    let data = 0;
    terminal.stdin.on("end", () => {
      ends += 1;
    });
    terminal.stdin.on("data", () => {
      data += 1;
    });

    terminal.write("x");
    terminal.end();
    terminal.end();
    terminal.write("after");

    expect(ends).toBe(1);
    // The byte before the end arrived; the one pretending to arrive after did not.
    expect(data).toBe(1);
    expect(terminal.stdin.readable).toBe(false);
  });

  it("delivers SIGINT from interrupt, and stays quiet with no listener", () => {
    const terminal = createTerminal();
    expect(() => terminal.interrupt()).not.toThrow();

    let interrupted = 0;
    terminal.on("SIGINT", () => {
      interrupted += 1;
    });
    terminal.interrupt();
    expect(interrupted).toBe(1);
  });

  it("tracks raw mode, which is the fact readline branches on", () => {
    const terminal = createTerminal();
    expect(terminal.stdin.isRaw).toBe(false);
    terminal.stdin.setRawMode(true);
    expect(terminal.stdin.isRaw).toBe(true);
    terminal.stdin.setRawMode(false);
    expect(terminal.stdin.isRaw).toBe(false);
  });

  it("refuses a nonsense size instead of carrying it", () => {
    const terminal = createTerminal();
    expect(() => terminal.resize(0, 24)).toThrow(RangeError);
    expect(() => terminal.resize(80, -1)).toThrow(RangeError);
    expect(() => createTerminal({ columns: 0 })).toThrow(RangeError);
    // A refused resize leaves the size alone rather than half-applying it.
    expect(terminal.columns).toBe(DEFAULT_COLUMNS);
  });
});

describe("the tty shim", () => {
  it("says yes for the descriptors the terminal owns and no for anything else", () => {
    const tty = createTtyShim(createTerminal());
    expect(tty.isatty(0)).toBe(true);
    expect(tty.isatty(1)).toBe(true);
    expect(tty.isatty(2)).toBe(true);
    // Not a lie by default: a descriptor nobody attached a terminal to is not a terminal.
    expect(tty.isatty(5)).toBe(false);
  });

  it("says no for every descriptor when no terminal is attached", () => {
    const tty = createTtyShim(null);
    for (const fd of [0, 1, 2]) expect(tty.isatty(fd)).toBe(false);
  });

  it("reports the window size at call time, not at construction time", () => {
    const terminal = createTerminal();
    const stream = new (createTtyShim(terminal).WriteStream)(1);
    expect(stream.getWindowSize()).toEqual([DEFAULT_COLUMNS, DEFAULT_ROWS]);

    terminal.resize(132, 43);
    // Live, because a program that resizes and asks again must see the new numbers.
    expect(stream.getWindowSize()).toEqual([132, 43]);
    expect([stream.columns, stream.rows]).toEqual([132, 43]);
  });

  it("throws ENOTTY rather than handing back a stream that lies", () => {
    const tty = createTtyShim(createTerminal());
    let caught: (Error & { code?: string }) | null = null;
    try {
      new tty.WriteStream(7);
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.code).toBe("ENOTTY");
  });

  it("routes ReadStream raw mode to the terminal's input", () => {
    const terminal = createTerminal();
    const stream = new (createTtyShim(terminal).ReadStream)(0);
    stream.setRawMode(true);
    // Same flag the program reads back from process.stdin, because they are the same input.
    expect(terminal.stdin.isRaw).toBe(true);
    expect(stream.isRaw).toBe(true);
  });
});

describe("the process shim reports the terminal honestly", () => {
  it("has no tty facts when no terminal is attached, and stdin is inert rather than absent", () => {
    const shim = createProcessShim();
    expect(shim.stdout.isTTY).toBeUndefined();
    expect(shim.stdout.columns).toBeUndefined();
    // Not null: Node always presents stdin as a stream, and vite's dev server dereferences it. See createInertInput for why each
    // answer it gives (isTTY undefined, no data, never ends, live() false) is the truthful one for a VM with no input device.
    expect(shim.stdin).not.toBeNull();
    expect(shim.stdin.isTTY).toBeUndefined();
    expect(shim.stdin.live()).toBe(false);
    const inert = shim.stdin;
    const seen: string[] = [];
    inert.on("data", () => seen.push("data"));
    inert.once("end", () => seen.push("end"));
    inert.resume();
    expect(seen).toEqual([]);
    expect(inert.listeners("data")).toBe(1);
    expect(inert.listeners("end")).toBe(1);
  });

  it("exposes live dimensions and the terminal's stdin when one is attached", () => {
    const terminal = createTerminal({ columns: 100, rows: 30 });
    const shim = createProcessShim({ terminal });

    expect(shim.stdout.isTTY).toBe(true);
    expect(shim.stderr.isTTY).toBe(true);
    expect(shim.stdout.columns).toBe(100);
    expect(shim.stdout.rows).toBe(30);
    expect(shim.stdin).toBe(terminal.stdin);

    terminal.resize(90, 25);
    expect(shim.stdout.columns).toBe(90);
  });

  it("delivers SIGWINCH to a process listener on resize", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    let resized = 0;
    shim.on("SIGWINCH", () => {
      resized += 1;
    });

    terminal.resize(70, 20);
    expect(resized).toBe(1);
  });

  it("removes exactly one listener on off, so re-registering cannot double-deliver", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    const calls: string[] = [];
    const first = () => calls.push("first");
    const second = () => calls.push("second");

    shim.on("SIGWINCH", first).on("SIGWINCH", second);
    shim.off("SIGWINCH", first);
    terminal.resize(70, 20);

    expect(calls).toEqual(["second"]);
  });

  it("accepts an event it cannot deliver without throwing, and never fires it", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    let got = 0;

    // Registration is accepted so chaining code keeps working, but nothing in this runtime produces SIGUSR2. Firing it
    // would be worse than ignoring it.
    expect(() => shim.on("SIGUSR2", () => {
      got += 1;
    })).not.toThrow();
    terminal.resize(70, 20);
    expect(got).toBe(0);
  });
});
