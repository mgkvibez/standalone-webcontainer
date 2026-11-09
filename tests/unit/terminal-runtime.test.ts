/**
 * The terminal, seen from a program through the real loader.
 *
 * `terminal.test.ts` pins the shims in isolation. This file is the other half of the claim: that a program which does
 * `require("tty")` and reads `process.stdout.columns` inside this runtime actually gets the attached terminal's answers, because
 * the shims were wired per-run rather than handed a module-level guess somewhere.
 *
 * The disposal case is here rather than in the shim tests on purpose. It is a RUNTIME property: the caller keeps one terminal
 * across many programs, so "the finished program's SIGWINCH listener no longer fires" can only be observed by running a program,
 * finishing it, and then resizing.
 */

import { describe, expect, it } from "vitest";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { createTerminal } from "../../src/terminal/pty.js";
import { FileSystem } from "../../src/vfs/index.js";

const stage = (source: string): { runtime: InProcessRuntime; vfs: FileSystem } => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/main.js", source);
  return { runtime: new InProcessRuntime(vfs), vfs };
};

describe("a program's view of the terminal", () => {
  it("has no tty facts at all when no terminal is attached", async () => {
    const { runtime } = stage(`
      const tty = require("tty");
      console.log("stdin:", process.stdin === null ? "null" : "stream");
      console.log("isTTY:", String(process.stdout.isTTY));
      console.log("isatty1:", tty.isatty(1));
    `);

    const result = await runtime.run("/app/main.js");

    // A fixture or a piped worker has no terminal, and every answer says so rather than defaulting to a friendly lie.
    expect(result.stdout).toContain("stdin: null");
    expect(result.stdout).toContain("isTTY: undefined");
    expect(result.stdout).toContain("isatty1: false");
    expect(result.exitCode).toBe(0);
  });

  it("reports the attached terminal's size, and require('tty') resolves as a builtin", async () => {
    const terminal = createTerminal({ columns: 100, rows: 30 });
    const { runtime } = stage(`
      const tty = require("tty");
      console.log("isTTY:", String(process.stdout.isTTY));
      console.log("size:", process.stdout.columns + "x" + process.stdout.rows);
      console.log("isatty1:", tty.isatty(1));
      console.log("isatty9:", tty.isatty(9));
      console.log("window:", new tty.WriteStream(1).getWindowSize().join("x"));
    `);

    const result = await runtime.run("/app/main.js", { terminal });

    expect(result.stdout).toContain("isTTY: true");
    expect(result.stdout).toContain("size: 100x30");
    expect(result.stdout).toContain("isatty1: true");
    // A descriptor nobody attached a terminal to is still not a terminal.
    expect(result.stdout).toContain("isatty9: false");
    expect(result.stdout).toContain("window: 100x30");
  });

  it("delivers input typed before the program started reading", async () => {
    const terminal = createTerminal();
    // Typed while the program is still starting up: a real tty buffers this, and a program that reads once must not miss it.
    terminal.write("hello from the keyboard\n");
    const { runtime } = stage(`
      process.stdin.on("data", (chunk) => {
        console.log("got:" + chunk.trim());
        console.log("raw:" + process.stdin.isRaw);
        process.stdin.setRawMode(true);
        console.log("rawAfter:" + process.stdin.isRaw);
      });
    `);

    const result = await runtime.run("/app/main.js", { terminal });

    expect(result.stdout).toContain("got:hello from the keyboard");
    expect(result.stdout).toContain("raw:false");
    expect(result.stdout).toContain("rawAfter:true");
  });

  it("stops delivering a finished program's signals once the run is over", async () => {
    const terminal = createTerminal();
    // The listener THROWS rather than logs. A logging listener would pass this test even if it were still attached, because a
    // write into a sink whose run already finished is invisible; a throw is not.
    const { runtime } = stage(`
      process.on("SIGWINCH", () => { throw new Error("a finished program's listener must not fire"); });
      console.log("registered");
    `);

    const result = await runtime.run("/app/main.js", { terminal });
    expect(result.stdout).toContain("registered");

    // The terminal is the caller's and survives the run. A listener left attached would fire here, with its program's exit
    // already reported, so this resize is the assertion that disposal happened.
    expect(() => terminal.resize(120, 40)).not.toThrow();
    expect(terminal.columns).toBe(120);
  });

  it("gives each run the size current at that moment, not the size at first attachment", async () => {
    const terminal = createTerminal({ columns: 80, rows: 24 });
    const { runtime } = stage(`console.log("cols:" + process.stdout.columns);`);

    const first = await runtime.run("/app/main.js", { terminal });
    expect(first.stdout).toContain("cols:80");

    terminal.resize(140, 50);
    const second = await runtime.run("/app/main.js", { terminal });
    expect(second.stdout).toContain("cols:140");
  });
});
