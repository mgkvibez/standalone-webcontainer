/**
 * Two real Workers, running at the same time.
 *
 * The unit tests prove the bookkeeping with a faked Worker. This proves the thing the bookkeeping exists for: that
 * execution is no longer serialised. Until ADR-0018, `#runQueue` meant one run at a time and `kill` terminated the only
 * Worker there was. Here two processes each hold a Worker for 200 ms, so a serialised host would need at least 400 ms of
 * wall clock. The assertion is on the clock, not on a flag.
 */

import { expect, test } from "@playwright/test";

const PROCESS_WORKER = `
self.onmessage = (event) => {
  const { argv, pid } = event.data;
  const delay = Number(argv[2] ?? "0");
  const startedAt = Date.now();
  while (Date.now() - startedAt < delay) { /* deliberately busy: this is the work being timed */ }
  self.postMessage({ type: "exit", code: pid, reason: String(delay) });
};
`;

test("two processes run concurrently, so the host is no longer serialised", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async (workerSource) => {
    const moduleUrl = new URL("/src/process/process-host.ts", location.origin).href;
    const { ProcessHost } = await import(moduleUrl);
    const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));

    const finished: { pid: number; state: string; exitCode?: number }[] = [];
    const host = new ProcessHost({
      spawn: () => new Worker(blobUrl, { type: "module" }),
      onChange: (entry: { readonly pid: number; readonly state: string; readonly exitCode?: number }) => {
        if (entry.state === "exited" || entry.state === "failed" || entry.state === "killed") {
          finished.push({ pid: entry.pid, state: entry.state, ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }) });
        }
      },
    });

    const startedAt = Date.now();
    host.start({ argv: ["node", "a.js", "200"] });
    host.start({ argv: ["node", "b.js", "200"] });

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (host.table.live().length === 0) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, 10_000);
    });

    return { elapsed: Date.now() - startedAt, finished, live: host.table.live().length };
  }, PROCESS_WORKER);

  expect(result.finished).toHaveLength(2);
  expect(result.finished.map((entry) => entry.state)).toEqual(["exited", "exited"]);
  expect(result.live).toBe(0);
  // Serialised execution would take at least 400 ms for two 200 ms bodies. Anything near that means we are still queueing.
  expect(result.elapsed).toBeLessThan(360);
});

test("killing one process leaves the other running to completion", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async (workerSource) => {
    const moduleUrl = new URL("/src/process/process-host.ts", location.origin).href;
    const { ProcessHost } = await import(moduleUrl);
    const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));

    const host = new ProcessHost({ spawn: () => new Worker(blobUrl, { type: "module" }) });
    const long = host.start({ argv: ["node", "long.js", "4000"] });
    const short = host.start({ argv: ["node", "short.js", "120"] });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const killed = host.kill(long.pid, "test kill");

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (host.table.get(short.pid).state === "exited") {
          clearInterval(poll);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, 10_000);
    });

    return {
      killed,
      longState: host.table.get(long.pid).state,
      longReason: host.table.get(long.pid).reason,
      shortState: host.table.get(short.pid).state,
      shortExit: host.table.get(short.pid).exitCode,
    };
  }, PROCESS_WORKER);

  expect(result.killed).toBe(true);
  expect(result.longState).toBe("killed");
  expect(result.longReason).toBe("test kill");
  // The neighbour is untouched: a kill that took the whole runtime down would show as failed or still running here.
  expect(result.shortState).toBe("exited");
  expect(result.shortExit).toBe(2);
});
