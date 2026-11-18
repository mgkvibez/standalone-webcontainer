import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * R1: does the Process Worker actually depend on the capture module?
 *
 * The browser test in `tests/browser/w19-quarantine.spec.ts` proves the capture is INVISIBLE to user code. That is a
 * privacy assertion and it passes just as happily when the module is never imported at all - so on its own it cannot
 * catch the one regression that matters here: someone deleting the side-effect import while tidying `process-worker.ts`.
 *
 * This guard is the other half. It reads the real entry file and asserts the dependency exists, and it is deliberately
 * static: proving evaluation at runtime would need either a test hook on the production path (a hole in the privacy
 * boundary this phase exists to keep) or a published global (the same hole, wider). ES module semantics do the ordering
 * work for us - a module's dependencies are evaluated before its body runs, so a static dependency IS a guarantee that
 * the capture happened before the Worker can install its start handler.
 */
const WORKER = new URL("../../src/process/process-worker.ts", import.meta.url);
const IN_PROCESS = new URL("../../src/runtime/in-process.ts", import.meta.url);
const QUARANTINE = new URL("../../src/process/quarantine.ts", import.meta.url);

const workerSource = (): string => readFileSync(WORKER, "utf8");

describe("the Process Worker depends on the capture module", () => {
  it("imports the quarantine module for its side effect", () => {
    // Matched as a bare side-effect import: a type-only import would be erased at compile time and capture nothing.
    expect(workerSource()).toMatch(/^import "\.\/quarantine\.js";$/m);
  });

  it("does not import it as a type, which would compile away", () => {
    expect(workerSource()).not.toMatch(/^import type .*quarantine/m);
  });

  it("names the dependency before the start handler it must precede", () => {
    const source = workerSource();
    const importAt = source.indexOf('"./quarantine.js"');
    const startHandlerAt = source.indexOf("scope.onmessage =");
    expect(importAt, "the quarantine import is missing entirely").toBeGreaterThan(-1);
    expect(startHandlerAt).toBeGreaterThan(-1);
    // Source order documents the intent; module semantics enforce it. Both are asserted because a reader should not have
    // to know that imports hoist in order to see why the ordering claim holds.
    expect(importAt).toBeLessThan(startHandlerAt);
  });

  it("is not reachable from the Node/in-process lane", () => {
    // P3-0 must not change the fixture lane. If the capture were imported from the shared runtime, the Node lane would
    // start depending on a process-Worker module and this phase would have quietly widened its blast radius.
    expect(readFileSync(IN_PROCESS, "utf8")).not.toContain("quarantine");
  });

  it("publishes nothing, so the privacy assertions in the browser test stay meaningful", () => {
    const capture = readFileSync(QUARANTINE, "utf8");
    // No global assignment, no facade export, no getter handed out: the only export is the capture itself, consumed by
    // the Worker's side-effect import.
    expect(capture).not.toMatch(/globalThis\.(realm|quarantine|capture)/i);
    expect(capture).not.toMatch(/Object\.defineProperty\(\s*(globalThis|self)/);
  });
});
