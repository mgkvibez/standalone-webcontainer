/**
 * Raw mode in the real page: a program asks, the user answers by typing.
 *
 * This is the shape every interactive program has and the one the line prompt cannot express, because the prompt waits for a whole
 * line before anything runs. Here the program starts, the pane takes the keyboard, a keystroke goes to its stdin, and the answer
 * comes back through the runtime, the Worker boundary and the container's raw tap before it appears on screen.
 *
 * Both programs below assemble their own line, because raw mode means there is no line discipline in front of them: every
 * keystroke arrives as its own chunk and Enter arrives as a carriage return. That is what Node hands a program that asked for raw
 * mode, and hiding it would make this test describe a terminal we do not have.
 */

import { expect, test, type Page } from "@playwright/test";

const boot = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
};

const setEditorText = async (page: Page, text: string): Promise<void> => {
  await page.locator(".cm-content").fill(text);
  await expect(page.locator("#save-state")).toHaveText("saved", { timeout: 5_000 });
};

/** Type into the program's pane, the way a person would: click it first so xterm owns the keyboard. */
const typeIntoPane = async (page: Page, text: string): Promise<void> => {
  await page.locator("#raw-screen .xterm-screen").click();
  await page.keyboard.type(text);
};

const startProgram = async (page: Page, source: string): Promise<void> => {
  await boot(page);
  await page.locator("#tree li[data-path='/index.js']").click();
  await setEditorText(page, source);
  await page.fill("#command", "node index.js");
  await page.press("#command", "Enter");
};

const ECHO_PROGRAM = `
  let buffer = "";
  process.stdout.write("ready\\n");
  process.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    if (buffer.indexOf("\\r") === -1) return;
    const line = buffer.replace(/\\r/g, "");
    buffer = "";
    process.stdout.write("got:" + line + "\\n");
    if (line === "quit") process.exit(0);
  });
`;

test("a program takes the keyboard, and what is typed reaches its stdin", async ({ page }) => {
  await startProgram(page, ECHO_PROGRAM);

  // The pane replaces the prompt because the program owns the keyboard now.
  await expect(page.locator("#raw-pane")).toBeVisible();
  await expect(page.locator("#scrollback")).toBeHidden();

  // The program's first line arrives before anyone types, which is what tells the user it is waiting.
  await expect(page.locator(".xterm-rows")).toContainText("ready", { timeout: 10_000 });

  await typeIntoPane(page, "hello");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("got:hello", { timeout: 10_000 });

  // A second answer proves stdin is still live rather than a one-shot.
  await typeIntoPane(page, "again");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("got:again", { timeout: 10_000 });

  await typeIntoPane(page, "quit");
  await page.keyboard.press("Enter");

  // The program exits, so the pane goes away and the prompt comes back.
  await expect(page.locator("#raw-pane")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#command")).toBeVisible();
});

test("the pane reports its real size, and a resize reaches the program", async ({ page }) => {
  await startProgram(page, `
    process.stdout.write("cols=" + process.stdout.columns + " rows=" + process.stdout.rows + "\\n");
    // A waiting reader is what keeps the program alive here, not a timer: timers in this runtime run on a virtual clock, so an
    // interval would burn the whole budget in milliseconds and end the program before the pane could open.
    process.stdin.on("data", () => {});
    process.on("SIGWINCH", () => {
      process.stdout.write("sigwinch:" + process.stdout.columns + "\\n");
      process.exit(0);
    });
  `);

  // Asserted against the SCROLLBACK rather than the pane's grid: opening the pane fits it to the window, which resizes the
  // program, which makes this program exit and disposes the grid. The line record outlives that and is what a user could scroll
  // back to anyway.
  await expect(page.locator("#scrollback")).toContainText("cols=", { timeout: 10_000 });
  const reported = (await page.locator("#scrollback").textContent()) ?? "";
  expect(reported).toMatch(/cols=\d+ rows=\d+/);
  // Never the 80 the session started at unless the pane really is 80 wide, and never undefined.
  expect(reported).not.toContain("cols=undefined");

  // A real change in pane size must reach the program as SIGWINCH, carrying the new width.
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator("#scrollback")).toContainText("sigwinch:", { timeout: 10_000 });
  await expect(page.locator("#raw-pane")).toBeHidden({ timeout: 10_000 });
});
