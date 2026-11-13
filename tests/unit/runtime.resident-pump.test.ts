/**
 * A program that keeps a port keeps its own queue (the defect `Scheduler.pumpResident` exists for).
 *
 * The request pump was bound to a request, so a dev server's own scheduled work had no moment in which to run. Vite is where it showed: the dev
 * server starts dependency pre-bundling from its own queue, so with the server idle nothing was written and the page waited on
 * `504 Outdated Optimize Dep` forever. Measured before the fix: `optimizer wrote picocolors.js: never within 60s` while idle, then `200` in 54 ms
 * the instant a request arrived. A live process in Node has no such gap.
 *
 * The assertion is deliberately NOT "a request is answered", which the request pump already covers, and not a wall-clock duration. It is: work a
 * program scheduled for itself, past the execution's virtual budget, lands while nobody is talking to it. The second case is the control that makes
 * the first mean something: the same program with no port keeps nothing running, so the file never appears.
 */
import { describe, expect, it } from "vitest";

import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { FileSystem } from "../../src/vfs/index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 1 200 ms is past the execution's 1 000 ms virtual budget on purpose: the run itself must NOT be what fires it. */
const program = (withServer: boolean): string => `${withServer ? `const http = require("node:http");
http.createServer((_request, response) => response.end("ok")).listen(3410, "127.0.0.1", () => console.log("listening"));
` : ""}const fs = require("node:fs");
setTimeout(() => {
  fs.writeFileSync("/app/late.txt", "late");
  console.log("wrote late.txt");
}, 1200);
`;

const runProgram = async (withServer: boolean): Promise<InProcessRuntime> => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/s.mjs", program(withServer));
  const runtime = new InProcessRuntime(vfs);
  await runtime.run("/app/s.mjs", { cwd: "/app" });
  return runtime;
};

/** Poll rather than sleep a fixed time: the pump is fast, and a fixed wait would encode the machine's speed into the test. */
const waitForFile = async (runtime: InProcessRuntime, ms: number): Promise<string | null> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const contents = runtime.readFileText("/app/late.txt");
    if (contents !== null || Date.now() >= deadline) return contents;
    await sleep(25);
  }
};

describe("a live process keeps its own queue", () => {
  it("runs a timer the program scheduled for itself, with no request in sight", async () => {
    const runtime = await runProgram(true);
    await expect(waitForFile(runtime, 3_000)).resolves.toBe("late");
  });

  it("does not run it for a program that holds nothing", async () => {
    // The control. Same program, no port: nothing is alive, so no pump is started and the deferred timer stays deferred, exactly as before.
    const runtime = await runProgram(false);
    await expect(waitForFile(runtime, 600)).resolves.toBeNull();
  });
});

describe("Scheduler.pumpResident", () => {
  it("runs one deferred timer and then stops once the queue has been empty long enough", async () => {
    const scheduler = new Scheduler();
    const seen: string[] = [];
    scheduler.setTimeout(() => seen.push("late"), 1_200);

    const started = Date.now();
    const stop = await scheduler.pumpResident({ stillAlive: () => true, idleMs: 60, pollMs: 5 });
    expect(seen).toEqual(["late"]);
    expect(stop).toBe("queue-empty");
    // It stopped by itself instead of waiting out a budget: the idle rule is the whole reason an idle server is not polled for its life.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops when the caller says the program is gone", async () => {
    const scheduler = new Scheduler();
    let alive = true;
    const pump = scheduler.pumpResident({ stillAlive: () => alive, idleMs: 5, pollMs: 5 });
    alive = false;
    await expect(pump).resolves.toBe("queue-empty");
  });
});
