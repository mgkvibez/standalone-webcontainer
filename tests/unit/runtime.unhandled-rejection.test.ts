import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { watchUnhandledRejections } from "../../src/runtime/unhandled-rejections.js";
import { FileSystem } from "../../src/vfs/index.js";

/**
 * A floating rejection is a program failure, and Node's answer to one is exit 1.
 *
 * Found by running vite: its dev server called `process.exit(1)` from an async continuation nobody awaited. The rejection belonged to
 * no promise this runtime held, so it escaped the program and killed the host process, and the run had already been reported as exit 0.
 * These tests hold both halves of the fix: the program's own verdict, and the host surviving it.
 */
const runProgram = async (source: string) => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/main.js", source);
  return new InProcessRuntime(vfs).run("/app/main.js");
};

describe("an unhandled rejection inside a program", () => {
  it("fails the run with exit 1 and prints the reason, as Node does", async () => {
    const result = await runProgram('Promise.reject(new Error("boom"));');

    expect(result.exitCode).toBe(1);
    // Node prints the reason in the uncaught-exception shape; matching that shape is what makes a failure readable to a human who
    // knows Node, and it is the same prefix the runtime already uses for a throw from a callback.
    expect(result.stderr).toContain("Uncaught Error: boom");
  });

  it("fails the run when the rejection comes from a timer callback", async () => {
    // This is the shape vite actually had: the rejection was created in a continuation scheduled by work nobody awaited.
    const result = await runProgram('setTimeout(() => { void Promise.reject(new Error("from a timer")); }, 0);');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("from a timer");
  });

  it("does not fail a rejection that the program handles in the same turn", async () => {
    // Node only reports a rejection once the microtask queue has drained with no handler attached, and the observer rides on that same
    // event, so a handled rejection is never seen. This test is the false-positive guard.
    const result = await runProgram(
      ['const p = Promise.reject(new Error("handled"));', 'p.catch(() => console.log("caught it"));'].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("caught it\n");
    expect(result.stderr).toBe("");
  });

  it("does not fail a program that legitimately runs to completion", async () => {
    const result = await runProgram('Promise.resolve(1).then((n) => console.log("done", n));');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done 1\n");
  });
});

describe("the observer's own discipline", () => {
  it("leaves no listener on the host after the run", async () => {
    const before = process.listenerCount("unhandledRejection");
    await runProgram('Promise.reject(new Error("boom"));');
    // A leaked `unhandledRejection` listener would suppress the host's own crash reporting for every later run: the fix has to cost
    // the host nothing once the run is over.
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("does so even when the run finishes cleanly", async () => {
    const before = process.listenerCount("unhandledRejection");
    await runProgram('console.log("clean");');
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("stops observing after stop() is called", () => {
    const seen: unknown[] = [];
    const watch = watchUnhandledRejections((reason) => seen.push(reason));

    expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(0);
    watch.stop();
    watch.stop(); // idempotent: a second stop must not remove somebody else's listener
    expect(seen).toEqual([]);
  });

  it("falls back to the page's rejection event where there is no Node process", () => {
    // The browser lane has no `process.on`, so the same observation has to be able to come from the page event. This exercises the
    // fallback directly rather than trusting that the branch exists.
    const listeners = new Set<(event: { reason: unknown; preventDefault?: () => void }) => void>();
    const fake = {
      addEventListener: (name: string, listener: (event: { reason: unknown; preventDefault?: () => void }) => void) => {
        if (name === "unhandledrejection") listeners.add(listener);
      },
      removeEventListener: (name: string, listener: (event: { reason: unknown; preventDefault?: () => void }) => void) => {
        if (name === "unhandledrejection") listeners.delete(listener);
      },
    };

    const originalProcess = (globalThis as { process?: unknown }).process;
    const originalAdd = (globalThis as { addEventListener?: unknown }).addEventListener;
    const originalRemove = (globalThis as { removeEventListener?: unknown }).removeEventListener;
    try {
      (globalThis as { process?: unknown }).process = undefined;
      (globalThis as { addEventListener?: unknown }).addEventListener = fake.addEventListener;
      (globalThis as { removeEventListener?: unknown }).removeEventListener = fake.removeEventListener;

      const seen: unknown[] = [];
      let prevented = false;
      const watch = watchUnhandledRejections((reason) => seen.push(reason));
      expect(listeners.size).toBe(1);

      for (const listener of listeners) listener({ reason: new Error("page"), preventDefault: () => (prevented = true) });

      // preventDefault is not decoration: without it the browser also logs the rejection as the page's own, which reads like a
      // runtime defect while the runtime is reporting the failure correctly.
      expect(prevented).toBe(true);
      expect((seen[0] as Error).message).toBe("page");

      watch.stop();
      expect(listeners.size).toBe(0);
    } finally {
      (globalThis as { process?: unknown }).process = originalProcess;
      (globalThis as { addEventListener?: unknown }).addEventListener = originalAdd;
      (globalThis as { removeEventListener?: unknown }).removeEventListener = originalRemove;
    }
  });
});
