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

/**
 * The shape vite's file watcher has: a server, plus repeating work of its own that no request ever asks for.
 *
 * A single deferred timer only proves the pump turns once; this proves it keeps turning, which is the difference between a pre-bundler that
 * finishes and a watcher that keeps seeing saves.
 */
const tickingProgram = `const http = require("node:http");
const fs = require("node:fs");
let count = 0;
http.createServer((_request, response) => response.end("ok")).listen(3411, "127.0.0.1", () => console.log("listening"));
setInterval(() => {
  count += 1;
  fs.writeFileSync("/app/ticks.txt", String(count));
}, 100);
console.log("armed");
`;

const runPeriodic = async (periodMs: number): Promise<InProcessRuntime> => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/s.mjs", `const http = require("node:http");
const fs = require("node:fs");
let count = 0;
http.createServer((_request, response) => response.end("ok")).listen(3412, "127.0.0.1", () => console.log("listening"));
setInterval(() => {
  count += 1;
  fs.writeFileSync("/app/periodic.txt", String(count));
}, ${String(periodMs)});
console.log("armed");
`);
  const runtime = new InProcessRuntime(vfs);
  await runtime.run("/app/s.mjs", { cwd: "/app" });
  return runtime;
};

const runTicking = async (): Promise<InProcessRuntime> => {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/s.mjs", tickingProgram);
  const runtime = new InProcessRuntime(vfs);
  await runtime.run("/app/s.mjs", { cwd: "/app" });
  return runtime;
};

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

  it("keeps a repeating timer running, not just one deferred one", async () => {
    const runtime = await runTicking();
    const deadline = Date.now() + 3_000;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = Number(runtime.readFileText("/app/ticks.txt") ?? "0");
      if (seen >= 3) break;
      await sleep(25);
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  /**
   * A live program's interval must survive its own budget.
   *
   * The fire cap is `ceil(execution budget / delay)`, so a one-second interval under the one-second body budget is capped at ONE fire. That is
   * exactly real vite's watcher interval, and it is why the browser product printed one tick and then went silent while the pump kept turning.
   */
  it("keeps a one-second interval firing past the execution budget", async () => {
    const runtime = await runPeriodic(1_000);
    const deadline = Date.now() + 8_000;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = Number(runtime.readFileText("/app/periodic.txt") ?? "0");
      if (seen >= 3) break;
      await sleep(25);
    }
    expect(seen).toBeGreaterThanOrEqual(3);
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

  /**
   * A live timer is the program's own wake-up, so the pump must not fall idle while it owns one.
   *
   * This is the exact shape of the browser product's hot-reload failure: real vite schedules its watcher polls on its own timers, so an idle rule
   * that ignored handles stopped the pump 400 ms after boot and every later tick stayed pending forever - a `setInterval` printed one tick and
   * then silence, with no error anywhere.
   */
  it("keeps pumping for a program that owns a live interval", async () => {
    const scheduler = new Scheduler();
    const ticks: number[] = [];
    const interval = scheduler.setInterval(() => ticks.push(Date.now()), 30);

    const pump = scheduler.pumpResident({
      stillAlive: () => true,
      idleMs: 20,
      pollMs: 5,
      liveHandles: () => scheduler.liveHandles(),
    });
    await sleep(300);
    const whileRunning = ticks.length;
    scheduler.clear(interval);
    await expect(pump).resolves.toBe("queue-empty");
    // Well past one tick: the point is that the pump was still turning long after the idle window would have closed it.
    expect(whileRunning).toBeGreaterThan(3);
  });

  it("stops when the caller says the program is gone", async () => {
    const scheduler = new Scheduler();
    let alive = true;
    const pump = scheduler.pumpResident({ stillAlive: () => alive, idleMs: 5, pollMs: 5 });
    alive = false;
    await expect(pump).resolves.toBe("queue-empty");
  });
});
