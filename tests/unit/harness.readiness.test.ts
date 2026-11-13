import { describe, expect, it } from "vitest";
import { awaitServerReady } from "../../tools/harness/readiness.js";

/**
 * W-28: a process that is RUNNING is not a server that is READY.
 *
 * These pin the rule that made the difference measurable: readiness is a real request that came back, counted, under a deadline a
 * caller can see. Nothing here asserts a duration as a correctness property (a slow machine must not fail the suite); the deadline
 * and attempt count are what a human reads in evidence.
 */
describe("awaitServerReady", () => {
  it("is ready on the first answer and says how many attempts it took", async () => {
    const readiness = await awaitServerReady({ probe: async () => ({ status: 200, body: "ok" }), port: 3300, deadlineMs: 500 });

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe(200);
    expect(readiness.attempts).toBe(1);
    expect(readiness.port).toBe(3300);
  });

  it("treats any answer as ready, because a 401 or a 500 is a server that answered", async () => {
    const readiness = await awaitServerReady({ probe: async () => ({ status: 500, body: "boom" }), port: 3301, deadlineMs: 500 });

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe(500);
  });

  it("keeps asking while the port is bound but nothing answers yet, then reports the attempt that worked", async () => {
    let asked = 0;
    const readiness = await awaitServerReady({
      probe: async () => {
        asked += 1;
        // The shape measured through vite: bound at ~1.1s, first answer at ~5.1s. Here: silent, silent, then an answer.
        if (asked < 3) throw new Error("connection refused");
        return { status: 200, body: "ready" };
      },
      port: 3300,
      deadlineMs: 2_000,
      intervalMs: 1,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.attempts).toBe(3);
    expect(asked).toBe(3);
  });

  it("gives up at its deadline and returns evidence rather than waiting forever", async () => {
    const readiness = await awaitServerReady({
      probe: async () => {
        throw new Error("connection refused");
      },
      port: 3302,
      deadlineMs: 60,
      intervalMs: 5,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBeUndefined();
    expect(readiness.lastError).toBe("connection refused");
    expect(readiness.attempts).toBeGreaterThanOrEqual(1);
    expect(readiness.deadlineMs).toBe(60);
    expect(readiness.elapsedMs).toBeLessThan(2_000);
  });

  it("never claims readiness from the port alone: with no probe answer there is no ready", async () => {
    const readiness = await awaitServerReady({ probe: async () => Promise.reject(new Error("no gateway route")), port: 3304, deadlineMs: 40, intervalMs: 1 });

    expect(readiness).not.toHaveProperty("status");
    expect(readiness.ready).toBe(false);
  });
});
