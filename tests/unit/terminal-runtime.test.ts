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

    const running = runtime.run("/app/main.js", { terminal });
    // End of input once the program has had time to attach its reader. The run no longer ends by itself here: a waiting reader is
    // a live handle, which is the whole point of the case above.
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.end();
    const result = await running;

    expect(result.stdout).toContain("got:hello from the keyboard");
    expect(result.stdout).toContain("raw:false");
    expect(result.stdout).toContain("rawAfter:true");
    expect(result.exitCode).toBe(0);
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

/**
 * Interactive programs: a program that waits, a user who answers, and an exit that means what it says.
 *
 * These three properties are one story, and each was broken in a way that only showed up together. Stdin was not a live handle,
 * so a program whose only job was to answer a question exited before it could be asked. Waiting for input was counted against
 * the runaway guard, so a genuinely interactive program would have been killed five seconds in. And `process.exit` called from
 * a callback or an input handler escaped as an uncaught exception with the wrong exit code, because only the top-level body
 * was guarded.
 */
describe("a program that waits for input", () => {
  it("stays alive while it waits, and exits when input ends", async () => {
    const { runtime } = stage(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        console.log("heard:" + String(chunk).trim());
      });
      process.stdin.on("end", () => {
        console.log("ended");
      });
    `);
    const terminal = createTerminal();

    const running = runtime.run("/app/main.js", { terminal });
    // The program has no timers and no pending work: only the reader keeps it alive. Give the drain a turn to notice that,
    // then answer. If stdin were not a live handle the run would already have finished with empty output.
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.end();

    const result = await running;

    expect(result.stdout).toContain("heard:hello");
    expect(result.stdout).toContain("ended");
    expect(result.exitCode).toBe(0);
  });

  it("does not run out the runaway guard while it waits", async () => {
    const { runtime } = stage(`
      process.stdin.on("data", (chunk) => {
        console.log("late:" + String(chunk).trim());
        process.exit(0);
      });
    `);
    // A 5 ms ceiling on WORKING time: without idle exclusion the program is stopped long before the answer arrives 120 ms from
    // now. That is the bug a user on a slower machine would have met instead of a test.
    const terminal = createTerminal();
    const running = runtime.run("/app/main.js", { terminal, workCeilingMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 120));
    terminal.write("answer\n");

    const result = await running;

    expect(result.stdout).toContain("late:answer");
    expect(result.exitCode).toBe(0);
  });

  it("reports the code when a program exits from a stdin handler", async () => {
    const { runtime } = stage(`
      process.stdin.on("data", () => {
        process.exit(7);
      });
    `);
    const terminal = createTerminal();
    const running = runtime.run("/app/main.js", { terminal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.write("quit\n");

    const result = await running;

    // Not 1, and not an "Uncaught ProcessExit": the program chose 7, and the run has to agree.
    expect(result.exitCode).toBe(7);
    expect(result.stderr).not.toContain("Uncaught");
  });

  it("reports the code when a program exits from a timer callback", async () => {
    const { runtime } = stage(`
      setTimeout(() => {
        process.exit(3);
      }, 5);
      setTimeout(() => {
        console.log("must-not-run");
      }, 20);
    `);

    const result = await runtime.run("/app/main.js");

    expect(result.exitCode).toBe(3);
    // Immediate means immediate: a timer queued before the exit does not get to run afterwards.
    expect(result.stdout).not.toContain("must-not-run");
    expect(result.stderr).not.toContain("Uncaught");
  });

  it("reports the code when a program exits from a signal handler", async () => {
    const { runtime } = stage(`
      process.stdin.on("data", () => {});
      process.on("SIGWINCH", () => {
        console.log("resized");
        process.exit(4);
      });
    `);
    const terminal = createTerminal();
    const running = runtime.run("/app/main.js", { terminal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.resize(120, 40);

    const result = await running;

    // The signal listener is invoked by the terminal, outside the scheduler: before the guard existed this escaped as an
    // uncaught exception that killed the page's handler instead of ending the program with its own code.
    expect(result.stdout).toContain("resized");
    expect(result.exitCode).toBe(4);
    expect(result.stderr).not.toContain("Uncaught");
  });

  it("lets the program exit after it pauses stdin", async () => {
    const { runtime } = stage(`
      const onData = () => { console.log("never"); };
      process.stdin.on("data", onData);
      process.stdin.off("data", onData);
      console.log("unsubscribed");
    `);
    const terminal = createTerminal();

    // Nothing is waiting any more, so the run settles instead of hanging on a reader that cannot receive anything.
    const result = await runtime.run("/app/main.js", { terminal });

    expect(result.stdout).toContain("unsubscribed");
    expect(result.exitCode).toBe(0);
  });
});
