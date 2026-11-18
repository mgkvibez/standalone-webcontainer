/**
 * W-19 P2: the kernel believes the private control channel and nothing else.
 *
 * Each attack here was executed BEFORE the change and did reach the kernel: a forged `exit` settled the process with a status the
 * program chose while it was still running, a forged `output` entered the kernel's stdout stream, and a forged `ports` registered a
 * port with no server behind it. The same programs now have no effect, and the genuine reports still arrive.
 *
 * The forging program is the same one every time, so a regression is a regression in the boundary rather than in a test's program.
 */

import { expect, test } from "@playwright/test";

test.setTimeout(150_000);

/** Posts every trusted shape a program can guess, then does real work and exits 7. */
const FORGER = [
  "console.log('body-start');",
  "globalThis.postMessage({ type: 'output', channel: 'stdout', text: 'FORGED-OUTPUT' });",
  "globalThis.postMessage({ type: 'ports', ports: [{ protocol: 'http', port: 4321 }] });",
  "globalThis.postMessage({ type: 'scheduler', evidence: { forged: true } });",
  "globalThis.postMessage({ type: 'failed', reason: 'FORGED-FAILURE' });",
  "globalThis.postMessage({ type: 'exit', code: 0 });",
  "console.log('body-done');",
  "setTimeout(() => process.exit(7), 5);",
].join("\n");

const SERVER = [
  'const http = require("http");',
  "globalThis.onmessage = () => {};",
  'http.createServer((q, s) => s.end("served")).listen(3200);',
  "console.log('listening');",
].join("\n");

/** Forges a phantom port and an early exit on 3301's neighbour while serving on 3301 itself. */
const NEIGHBOUR_A = [
  'const http = require("http");',
  "globalThis.postMessage({ type: 'exit', code: 0 });",
  "globalThis.postMessage({ type: 'ports', ports: [{ protocol: 'http', port: 9999 }] });",
  'http.createServer((q, s) => s.end("A")).listen(3301);',
  "console.log('a-listening');",
].join("\n");

const NEIGHBOUR_B = [
  'const http = require("http");',
  "setTimeout(() => process.exit(5), 60);",
  'http.createServer((q, s) => s.end("B")).listen(3302);',
  "console.log('b-listening');",
].join("\n");

test("forged exit, failed, output, ports and scheduler messages do not reach the kernel", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async ({ program }) => {
    const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
    let stdout = "";
    const kernel = new ProcessKernel({
      files: { "/forge.js": program },
      transportTimeoutMs: 3_000,
      onOutput: (_pid: number, channel: string, text: string) => {
        stdout += `${channel}:${text}`;
      },
    });
    try {
      const pid = kernel.start({ argv: ["node", "/forge.js"] });
      const settled = await kernel.settled(pid);
      const row = (kernel.processes() as readonly { pid: number; state: string }[]).find((entry) => entry.pid === pid);
      return {
        stdout,
        exitCode: (settled as { exitCode?: number }).exitCode,
        state: row?.state ?? "absent",
        ports: (kernel.ports() as readonly { port: number }[]).map((binding) => binding.port),
      };
    } finally {
      kernel.dispose();
    }
  }, { program: FORGER });

  // The program ran to its own end: both markers are there, so a silent program cannot be mistaken for a protected one.
  expect(outcome.stdout).toContain("body-start");
  expect(outcome.stdout).toContain("body-done");
  // Not one forged byte reached the kernel's stream.
  expect(outcome.stdout).not.toContain("FORGED-OUTPUT");
  // The status is the program's own, not the 0 it asked for.
  expect(outcome.exitCode).toBe(7);
  expect(outcome.state).toBe("exited");
  // No phantom port, and no fabricated failure: a forged `failed` would have made the row `failed`.
  expect(outcome.ports).toEqual([]);
});

test("genuine exit and genuine failure are still delivered", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
    const kernel = new ProcessKernel({
      files: { "/exits.js": "process.exit(3);" },
      transportTimeoutMs: 3_000,
      onOutput: () => {},
    });
    try {
      const pid = kernel.start({ argv: ["node", "/exits.js"] });
      const settled = await kernel.settled(pid);
      // A program with no entry script is the adapter's OWN `failed` path, so this proves a genuine failure still crosses the
      // private channel (the forged `failed` above proved the ordinary one cannot).
      let noEntry: { state?: string; threw?: string } = {};
      try {
        const noEntryPid = kernel.start({ argv: ["node"] });
        await kernel.settled(noEntryPid).catch(() => null);
        noEntry = {
          state: (kernel.processes() as readonly { pid: number; state: string }[]).find((entry) => entry.pid === noEntryPid)?.state ?? "absent",
        };
      } catch (error) {
        noEntry = { threw: String((error as Error).message) };
      }
      return {
        exitCode: (settled as { exitCode?: number }).exitCode,
        missingState: noEntry.state ?? noEntry.threw ?? "absent",
      };
    } finally {
      kernel.dispose();
    }
  });

  expect(outcome.exitCode).toBe(3);
  expect(outcome.missingState).toBe("failed");
});

