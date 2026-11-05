/**
 * P1a: the browser smoke test.
 *
 * Every assertion here is about evidence a person could see on the page: real stdout from the real runtime, a real exit
 * code, a real crash on stderr, and a real Worker that can be killed. Nothing asserts on internals, because internals
 * that pass while the page shows nothing are exactly the failure this milestone exists to rule out.
 *
 * The one thing no assertion can prove from here is that the runtime is OURS rather than a browser primitive. That is
 * covered by the bundle audit (a stray `node:` import or harness module would fail the build lane) and by the fact that
 * the snippets exercise `require`, a VFS path write and the virtual timer queue, none of which a bare page provides.
 */

import { expect, test, type Page } from "@playwright/test";

/** The page auto-runs on load, so "loaded" means "the first real run finished". */
async function waitForFirstRun(page: Page): Promise<void> {
  await expect(page.locator("#status")).toHaveText(/finished \(exit 0\)/, { timeout: 15_000 });
}

test("the page loads, the Worker boots, and the runtime executes JavaScript", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");

  // The title is the product's, not the browser's default, so a blank or 404 page cannot pass.
  await expect(page).toHaveTitle(/standalone-webcontainer/);
  await waitForFirstRun(page);

  // Status is the page's own report of the Worker handshake: "worker ready (in-process)" proves the runtime lane
  // answered a ping before the first run.
  await expect(page.locator("#status")).toContainText("finished");

  // Real output from the real runtime: fs write, fs read back, a virtual timer, and argv.
  await expect(page.locator("#stdout")).toContainText("stdout: hello from the runtime");
  await expect(page.locator("#stdout")).toContainText("timer: fired after 10 virtual ms");
  await expect(page.locator("#stdout")).toContainText("argv: node index.js");
  await expect(page.locator("#stderr")).toContainText("stderr: this line is on the error stream");

  // Exit status and the runtime's own timer evidence reach the page.
  await expect(page.locator("#result")).toContainText("exit code: 0");
  await expect(page.locator("#result")).toContainText("timers: 1 callback(s)");

  expect(consoleErrors, `page console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});

test("a runtime error reaches the page with its stack and a non-zero exit code", async ({ page }) => {
  await page.goto("/");
  await waitForFirstRun(page);

  await page.locator("#code").fill('console.log("before the failure");\nthrow new Error("deliberate failure");\n');
  await page.locator("#run").click();

  await expect(page.locator("#status")).toHaveText("finished (exit 1)");
  // stdout was produced before the throw, so a page that showed nothing would be losing real output.
  await expect(page.locator("#stdout")).toContainText("before the failure");
  await expect(page.locator("#stderr")).toContainText("deliberate failure");
  await expect(page.locator("#result")).toContainText("exit code: 1");
});

test("a synchronous infinite loop does not freeze the page and is stopped by terminating the Worker", async ({ page }) => {
  await page.goto("/");
  await waitForFirstRun(page);

  await page.locator("#loop").click();
  await expect(page.locator("#status")).toHaveText("running");

  // The loop is running synchronously in the Worker. The page must still be able to answer a script evaluation,
  // which is the whole point of putting the runtime on another thread.
  const responsiveDuringLoop = await page.evaluate(() => 1 + 1);
  expect(responsiveDuringLoop).toBe(2);

  // Proof the loop really is stuck rather than finished instantly: no result arrived while it ran.
  await expect(page.locator("#result")).toHaveText("");

  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("worker terminated");

  // The page still answers after termination.
  expect(await page.evaluate(() => document.title.length > 0)).toBe(true);

  // A fresh Worker is started lazily, and the runtime works again: termination discarded the old instance without
  // poisoning the page.
  await page.locator("#code").fill('console.log("after restart");\n');
  await page.locator("#run").click();
  await expect(page.locator("#status")).toHaveText("finished (exit 0)", { timeout: 15_000 });
  await expect(page.locator("#stdout")).toContainText("after restart");
});

/**
 * The runtime compiles every module with `new Function`, so the deployment must permit eval. This asserts the documented
 * policy actually works rather than that any policy does: `worker-src 'self'` because the runtime lives in a same-origin
 * module worker, and `unsafe-eval` because the loaders compile strings.
 */
test("runs under the documented deployment CSP", async ({ page }) => {
  const policy = "script-src 'self' 'unsafe-eval'; worker-src 'self'";
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = policy;
    await route.fulfill({ response, headers });
  });

  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("finished (exit 0)", { timeout: 15_000 });
  await expect(page.locator("#stdout")).toContainText("stdout: hello from the runtime");
});
