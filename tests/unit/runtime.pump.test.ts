/**
 * A served request keeps the timer queue running (the defect `Scheduler.pumpWhile` exists for).
 *
 * WHY THIS IS NOT A UNIT TEST OF A QUEUE. Measured with vite nowhere in sight: a dev server whose handler awaits `setTimeout(..., 10)` never
 * answered, and neither did one awaiting `setTimeout(..., 0)`. The server outlived its program body, and the queue was only pumped while a body
 * ran, so the promise that would resume the handler could never fire. A queue that passes its own tests while a served request still hangs is
 * the same defect with better coverage, so both halves are pinned here: the scheduler's pump in isolation, and the whole gateway path.
 *
 * The nightly check for this class of bug is `tools/probe-timer.ts`, which reports a status code rather than an impression.
 */
import { describe, expect, it } from "vitest";

import { PreviewGateway } from "../../src/network/preview-gateway.js";
import { PortRegistry } from "../../src/network/port-registry.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { FileSystem } from "../../src/vfs/index.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Scheduler.pumpWhile", () => {
  it("runs a timer that only exists so a pending promise can resume", async () => {
    const scheduler = new Scheduler();
    let fired = false;
    let resolve: () => void = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    scheduler.setTimeout(() => {
      fired = true;
      resolve();
    }, 10);

    const stop = await scheduler.pumpWhile(pending);
    expect(fired).toBe(true);
    expect(stop).toBe("queue-empty");
  });

  it("keeps pumping while the promise is outstanding, not while one callback runs", async () => {
    const scheduler = new Scheduler();
    const seen: string[] = [];
    let resolve: () => void = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    // Three hops, each needing its own turn of the queue: one pump that stopped after the first would print only "a".
    scheduler.setTimeout(() => {
      seen.push("a");
      scheduler.setTimeout(() => {
        seen.push("b");
        scheduler.setTimeout(() => {
          seen.push("c");
          resolve();
        }, 5);
      }, 5);
    }, 5);

    await scheduler.pumpWhile(pending);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("stops when the request settles instead of running the server's whole future", async () => {
    const scheduler = new Scheduler();
    const seen: string[] = [];
    let resolve: () => void = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    scheduler.setTimeout(() => {
      seen.push("before");
      resolve();
    }, 5);
    scheduler.setTimeout(() => {
      seen.push("after");
    }, 10);

    await scheduler.pumpWhile(pending);
    expect(seen).toEqual(["before"]);
  });

  it("measures a pump against its own allowance, not the execution's spent budget", async () => {
    // The execution's budget is 1 s of virtual time and its 1 000 ms timer was never run; a server may still schedule seconds ahead, so a pump
    // that inherited that ceiling would refuse the first request of a long-lived server.
    const scheduler = new Scheduler();
    let fired = false;
    let resolve: () => void = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    scheduler.setTimeout(() => {
      fired = true;
      resolve();
    }, 5_000);

    const stop = await scheduler.pumpWhile(pending);
    expect(fired).toBe(true);
    expect(stop).toBe("queue-empty");
  });

  it("refuses a nested pump rather than interleaving two loops over one queue", async () => {
    const scheduler = new Scheduler();
    const pending = new Promise<void>(() => {});
    const outer = scheduler.pumpWhile(pending, { maxRealMs: 5 });
    expect(await scheduler.pumpWhile(pending)).toBe("aborted");
    await outer;
  });
});

describe("a served request reaches its handler's timers", () => {
  it("answers a handler that awaits a 10 ms timer", async () => {
    const ports = new PortRegistry();
    const gateway = new PreviewGateway({ registry: ports, timeoutMs: 5_000 });
    const server = gateway.createServer((_req, response) => {
      setTimeout(() => response.end("after-timer"), 10);
    });
    server.listen(3300);

    const answer = await gateway.handle({
      method: "GET",
      url: "/preview/3300/",
      headers: {},
      body: new Uint8Array(),
    });
    expect(answer.statusCode).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe("after-timer");
  });

  it("answers a handler that awaits a 0 ms timer", async () => {
    const ports = new PortRegistry();
    const gateway = new PreviewGateway({ registry: ports, timeoutMs: 5_000 });
    const server = gateway.createServer((_req, response) => {
      setTimeout(() => response.end("zero"), 0);
    });
    server.listen(3301);

    const answer = await gateway.handle({ method: "GET", url: "/preview/3301/", headers: {}, body: new Uint8Array() });
    expect(answer.statusCode).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe("zero");
  });

  it("pumps for a request that arrives after the program body has finished", async () => {
    // The whole shape of a dev server: the program installed a listener and returned, and the request comes later. This is the level the defect
    // lived at, so it is asserted at this level: the runtime's pump, its scheduler, and the gateway the browser actually talks to.
    const vfs = new FileSystem();
    vfs.writeFileSync("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", type: "module" }));
    vfs.writeFileSync(
      "/app/s.mjs",
      `import http from "node:http";
const server = http.createServer((request, response) => {
  setTimeout(() => response.end("late:" + request.url), 10);
});
server.listen(3399);
console.log("listening");
`,
    );
    const runtime = new InProcessRuntime(vfs);
    const result = await runtime.run("/app/s.mjs", { cwd: "/app" });
    expect(result.stdout.trim()).toBe("listening");

    const answer = await runtime.gateway.handle({ method: "GET", url: "/preview/3399/x", headers: {}, body: new Uint8Array() });
    expect(answer.statusCode).toBe(200);
    expect(new TextDecoder().decode(answer.body)).toBe("late:/x");
    await settle();
  });
});
