/**
 * A refusal that survives the product's own process lifecycle.
 *
 * ADR-0014 says the runtime declines some capabilities on purpose, and the evidence layer is entitled to classify those runs as by-design
 * rather than as failures. In the browser that classification used to be impossible: the process Worker posted `{type:"exit", code}` and the
 * refusal died at that message, so a native addon reached the container as an ordinary exit 1 with a stack on stderr. The harness lane could
 * measure a refusal; the product could not show one.
 *
 * This spec drives the REAL page path - `Container` over `WorkerRuntimeClient` over the real `runtime.worker.ts` over a real `process-worker.ts`
 * - so what it asserts is that the record the runtime made inside a Worker is the record the container ends up holding. Nothing here reads
 * stderr to decide anything, which is the whole point: four outcomes are checked and only one of them may be a refusal.
 */

import { expect, test } from "@playwright/test";

/** A program that requires a native addon. The runtime refuses it by name, and the refusal escapes the program unhandled. */
const NEEDS_ADDON = `
const addon = require("./addon.node");
console.log("loaded", addon);
`;

/** The same refusal, caught by the program. It handled the refusal, so the run is an ordinary run and there is nothing to classify. */
const HANDLES_ADDON = `
try {
  require("./addon.node");
  console.log("loaded");
} catch (error) {
  console.log("handled:", error.name);
}
`;

/** An ordinary failure: a thrown Error, a non-zero exit, and no refusal anywhere. */
const THROWS = `
console.log("before");
throw new Error("ordinary bug in the program, not a design decision");
`;

test("a native addon refusal reaches the container as a refusal, through the page's real process lifecycle", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(
    async ({ needsAddon, handlesAddon, throws }) => {
      const { Container } = await import(new URL("/src/container/container.ts", location.origin).href);
      const { WorkerRuntimeClient } = await import(new URL("/src/browser/worker-client.ts", location.origin).href);

      /** The minimum a Container needs from the page's project store: a flat path-to-text map. */
      const files = (initial: Record<string, string>) => {
        const map = new Map(Object.entries(initial));
        return {
          list: () => [...map.keys()],
          listDirs: () => ["/"],
          read: (path: string) => map.get(path) ?? null,
          write: (path: string, contents: string) => void map.set(path, contents),
          mkdir: () => true,
          remove: (path: string) => map.delete(path),
        };
      };

      const container = new Container({
        runtime: new WorkerRuntimeClient(),
        // `/addon.node` must EXIST: the loader resolves a path before it decides what kind of module it is, and a refusal for a file that
        // is not there would be a resolution failure. Its contents are never read - the extension alone is the refusal.
        files: files({
          "/index.js": "console.log('ready');",
          "/needs-addon.js": needsAddon,
          "/handles.js": handlesAddon,
          "/throws.js": throws,
          "/addon.node": "a binary this runtime never parses",
        }),
      });
      const session = container.createSession("refusal");

      const run = async (line: string) => {
        const outcome = await container.execute(session.id, line);
        const record = container.processes().at(-1) ?? null;
        return {
          exitCode: outcome.exitCode,
          refusal: outcome.refusal ?? null,
          frozen: outcome.refusal === undefined ? null : Object.isFrozen(outcome.refusal),
          recordRefusal: record?.refusal ?? null,
          recordState: record?.state ?? null,
          recordExitCode: record?.exitCode ?? null,
          scrollback: session.scrollback.map((entry: { stream: string; text: string }) => `${entry.stream}:${entry.text}`).join("\n"),
        };
      };

      const refused = await run("node needs-addon.js");
      session.scrollback.length = 0;
      const handled = await run("node handles.js");
      session.scrollback.length = 0;
      const threw = await run("node throws.js");
      session.scrollback.length = 0;
      const ok = await run("node index.js");

      return { refused, handled, threw, ok };
    },
    { needsAddon: NEEDS_ADDON, handlesAddon: HANDLES_ADDON, throws: THROWS },
  );

  // The refusal itself, with every field the runtime made. A container that copied stderr into this shape would not be able to produce the
  // closed-set code or the capability in words.
  expect(result.refused.exitCode).toBe(1);
  expect(result.refused.refusal).toMatchObject({
    code: "native-addon",
    capability: "native addon",
    subject: "/addon.node",
  });
  expect(result.refused.refusal?.message).toContain("native addons are not supported");

  // Identity survived the crossing: the page validates and re-freezes, so what the container holds is the frozen shape the runtime made and
  // not a mutable clone a later reader could rewrite.
  expect(result.refused.frozen).toBe(true);

  // And it is on the process record, so `ps` and every later reader see the outcome that actually happened.
  expect(result.refused.recordState).toBe("exited");
  expect(result.refused.recordExitCode).toBe(1);
  expect(result.refused.recordRefusal).toMatchObject({ code: "native-addon" });

  // The refusal still reaches a person: the diagnostic is in the transcript, unchanged.
  expect(result.refused.scrollback).toContain("native addons are not supported");

  // A program that CAUGHT the refusal handled it: an ordinary run, exit 0, nothing to classify.
  expect(result.handled.exitCode).toBe(0);
  expect(result.handled.refusal).toBeNull();
  expect(result.handled.recordRefusal).toBeNull();
  expect(result.handled.scrollback).toContain("handled: ProcessRefusal");

  // An ordinary crash is NOT a refusal, however non-zero it exits. This is the negative case that matters: if the boundary inferred a
  // refusal from a failure, this assertion fails and the by-design bucket fills with our own bugs.
  expect(result.threw.exitCode).toBe(1);
  expect(result.threw.refusal).toBeNull();
  expect(result.threw.recordRefusal).toBeNull();
  expect(result.threw.recordState).toBe("exited");

  // And a plain success has none either.
  expect(result.ok.exitCode).toBe(0);
  expect(result.ok.refusal).toBeNull();
});
