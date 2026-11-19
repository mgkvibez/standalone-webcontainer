import { expect, test } from "@playwright/test";

/**
 * W-42: a program that closes its own Worker must not strand its process.
 *
 * Every case runs a real ProcessKernel and a real process Worker, because the defect lives on the boundary between them:
 * `close()` stops the Worker without sending a trusted message and without firing an error event, so the host has to be
 * told by the instrumentation inside the Worker. A unit test cannot prove that wiring exists.
 */
test.setTimeout(120_000);

interface RunOutcome {
  readonly reason?: string;
  readonly exitCode?: number | null;
  readonly killed?: boolean;
  readonly alive?: boolean;
}

async function startAndSettle(
  page: import("@playwright/test").Page,
  program: string,
): Promise<{ outcome: RunOutcome | null; timedOut: boolean; alive: boolean; stdout: string }> {
  return page.evaluate(
    async ({ program }: { program: string }) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      let stdout = "";
      const kernel = new ProcessKernel({
        files: { "/main.js": program },
        transportTimeoutMs: 3_000,
        maxProcesses: 1,
        onOutput: (_pid: number, _channel: string, text: string) => {
          stdout += text;
        },
      });
      try {
        const pid = kernel.start({ argv: ["node", "/main.js"], terminal: { columns: 80, rows: 24 } });
        let outcome: unknown = null;
        let timedOut = false;
        const settle = kernel.settled(pid).then((value: RunOutcome) => {
          outcome = value;
        });
        // A process that never settles is the defect, so the wait is bounded and reports itself rather than hanging the lane.
        await Promise.race([settle, new Promise((resolve) => setTimeout(resolve, 8_000))]);
        if (outcome === null) timedOut = true;
        return { outcome: outcome as never, timedOut, alive: kernel.isAlive(pid), stdout };
      } finally {
        kernel.dispose();
      }
    },
    { program },
  );
}

test("a program that closes its Worker is settled as failed, and its slot comes back", async ({ page }) => {
  await page.goto("/");

  const first = await startAndSettle(page, 'console.log("before-close");\nclose();\n');
  expect(first.timedOut, "the process never settled after close()").toBe(false);
  expect(first.stdout).toContain("before-close");
  expect(first.outcome?.reason).toContain("worker closed itself");
  expect(first.outcome?.alive).toBe(false);
  expect(first.alive, "the process is still counted as live after close()").toBe(false);

  // The slot is the part a caller feels: maxProcesses is 1 above, so a second start only succeeds if the first released it.
  const second = await startAndSettle(page, 'console.log("second-run");\n');
  expect(second.timedOut).toBe(false);
  expect(second.stdout).toContain("second-run");
  expect(second.outcome?.exitCode).toBe(0);
});

test("a held-open process that closes itself is retired rather than left serving", async ({ page }) => {
  await page.goto("/");

  const run = await startAndSettle(
    page,
    'require("http").createServer((request, response) => response.end("ok")).listen(3401);\nsetTimeout(() => { close(); }, 50);\n',
  );

  expect(run.timedOut, "the held-open process never settled after close()").toBe(false);
  // holdOpen keeps a process alive when it EXITS owning a port. A close is a fault, so the process must be retired: the
  // Worker that owns the listener is gone and the preview must stop pretending otherwise.
  expect(run.alive).toBe(false);
  expect(run.outcome?.reason).toContain("worker closed itself");
});

test("normal exit is unchanged, and the wrapper is in place before user code runs", async ({ page }) => {
  await page.goto("/");

  const run = await startAndSettle(page, 'console.log("meta:" + close.name + ":" + close.length);\n');
  expect(run.timedOut).toBe(false);
  expect(run.stdout).toContain("meta:close:0");
  expect(run.outcome?.exitCode).toBe(0);
  expect(run.outcome?.reason).toBeUndefined();
});
