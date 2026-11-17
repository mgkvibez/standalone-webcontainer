/**
 * W-41 on the production seam.
 *
 * A held-open process has already handed back its result, so nothing is left to return an error to: the
 * resident pump that keeps it alive is the only thing running. The unit tests pin the bookkeeping against a
 * faked Worker and the runtime tests pin the record; neither proves the sentence this file exists for - that
 * the real `process-worker.ts` adapter turns that record into the `failed` message that makes ProcessHost stop
 * describing a crashed server as healthy.
 *
 * No message is injected and no Worker is faked: a real kernel serves the filesystem, a real `process-worker.ts`
 * runs the program, and the throw is caused by the program reacting to a real request.
 *
 * The throw must land AFTER the run returned. With W-40 (ADR-0035) an uncaught exception during the run's own
 * drain now ends the run with status 1, which is why the failing timer is scheduled from a request handler
 * rather than at startup: a startup timer throws in-run and never reaches this window.
 */

import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

/** Held open by its own server; a request that says "boom" schedules the throw for after the run has returned. */
const SERVER = [
  'const http = require("http");',
  "const server = http.createServer((req, res) => {",
  '  if (req.url.includes("boom")) {',
  '    setTimeout(() => { throw new Error("boom after settle"); }, 0);',
  '    res.end("scheduled");',
  "    return;",
  "  }",
  '  res.end("ok");',
  "});",
  'server.listen(3200, () => console.log("listening on 3200"));',
].join("\n");

/** Throws during its own turn: the control that must keep behaving as it does today. */
const THROWS_IN_RUN = 'setTimeout(() => { throw new Error("boom during run"); }, 0);';

test("a held-open process that throws after its run ends becomes failed, and stops answering", async ({ page }) => {
  await page.goto("/");

  const outcome = await page.evaluate(
    async ({ server, throwsInRun }) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      const output: Record<number, string> = {};
      const kernel = new ProcessKernel({
        files: { "/server.js": server, "/throws.js": throwsInRun },
        // Three seconds, so a seam that stops answering fails as a 504 with a message instead of a bare timeout.
        transportTimeoutMs: 3_000,
        onOutput: (pid: number, _channel: string, text: string) => {
          output[pid] = (output[pid] ?? "") + text;
        },
      });

      const stateOf = (pid: number): string =>
        (kernel.processes() as readonly { pid: number; state: string }[]).find((entry) => entry.pid === pid)?.state ??
        "absent";
      const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };

      const request = (path: string) =>
        kernel.transport({
          method: "GET",
          url: `/preview/3200${path}`,
          headers: { accept: "text/plain" },
          body: new Uint8Array(),
        });

      const serverPid = kernel.start({ argv: ["node", "/server.js"] });
      const listening = await waitFor(() =>
        (kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3200),
      );

      // The run is over and the process is still live: this is the held-open window, and it answers a request.
      const before = await request("/hello");
      const stateBeforeThrow = stateOf(serverPid);
      const liveBeforeThrow = (kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3200);

      // The request asks the program to schedule a throw for after its own turn. That callback runs in the pump.
      await request("/boom").catch((error: Error) => ({ error: String(error.message) }));
      const failed = await waitFor(() => stateOf(serverPid) === "failed");

      const portsAfter = (kernel.ports() as readonly { port: number }[]).filter((binding) => binding.port === 3200);
      const stateAfter = stateOf(serverPid);
      const survivors = (kernel.processes() as readonly { state: string }[]).filter((entry) => entry.state === "failed");

      // A crash must not leave the port routable: a later request is refused, never answered by a dead program.
      const after = await request("/still-there").then(
        (reply: { statusCode: number; body?: Uint8Array }) => ({
          status: reply.statusCode,
          answered: true,
          body: new TextDecoder().decode(reply.body ?? new Uint8Array()),
        }),
        (error: Error) => ({ status: -1, answered: false, body: "", reason: String(error.message) }),
      );

      // Control: a program that throws during its own turn still exits 1 and is not reported as a late failure.
      const throwerPid = kernel.start({ argv: ["node", "/throws.js"] });
      await waitFor(() => ["exited", "failed", "killed"].includes(stateOf(throwerPid)));
      const throwerState = stateOf(throwerPid);

      return {
        listening,
        stateBeforeThrow,
        liveBeforeThrow,
        servedBefore: new TextDecoder().decode(before.body ?? new Uint8Array()),
        failed,
        stateAfter,
        portsAfterThrow: portsAfter.length,
        failedRows: survivors.length,
        after,
        stderr: output[serverPid] ?? "",
        throwerState,
      };
    },
    { server: SERVER, throwsInRun: THROWS_IN_RUN },
  );

  // 1-3. The program ran, settled, and stayed alive on its port.
  expect(outcome.listening).toBe(true);
  expect(outcome.stateBeforeThrow).toBe("running");
  expect(outcome.liveBeforeThrow).toBe(true);
  expect(outcome.servedBefore).toBe("ok");

  // 4-6. The callback threw after the run had returned, and the adapter carried it to the table as a failure.
  expect(outcome.failed, JSON.stringify(outcome)).toBe(true);
  expect(outcome.stateAfter).toBe("failed");
  expect(outcome.failedRows).toBe(1);
  expect(outcome.stderr).toContain("Uncaught Error: boom after settle");

  // 7-8. The Worker is retired with the row, so the port is gone and a later request cannot be routed to it.
  expect(outcome.portsAfterThrow).toBe(0);
  // The port is unregistered, so the transport refuses instead of serving: the status must say so, and the body
  // must not be the program's answer. "Answered with a refusal" is not "routed to a dead server".
  expect(outcome.after.status).toBeGreaterThanOrEqual(400);
  expect(outcome.after.body).not.toContain("ok");
  expect(outcome.after.body + (outcome.after.reason ?? "")).toMatch(/not listening|nothing|503|No process/i);

  // The control: an in-run throw is still a plain exit 1, and it is a different state.
  expect(outcome.throwerState).toBe("exited");
});
