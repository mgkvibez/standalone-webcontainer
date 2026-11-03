import { afterEach, describe, expect, it, vi } from "vitest";

import { TIMEOUTS } from "../../src/harness/types.js";
import { withTimeout } from "../../src/harness/timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("returns the value when the work finishes first", async () => {
    const result = await withTimeout(async () => 42, 1000);
    expect(result).toEqual({ ok: true, value: 42, elapsedMs: expect.any(Number) });
  });

  it("returns TIMEOUT as a classification instead of throwing", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(() => new Promise<never>(() => undefined), 50);
    await vi.advanceTimersByTimeAsync(60);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.classification).toBe("TIMEOUT");
    }
  });

  it("leaves no timer behind when the work wins the race", async () => {
    vi.useFakeTimers();
    const result = await withTimeout(async () => "fast", 10_000);
    expect(result.ok).toBe(true);
    // If the timer survived, vitest reports a pending timer here.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a rejection, because a thrown harness bug is not a timeout", async () => {
    await expect(withTimeout(async () => { throw new Error("boom"); }, 1000)).rejects.toThrow("boom");
  });

  it("does not crash the run when the work rejects after the timeout already won", async () => {
    vi.useFakeTimers();
    let rejectLate: ((error: Error) => void) | undefined;
    const pending = withTimeout(
      () => new Promise<never>((_, reject) => { rejectLate = reject; }),
      20,
    );
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expect(result.ok).toBe(false);
    rejectLate?.(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    // Reaching here without an unhandled rejection is the assertion.
    expect(result.ok).toBe(false);
  });

  it("rejects a nonsense timeout rather than hanging", async () => {
    await expect(withTimeout(async () => 1, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(withTimeout(async () => 1, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
  });

  it("carries the charter's three hard timeouts", () => {
    expect(TIMEOUTS).toEqual({ installMs: 180_000, buildMs: 240_000, runMs: 60_000 });
  });
});
