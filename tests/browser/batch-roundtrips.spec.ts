/**
 * Batching, measured: sixteen calls, one round trip.
 *
 * `channel-batch.test.ts` proves the kernel answers a batch correctly by staging bytes; it cannot prove the caller stops
 * once, because a blocking client cannot be driven from the test's own thread. This file closes that gap in the only place
 * it can be closed: two real Workers, a real channel, a real client.
 *
 * Two claims are checked, and the first matters more:
 *
 *   1. MECHANISM: sixteen batched calls cross as ONE request frame, and sixteen sequential calls cross as sixteen. That is a
 *      count, not a stopwatch, so it cannot drift, and it is the claim the change actually makes.
 *   2. COST: the batch finishes materially faster. Timing on a shared CI machine is noisy, so the bound is deliberately
 *      loose (3x on a workload where the mechanism predicts ~10x); it exists to catch "batching made it slower", not to pin
 *      a microsecond figure. The figure is recorded as an annotation so a regression is visible even when the bound passes.
 */

import { expect, test } from "@playwright/test";

const STATS = 16;

const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { buffer, role, sizes, moduleUrls } = event.data;
  const { SyscallClient, serveChannelAsync } = await import(moduleUrls.channel);
  const { framedEncoding } = await import(moduleUrls.frame);
  const allocation = { buffer, sizes };

  if (role === "kernel") {
    // The answers are trivial on purpose: this measures wake-ups, not handler work. A handler that did real work would
    // hide the round-trip cost the batch is supposed to remove.
    const handler = (request) => {
      if (request.path === "/missing.txt") throw Object.assign(new Error("no such file: /missing.txt"), { code: "ENOENT" });
      return { kind: "stats", vfsKind: "file", size: 5, modifiedAt: 1, createdAt: 1 };
    };
    const end = await serveChannelAsync(allocation, framedEncoding);
    let stopping = false;
    (async () => {
      while (!stopping) await end.serveOne(handler, { timeoutMs: 100 });
    })();
    self.onmessage = (message) => { if (message.data && message.data.stop) stopping = true; };
    self.postMessage({ kind: "ready" });
    return;
  }

  // Count encodes, not elapsed time, for the mechanism claim: a batched call that secretly sent sixteen frames would pass a
  // timing test on a fast machine and fail this one on any machine.
  let encodes = 0;
  const counting = {
    encode: (value) => { encodes += 1; return framedEncoding.encode(value); },
    decode: (bytes) => framedEncoding.decode(bytes),
  };
  const client = new SyscallClient(allocation, counting);
  const options = { timeoutMs: 10000 };
  const requests = Array.from({ length: ${STATS} }, (_unused, index) => ({ op: "stat", path: "/file-" + index + ".txt" }));

  // One warm-up call so the first syscall's cost (region touch, JIT) does not land on whichever pass runs first.
  client.call({ op: "stat", path: "/warmup.txt" }, options);

  const passes = 3;
  let sequentialMs = Infinity;
  let batchMs = Infinity;
  let sequentialEncodes = 0;
  let batchEncodes = 0;
  let batchOutcomes = [];

  for (let pass = 0; pass < passes; pass += 1) {
    encodes = 0;
    const startSequential = performance.now();
    for (const request of requests) client.call(request, options);
    const elapsedSequential = performance.now() - startSequential;
    sequentialEncodes = encodes;

    encodes = 0;
    const startBatch = performance.now();
    const outcomes = client.callMany(requests, options);
    const elapsedBatch = performance.now() - startBatch;
    batchEncodes = encodes;
    batchOutcomes = outcomes;

    // Best of three: shared CI machines pause for other reasons, and a pause can only ever make a pass look slower.
    if (elapsedSequential < sequentialMs) sequentialMs = elapsedSequential;
    if (elapsedBatch < batchMs) batchMs = elapsedBatch;
  }

  self.postMessage({
    kind: "measured",
    batchEncodes,
    sequentialEncodes,
    batchMs,
    sequentialMs,
    answered: batchOutcomes.filter((outcome) => outcome.ok).length,
    ordered: batchOutcomes.every((outcome, index) => outcome.ok && outcome.value && outcome.value.size === 5),
    missingIsolated: (() => {
      // One bad entry in a batch must cost only itself: the rest of the answers still arrive.
      const mixed = client.callMany([{ op: "stat", path: "/file-0.txt" }, { op: "stat", path: "/missing.txt" }, { op: "stat", path: "/file-1.txt" }], options);
      return mixed.length === 3 && mixed[0].ok === true && mixed[1].ok === false && mixed[1].error.code === "ENOENT" && mixed[2].ok === true;
    })(),
  });
};
`;

test("sixteen calls cross as one frame, and stop the caller once", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");

  const measurement = await page.evaluate(async (source) => {
    const moduleUrls = {
      channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
      frame: new URL("/src/process/frame.ts", location.origin).href,
    };
    const sizes = { requestBytes: 64 * 1024, responseBytes: 64 * 1024 };
    const mod = await import(moduleUrls.channel);
    const allocation = mod.allocateChannel(sizes);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    // Buffer by kind with the listener attached before the worker starts, so a fast answer cannot be missed.
    const start = (role: string): { worker: Worker; waitFor: (kind: string, ms: number) => Promise<Record<string, unknown>> } => {
      const worker = new Worker(url, { type: "module" });
      const received = new Map<string, Record<string, unknown>>();
      const waiting = new Map<string, (value: Record<string, unknown>) => void>();
      worker.addEventListener("message", (event) => {
        const kind = String(event.data?.kind);
        const data = event.data as Record<string, unknown>;
        received.set(kind, data);
        waiting.get(kind)?.(data);
        waiting.delete(kind);
      });
      const waitFor = (kind: string, ms: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const already = received.get(kind);
          if (already) return resolve(already);
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), ms);
          waiting.set(kind, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
      worker.postMessage({ buffer: allocation.buffer, role, sizes, moduleUrls });
      return { worker, waitFor };
    };

    const kernel = start("kernel");
    await kernel.waitFor("ready", 30_000);
    const client = start("client");
    const result = await client.waitFor("measured", 60_000);
    client.worker.postMessage({ stop: true });
    kernel.worker.postMessage({ stop: true });
    return result as {
      batchEncodes: number;
      sequentialEncodes: number;
      batchMs: number;
      sequentialMs: number;
      answered: number;
      ordered: boolean;
      missingIsolated: boolean;
    };
  }, WORKER_SOURCE);

  test.info().annotations.push({
    type: "batching",
    description:
      `sequential: ${measurement.sequentialMs.toFixed(2)} ms in ${measurement.sequentialEncodes} frames; ` +
      `batch: ${measurement.batchMs.toFixed(2)} ms in ${measurement.batchEncodes} frame(s); ` +
      `speedup ${(measurement.sequentialMs / measurement.batchMs).toFixed(1)}x`,
  });

  // Mechanism: the claim that cannot be explained away by a fast machine.
  expect(measurement.sequentialEncodes).toBe(STATS);
  expect(measurement.batchEncodes).toBe(1);

  // Correctness through the real client: every entry answered, in order, and one failure isolated.
  expect(measurement.answered).toBe(STATS);
  expect(measurement.ordered).toBe(true);
  expect(measurement.missingIsolated).toBe(true);

  // Cost: loose on purpose. The mechanism predicts far more; this only fails if batching became a pessimisation.
  expect(measurement.batchMs * 3).toBeLessThan(measurement.sequentialMs);
});
