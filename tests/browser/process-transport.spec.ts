/**
 * A preview request answered by a server inside a process Worker.
 *
 * This is the seam the audit said was missing, tested end to end and for real: the kernel owns the filesystem, `ProcessHost` spawns
 * a real `process-worker.ts` per process, the program inside that Worker calls `listen(3200)`, and the request arrives at the KERNEL
 * (which is where a preview request lands) and comes back answered. No fixture Worker is standing in for a process, and the server
 * object is the one the program created.
 *
 * Why this needs its own lane rather than a unit test: every part of the path is asynchronous in a different way. The syscall channel
 * is a shared buffer with `Atomics.waitAsync`; the transport is a `MessagePort`; the runtime schedules on a virtual clock; and the
 * kernel's serve loop is a task that must survive an idle gap. A unit test with a fake port proves the routing table and nothing about
 * whether those mechanisms compose.
 *
 * The three claims below are the ones the product depends on:
 *   1. a request reaches the process that owns the port, and its handler runs;
 *   2. a listening process stays alive after its program body returns, and a SECOND command still runs to completion while it idles;
 *   3. killing that process takes its ports with it, so the next request says "nothing is listening" instead of timing out.
 */

import { expect, test } from "@playwright/test";

/** The program a process runs. A server, a print line, and nothing else: the point is the process model, not HTTP. */
const SERVER = `
const http = require("http");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end("served " + req.url + " on pid " + process.pid);
});
server.listen(3200, () => console.log("listening on 3200"));
`;

/** Fixed CPU work with no clock and no I/O, so "finished" means the same thing the second time. */
const WORKER_PROGRAM = `
let total = 0;
for (let i = 0; i < 40000000; i += 1) total += Math.sqrt(i);
console.log("work finished", total > 0);
`;

test("a preview request reaches a server inside a process Worker, and the kernel survives its idle gaps", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ server, worker }) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      const output: Record<number, string> = {};
      const kernel = new ProcessKernel({
        files: { "/server.js": server, "/work.js": worker },
        // Shorter than the product's 30s on purpose: a seam that silently stops answering must fail this test as a 504 in three
        // seconds, not as a Playwright timeout with no assertion message.
        transportTimeoutMs: 3_000,
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };

      const serverPid = kernel.start({ argv: ["node", "/server.js"] });
      const listening = await waitFor(() => kernel.ports().some((binding: { port: number }) => binding.port === 3200));

      const first = await kernel.transport({
        method: "GET",
        url: "/preview/3200/hello?x=1",
        headers: { accept: "text/plain" },
        body: new Uint8Array(),
      });

      // A SECOND command while the server sits idle: this is the coexistence the serialised supervisor could not offer.
      const workerPid = kernel.start({ argv: ["node", "/work.js"] });
      const finished = await waitFor(() => kernel.processes().some((entry: { pid: number; state: string }) => entry.pid === workerPid && entry.state === "exited"));

      // The server kept listening across the other command's whole run, so a second request still answers.
      const second = await kernel.transport({
        method: "GET",
        url: "/preview/3200/still-there",
        headers: {},
        body: new Uint8Array(),
      });

      const before = kernel.processes();
      const killed = kernel.kill(serverPid, "test kill");
      const after = kernel.processes();
      const afterKill = await kernel.transport({
        method: "GET",
        url: "/preview/3200/hello",
        headers: {},
        body: new Uint8Array(),
      });

      return {
        listening,
        first: { status: first.statusCode, body: new TextDecoder().decode(first.body) },
        second: { status: second.statusCode, body: new TextDecoder().decode(second.body) },
        finished,
        killed,
        before,
        after,
        afterKill: { status: afterKill.statusCode, body: new TextDecoder().decode(afterKill.body) },
        portsAfter: kernel.ports(),
        output,
        workerPid,
      };
    },
    { server: SERVER, worker: WORKER_PROGRAM },
  );

  // 1. The port was bound and reported, and the handler answered on the KERNEL's side of the boundary.
  expect(outcome.listening).toBe(true);
  expect(outcome.first.status).toBe(200);
  expect(outcome.first.body).toContain("served /hello?x=1 on pid");

  // 2. Coexistence: the other command ran to completion while the server idled, and the server still answered afterwards.
  expect(outcome.finished).toBe(true);
  expect(outcome.second.status).toBe(200);
  expect(outcome.second.body).toContain("/still-there");
  expect(Object.values(outcome.output).join("")).toContain("work finished");
  expect(Object.values(outcome.output).join("")).toContain("listening on 3200");

  // The listening process stayed ALIVE after its body returned: Node would not have exited either, and a terminated Worker cannot serve.
  const serverBefore = outcome.before.find((entry: { pid: number }) => entry.pid !== outcome.workerPid);
  expect(serverBefore?.state).toBe("running");
  expect(serverBefore?.ports).toEqual([3200]);
  // The worker process, by contrast, really did exit: the hold-open rule is about servers, not about being alive at all.
  const workerBefore = outcome.before.find((entry: { pid: number }) => entry.pid === outcome.workerPid);
  expect(workerBefore?.state).toBe("exited");

  // 3. Kill takes the ports with it, and the answer is immediate and specific rather than a timeout.
  expect(outcome.killed).toBe(true);
  expect(outcome.after.find((entry: { pid: number }) => entry.pid !== outcome.workerPid)?.state).toBe("killed");
  expect(outcome.portsAfter).toEqual([]);
  expect(outcome.afterKill.status).toBe(503);
  expect(outcome.afterKill.body).toContain("3200");
});
