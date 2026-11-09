/**
 * The syscall channel with real Workers.
 *
 * `Atomics.wait` cannot be called from a page's main thread, and Node's main thread refuses it too, so the blocking half of
 * ADR-0018's design can only be proven where it will actually run. These tests create two module Workers, hand both the
 * same `SharedArrayBuffer`, and check the two properties that matter: the answer is right, and the caller really was
 * stopped while the kernel worked.
 */

import { expect, test } from "@playwright/test";

interface WorkerOutcome {
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
  readonly beforeCall?: number;
  readonly afterCall?: number;
  readonly handled?: boolean;
}

/** Module source shared by both Workers. Written once so the two roles cannot drift apart. */
const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { buffer, role, sizes, delayMs, moduleUrl } = event.data;
  // A blob Worker's base URL is the blob itself, so a path specifier like "/src/x.ts" cannot resolve. The page passes the
  // absolute URL instead, which is the only form that works here.
  const mod = await import(moduleUrl);
  const allocation = { buffer, sizes };

  if (role === "kernel") {
    const server = mod.serveChannel(allocation);
    const handled = server.serveOne((request) => {
      const startedAt = Date.now();
      // Hold the kernel long enough that "the caller was blocked" is measurable, not inferred from a passing test.
      while (Date.now() - startedAt < delayMs) { /* deliberate */ }
      return { doubled: request.n * 2, handledAt: startedAt };
    }, { timeoutMs: 10000 });
    self.postMessage({ handled });
    return;
  }

  if (role === "silent-kernel") {
    // Attaches to nothing and never answers, so the caller's deadline is the only thing that can end its wait. A kernel
    // that called serveOne would reply by design (that is what serveOne does), which would prove the opposite of this test.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return;
  }

  const client = new mod.SyscallClient(allocation);
  const beforeCall = Date.now();
  try {
    const value = client.call({ n: 21 }, { timeoutMs: 800 });
    self.postMessage({ value, beforeCall, afterCall: Date.now() });
  } catch (error) {
    self.postMessage({ error: { name: error.name, message: error.message }, beforeCall, afterCall: Date.now() });
  }
};
`;

test("a process Worker is stopped while the kernel answers, and gets the right value", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(async (source) => {
    const moduleUrl = new URL("/src/process/syscall-channel.ts", location.origin).href;
    const mod = await import(moduleUrl);
    const sizes = { requestBytes: 4096, responseBytes: 4096 };
    const allocation = mod.allocateChannel(sizes);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    const run = (role: string): Promise<{ role: string } & Record<string, unknown>> =>
      new Promise((resolve) => {
        const worker = new Worker(url, { type: "module" });
        worker.onmessage = (event) => {
          resolve({ role, ...(event.data as Record<string, unknown>) });
          worker.terminate();
        };
        worker.postMessage({ buffer: allocation.buffer, role, sizes, delayMs: 60, moduleUrl });
        setTimeout(() => resolve({ role, error: { name: "HarnessTimeout", message: "worker did not answer" } }), 20000);
      });

    const [kernel, client] = await Promise.all([run("kernel"), run("client")]);
    return { kernel, client, isolated: crossOriginIsolated, hasSharedArrayBuffer: typeof SharedArrayBuffer };
  }, WORKER_SOURCE);

  expect(outcome.hasSharedArrayBuffer).toBe("function");
  expect(outcome.isolated).toBe(true);

  const client = outcome.client as unknown as WorkerOutcome;
  expect(client.error).toBeUndefined();
  expect(client.value).toEqual({ doubled: 42, handledAt: expect.any(Number) });

  // The kernel held for 60 ms. If the caller had not actually blocked, its own next line would have run in ~0 ms.
  const blockedFor = (client.afterCall ?? 0) - (client.beforeCall ?? 0);
  expect(blockedFor).toBeGreaterThanOrEqual(55);
});

test("a deadline ends the wait, and the channel is usable afterwards", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(async (source) => {
    const moduleUrl = new URL("/src/process/syscall-channel.ts", location.origin).href;
    const mod = await import(moduleUrl);
    const sizes = { requestBytes: 4096, responseBytes: 4096 };
    const allocation = mod.allocateChannel(sizes);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    const run = (role: string): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const worker = new Worker(url, { type: "module" });
        worker.onmessage = (event) => {
          resolve(event.data as Record<string, unknown>);
          worker.terminate();
        };
        worker.postMessage({ buffer: allocation.buffer, role, sizes, delayMs: 0, moduleUrl });
        setTimeout(() => resolve({ error: { name: "HarnessTimeout", message: "worker did not answer" } }), 20000);
      });

    const silent = run("silent-kernel");
    const timedOut = await run("client");
    await silent;

    // Same buffer, and now a kernel that really answers: a timeout must leave the channel usable rather than wedged in
    // "request pending", which is the failure mode that would take the whole kernel down later.
    const [kernel, recovered] = await Promise.all([run("kernel"), run("client")]);
    return { timedOut, recovered, kernel };
  }, WORKER_SOURCE);

  const timedOut = outcome.timedOut as unknown as WorkerOutcome;
  expect(timedOut.error?.name).toBe("SyscallTimeoutError");
  expect(timedOut.error?.message).toContain("800 ms");

  const recovered = outcome.recovered as unknown as WorkerOutcome;
  expect(recovered.error).toBeUndefined();
  expect(recovered.value).toEqual({ doubled: 42, handledAt: expect.any(Number) });
});
