/**
 * P1a's promises, kept true inside the P1b workspace.
 *
 * P1a shipped a bare page with Run/Terminate buttons. P1b replaces that page with the real environment, so these tests were
 * ported rather than dropped: the assertions are the same promises (the Worker executes our runtime, errors surface, a hung
 * script cannot freeze the page, termination works, the documented CSP is enough), driven through the interface that now
 * exists. Nothing was weakened; the "infinite loop" button became an infinite-loop file.
 */

import { expect, test, type Page } from "@playwright/test";

const boot = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
};

const replaceFile = async (page: Page, text: string): Promise<void> => {
  await page.locator("#tree li[data-path='/index.js']").click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await expect(page.locator("#save-state")).toHaveText("saved", { timeout: 5_000 });
};

/** Resolve `false` if the main thread cannot answer within the budget: a frozen page must fail this, not hang. */
const mainThreadResponds = async (page: Page): Promise<boolean> =>
  Promise.race([
    page.evaluate(() => document.querySelectorAll("#tree li").length >= 0),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);

const runLine = async (page: Page, line: string): Promise<void> => {
  await page.fill("#command", line);
  await page.press("#command", "Enter");
};

test("the page loads, the Worker boots, and the runtime executes JavaScript", async ({ page }) => {
  await boot(page);
  await runLine(page, "node index.js");

  await expect(page.locator("#scrollback")).toContainText("read back: written by the runtime");
  await expect(page.locator("#scrollback")).toContainText("[1] exited with code 0");
});

test("a runtime error reaches the page with its stack and a non-zero exit code", async ({ page }) => {
  await boot(page);
  await replaceFile(page, 'throw new Error("boom from the runtime");\n');
  await runLine(page, "node index.js");

  // The thrown error arrives as a stack: the first stderr line is the message, later lines are frames.
  await expect(page.locator("#scrollback .line[data-stream='stderr']").first()).toContainText("boom from the runtime");
  await expect(page.locator("#scrollback .line[data-stream='stderr']")).not.toHaveCount(0);
  await expect(page.locator("#scrollback")).toContainText("exited with code 1");
});

test("a synchronous infinite loop does not freeze the page and is stopped by terminating the Worker", async ({ page }) => {
  await boot(page);
  await replaceFile(page, "while (true) {}\n");
  await runLine(page, "node index.js");

  const chip = page.locator(".process-chip[data-pid='1']");
  await expect(chip).toHaveAttribute("data-state", "running", { timeout: 5_000 });

  // The main thread answers while the Worker is stuck in a loop it cannot yield from.
  expect(await mainThreadResponds(page)).toBe(true);

  await chip.locator("button[data-action='stop']").click();
  await expect(chip).toHaveAttribute("data-state", "killed");

  // A fresh Worker serves the next command.
  await replaceFile(page, 'console.log("alive again");\n');
  await runLine(page, "node index.js");
  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toHaveText("alive again");
});

test("runs under the documented deployment CSP", async ({ page }) => {
  const policy = "script-src 'self' 'unsafe-eval'; worker-src 'self'";
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = policy;
    await route.fulfill({ response, headers });
  });

  await boot(page);
  await runLine(page, "node index.js");
  await expect(page.locator("#scrollback")).toContainText("read back: written by the runtime");
  await expect(page.locator("#scrollback")).toContainText("[1] exited with code 0");
});
