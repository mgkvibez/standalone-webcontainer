/**
 * `process` shim: the listener surface, on a real terminal rather than a mock.
 *
 * Every assertion here was found by a real package calling the shim: `once` because vite's dev server registers a SIGTERM listener
 * before it does anything else, and the aliases because Node documents them as the same function under three names.
 */

import { describe, expect, it } from "vitest";

import { createProcessShim } from "../../src/shims/process.js";
import { createTerminal } from "../../src/terminal/pty.js";
import { createOsShim } from "../../src/shims/os.js";

describe("process listener registration", () => {
  it("fires a once listener exactly once and leaves an on listener registered", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    const seen: string[] = [];
    shim.once("SIGWINCH", () => seen.push("once"));
    shim.on("SIGWINCH", () => seen.push("on"));

    terminal.resize(100, 30);
    terminal.resize(120, 40);

    // The once listener is gone after its first delivery; the on listener takes both. A wrapper that forgot to unregister itself
    // would pass a single-resize test and fail here.
    expect(seen).toEqual(["once", "on", "on"]);
  });

  it("unregisters a once listener that was never fired, when the run disposes", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    let fired = 0;
    shim.once("SIGWINCH", () => {
      fired += 1;
    });
    shim.dispose();
    terminal.resize(100, 30);

    expect(fired).toBe(0);
  });

  it("treats addListener and removeListener as the same registration as on and off", () => {
    const terminal = createTerminal();
    const shim = createProcessShim({ terminal });
    const seen: string[] = [];
    const listener = (): void => {
      seen.push("added");
    };
    shim.addListener("SIGWINCH", listener);
    shim.removeListener("SIGWINCH", listener);
    terminal.resize(100, 30);

    expect(seen).toEqual([]);
  });

  it("returns the process object from every registration, so chaining works", () => {
    const shim = createProcessShim();
    expect(shim.on("SIGWINCH", () => {})).toBe(shim);
    expect(shim.once("SIGWINCH", () => {})).toBe(shim);
    expect(shim.off("SIGWINCH", () => {})).toBe(shim);
  });
});

describe("process.platform", () => {
  it("reports linux, and os.platform agrees, because esbuild keys a package name on both", () => {
    const shim = createProcessShim({ terminal: createTerminal(), argv: ["node", "/main.js"] });
    const os = createOsShim({ platform: shim.platform, env: shim.env });

    // P0-5: the value is "linux" because the code paths this runtime already provides are the POSIX ones, and "browser" sends a
    // package down a branch nothing here implements. Asserted as a pair because one answer in two places is the defect that
    // actually bites: esbuild composes `${process.platform} ${os.arch()} ${os.endianness()}` into its native-package key, so a shim
    // that reported linux while os reported browser would look installed and then fail to resolve.
    expect(shim.platform).toBe("linux");
    expect(os.platform()).toBe(shim.platform);
  });
});