test("replacing globalThis.onmessage leaves the preview transport working", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async ({ program }) => {
    const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
    const kernel = new ProcessKernel({ files: { "/server.js": program }, transportTimeoutMs: 3_000, onOutput: () => {} });
    const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    try {
      const pid = kernel.start({ argv: ["node", "/server.js"] });
      const listening = await waitFor(() =>
        (kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3200),
      );
      const reply = await kernel.transport({
        method: "GET",
        url: "/preview/3200/x",
        headers: {},
        body: new Uint8Array(),
      });
      return { listening, status: reply.statusCode, body: new TextDecoder().decode(reply.body ?? new Uint8Array()), pid };
    } finally {
      kernel.stopServers([3200]);
      kernel.dispose();
    }
  }, { program: SERVER });

  expect(outcome.listening).toBe(true);
  expect(outcome.status).toBe(200);
  expect(outcome.body).toBe("served");
});

test("one process cannot settle another, nor register a port in its name", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async ({ a, b }) => {
    const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
    const kernel = new ProcessKernel({ files: { "/a.js": a, "/b.js": b }, transportTimeoutMs: 3_000, onOutput: () => {} });
    const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    try {
      const pidA = kernel.start({ argv: ["node", "/a.js"] });
      const pidB = kernel.start({ argv: ["node", "/b.js"] });
      await waitFor(() =>
        (kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3302),
      );
      const stateOf = (pid: number): string =>
        (kernel.processes() as readonly { pid: number; state: string }[]).find((entry) => entry.pid === pid)?.state ?? "absent";
      // B was serving while A forged: A's forgeries must not have touched B.
      const bReply = await kernel.transport({ method: "GET", url: "/preview/3302/b", headers: {}, body: new Uint8Array() });
      const stateBBefore = stateOf(pidB);
      const settledB = await kernel.settled(pidB).catch(() => null);
      return {
        stateBBefore,
        bStatus: bReply.statusCode,
        bBody: new TextDecoder().decode(bReply.body ?? new Uint8Array()),
        bExit: (settledB as { exitCode?: number } | null)?.exitCode ?? null,
        stateAAfter: stateOf(pidA),
        ports: (kernel.ports() as readonly { port: number }[]).map((binding) => binding.port),
      };
    } finally {
      kernel.stopServers([3301, 3302]);
      kernel.dispose();
    }
  }, { a: NEIGHBOUR_A, b: NEIGHBOUR_B });

  // B is a held-open server, so it serves and stays live until its own timer exits it with 5.
  expect(outcome.stateBBefore).toBe("running");
  expect(outcome.bStatus).toBe(200);
  expect(outcome.bBody).toBe("B");
  expect(outcome.bExit).toBe(5);
  // A forged a phantom 9999 and an early exit; neither landed, and A is still its own live server on 3301.
  expect(outcome.ports).not.toContain(9999);
  expect(outcome.ports).toContain(3301);
  expect(outcome.stateAAfter).toBe("running");
});

test("a Worker booted without the control port fails closed instead of running unsupervised", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const url = new URL("/src/process/process-worker.ts", location.origin).href;
    const worker = new Worker(url, { type: "module" });
    const error = await new Promise<string>((resolve) => {
      worker.onerror = (event: ErrorEvent) => resolve(String(event.message));
      setTimeout(() => resolve("no error and no report within 8s"), 8_000);
      // The shape a caller would send if it did not know the contract: a real channel and a real argv, no control port.
      worker.postMessage({
        type: "start",
        pid: 1,
        argv: ["node", "/main.js"],
        env: {},
        buffer: new SharedArrayBuffer(64 + 4096 + 4096),
        sizes: { requestBytes: 4096, responseBytes: 4096 },
      });
    });
    worker.terminate();
    return { error };
  });
  // Fails closed and says why: no program ran, and nothing was reported on the ordinary channel that the host would believe.
  expect(outcome.error).toContain("control port");
});
