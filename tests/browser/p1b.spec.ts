/**
 * P1b: the assembled environment.
 *
 * These drive the real page: real CodeMirror, real terminal input, real Worker, real runtime. Nothing here is a component
 * test in a fake DOM, because the thing being claimed is that the pieces are actually connected.
 *
 * Selectors are the UI's own data attributes, so a visible label change does not break the suite while a behavioural
 * change does.
 */

import { expect, test, type Page } from "@playwright/test";

const boot = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
};

const runLine = async (page: Page, line: string): Promise<void> => {
  await page.fill("#command", line);
  await page.press("#command", "Enter");
};

/** Replace the open file's contents through the editor, the way a person would. */
const setEditorText = async (page: Page, text: string): Promise<void> => {
  await page.locator(".cm-content").fill(text);
  // The save is debounced; the status line is the observable signal that it landed.
  await expect(page.locator("#save-state")).toHaveText("saved", { timeout: 5_000 });
};

/** Resolve `false` if the main thread cannot answer within the budget: a frozen page must fail this, not hang. */
const mainThreadResponds = async (page: Page): Promise<boolean> =>
  Promise.race([
    page.evaluate(() => document.querySelectorAll("#tree li").length >= 0),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);

const openFile = async (page: Page, path: string): Promise<void> => {
  await page.locator(`#tree li[data-path="${path}"]`).click();
  await expect(page.locator("#open-file")).toHaveText(path);
};

const acceptDialog = (page: Page, value: string): void => {
  page.once("dialog", (dialog) => void dialog.accept(value));
};

test("workspace loads with explorer, editor, terminal and process area", async ({ page }) => {
  await boot(page);
  await expect(page.locator("#project-select")).toHaveValue("project-1");
  await expect(page.locator("#tree li[data-kind='file']")).toHaveCount(2);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator("#scrollback")).toBeVisible();
  await expect(page.locator("#command")).toBeVisible();
  await expect(page.locator("#process-summary")).toHaveText("no processes");
  await expect(page.locator("#save-state")).toHaveText("saved");
});

test("creates a project and switches between projects", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "second");
  await page.click("#new-project");
  await expect(page.locator("#project-name")).toHaveText("second");
  await expect(page.locator("#project-select option")).toHaveCount(2);

  // The new project starts with its own starter file, not the first project's files.
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
  await expect(page.locator("#tree li[data-path='/package.json']")).toHaveCount(0);

  await page.selectOption("#project-select", "project-1");
  await expect(page.locator("#project-name")).toHaveText("playground");
  await expect(page.locator("#tree li[data-path='/package.json']")).toBeVisible();
});

test("creates directories and files, and edits them in the editor", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/src");
  await page.click("#new-dir");
  await expect(page.locator("#tree li[data-path='/src'][data-kind='dir']")).toBeVisible();

  acceptDialog(page, "/src/util.js");
  await page.click("#new-file");
  await expect(page.locator("#tree li[data-path='/src/util.js']")).toBeVisible();
  await expect(page.locator("#open-file")).toHaveText("/src/util.js");

  await setEditorText(page, "exports.answer = 42;\n");
  await expect(page.locator(".cm-content")).toContainText("answer = 42");
});

test("persists files across a reload", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/notes.txt");
  await page.click("#new-file");
  await setEditorText(page, "persisted through a reload\n");

  await page.reload();
  await expect(page.locator("#tree li[data-path='/notes.txt']")).toBeVisible();
  await openFile(page, "/notes.txt");
  await expect(page.locator(".cm-content")).toContainText("persisted through a reload");
});

test("runs a file through the runtime from the terminal and shows its output", async ({ page }) => {
  await boot(page);
  await runLine(page, "node index.js");

  await expect(page.locator("#scrollback")).toContainText("read back: written by the runtime");
  await expect(page.locator("#scrollback")).toContainText("tick 2");
  await expect(page.locator("#scrollback")).toContainText("[1] exited with code 0");
  await expect(page.locator(".process-chip[data-pid='1']")).toHaveAttribute("data-state", "exited");
});

test("installs only bundled corpus packages and rebuilds the volatile overlay from the lockfile", async ({ page }) => {
  await boot(page);
  await openFile(page, "/package.json");
  await setEditorText(page, JSON.stringify({ name: "playground", version: "1.0.0", dependencies: { "@corpus/leaf": "^1.0.0" } }, null, 2));
  await runLine(page, "npm install");
  await expect(page.locator("#scrollback")).toContainText("added 1 package(s) from the offline corpus");
  await expect(page.locator("#tree li[data-path='/package-lock.json']")).toBeVisible();

  await openFile(page, "/index.js");
  await setEditorText(page, 'console.log(require("@corpus/leaf").version);\n');
  await runLine(page, "node index.js");
  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toHaveText("1.0.0");

  await page.reload();
  await boot(page);
  await runLine(page, "npm ci");
  await expect(page.locator("#scrollback")).toContainText("added 1 package(s) from the offline corpus");
  await runLine(page, "node index.js");
  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toHaveText("1.0.0");
});

test("keeps a server alive in the project supervisor and serves over a transferable MessagePort", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/server.js");
  await page.click("#new-file");
  await setEditorText(page, [
    'const http = require("http");',
    'http.createServer((request, response) => response.end("supervised:" + request.url)).listen(3210);',
    'console.log("server booted");',
  ].join("\n"));

  await runLine(page, "node server.js");
  const server = page.locator(".process-chip[data-pid='1']");
  await expect(server).toHaveAttribute("data-state", "running");
  await expect(page.locator("#scrollback")).toContainText("server listening on port(s) 3210");

  const reply = await page.evaluate(async () => {
    const runtime = (window as unknown as { __runtime: { connectTransport(port: MessagePort): number; disconnectTransport(id: number): void } }).__runtime;
    const channel = new MessageChannel();
    // A streamed response arrives as several messages, so the answer is the terminal one: `response` (or `error`). Collecting until then
    // is what a real consumer does, and the chunks it accumulated are part of the assertion rather than swallowed.
    const received = new Promise<{ type: string; statusCode?: number; body?: string }>((resolve) => {
      let streamed = "";
      channel.port2.onmessage = (event: MessageEvent<{ type: string; statusCode?: number; body?: Uint8Array; streamed?: boolean }>) => {
        if (event.data.type === "chunk") {
          if (event.data.body !== undefined) streamed += new TextDecoder().decode(event.data.body);
          return;
        }
        if (event.data.type !== "response" && event.data.type !== "error") return;
        const whole = event.data.body === undefined ? "" : new TextDecoder().decode(event.data.body);
        resolve({
          type: event.data.type,
          ...(event.data.statusCode === undefined ? {} : { statusCode: event.data.statusCode }),
          ...(event.data.streamed === true ? { streamed: true } : {}),
          ...((whole + streamed) === "" ? {} : { body: whole + streamed }),
        });
      };
      channel.port2.start();
    });
    const transportId = runtime.connectTransport(channel.port1);
    channel.port2.postMessage({
      type: "request",
      id: "browser-smoke-1",
      method: "GET",
      url: "/preview/3210/hello?from=port",
      headers: {},
      body: new Uint8Array(),
    });
    const reply = await received;
    runtime.disconnectTransport(transportId);
    return reply;
  });
  expect(reply).toEqual({ type: "response", statusCode: 200, streamed: true, body: "supervised:/hello?from=port" });

  await server.locator("button[data-action='stop']").click();
  await expect(server).toHaveAttribute("data-state", "killed");
  await runLine(page, "node index.js");
  await expect(page.locator("#scrollback")).toContainText("read back: written by the runtime");
});

test("serves a running project through its origin-separated preview shell", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/server.js");
  await page.click("#new-file");
  await setEditorText(page, [
    'const http = require("http");',
    'http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<main>isolated preview works</main>"); }).listen(3211);',
  ].join("\n"));
  await runLine(page, "node server.js");
  const server = page.locator(".process-chip[data-pid='1']");
  await expect(server).toHaveAttribute("data-state", "running");

  await server.getByRole("button", { name: "preview 3211" }).click();
  await expect(page.locator("#preview-frame")).toHaveAttribute("src", /\.preview\.localhost:\d+\//);
  await expect(page.frameLocator("#preview-frame").locator("#preview-status")).toContainText("Preview server on port 3211");
  const content = page.frameLocator("#preview-frame").frameLocator("iframe[title='Project preview on port 3211']");
  await expect(content.locator("body")).toContainText("isolated preview works", { timeout: 15_000 });

  const origins = await page.evaluate(() => {
    const preview = document.querySelector<HTMLIFrameElement>("#preview-frame");
    return { host: location.origin, preview: preview?.src === undefined ? "" : new URL(preview.src).origin };
  });
  expect(origins.preview).not.toBe(origins.host);

  const previewDocument = page.frames().find((frame) => frame.url().includes("/preview/3211/"));
  expect(previewDocument).toBeDefined();
  await previewDocument!.evaluate(async () => {
    await Promise.all((await navigator.serviceWorker.getRegistrations()).map((registration) => registration.unregister()));
  });
  await page.click("#close-preview");
  await server.locator("button[data-action='stop']").click();
  await expect(server).toHaveAttribute("data-state", "killed");
});

test("keeps stdout and stderr in separate streams", async ({ page }) => {
  await boot(page);
  await openFile(page, "/index.js");
  await setEditorText(page, 'console.log("on stdout");\nconsole.error("on stderr");\n');
  await runLine(page, "node index.js");

  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toHaveText("on stdout");
  await expect(page.locator("#scrollback .line[data-stream='stderr']").last()).toHaveText("on stderr");
});

test("reports the real exit code of a process", async ({ page }) => {
  await boot(page);
  await openFile(page, "/index.js");
  await setEditorText(page, "process.exit(7);\n");
  await runLine(page, "node index.js");

  await expect(page.locator("#scrollback")).toContainText("[1] exited with code 7");
  await expect(page.locator(".process-chip[data-pid='1']")).toHaveAttribute("data-state", "exited");
});

test("terminates a non-yielding process and stays responsive", async ({ page }) => {
  await boot(page);
  await openFile(page, "/index.js");
  await setEditorText(page, "while (true) {}\n");
  await runLine(page, "node index.js");

  const chip = page.locator(".process-chip[data-pid='1']");
  await expect(chip).toHaveAttribute("data-state", "running", { timeout: 5_000 });

  // The page is not frozen while the Worker is stuck: a DOM read still answers.
  expect(await mainThreadResponds(page)).toBe(true);

  await chip.locator("button[data-action='stop']").click();
  await expect(chip).toHaveAttribute("data-state", "killed");
  await expect(page.locator("#scrollback")).toContainText("[1] terminated");
});

test("runs a fresh process after a termination", async ({ page }) => {
  await boot(page);
  await openFile(page, "/index.js");
  await setEditorText(page, "while (true) {}\n");
  await runLine(page, "node index.js");
  await expect(page.locator(".process-chip[data-pid='1']")).toHaveAttribute("data-state", "running", { timeout: 5_000 });
  await page.locator(".process-chip[data-pid='1'] button[data-action='stop']").click();
  await expect(page.locator(".process-chip[data-pid='1']")).toHaveAttribute("data-state", "killed");

  // Rewrite the file, then run again: the host is rebuilt and serves the new program.
  await openFile(page, "/index.js");
  await setEditorText(page, 'console.log("second attempt");\n');
  await runLine(page, "node index.js");

  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toHaveText("second attempt");
  await expect(page.locator(".process-chip[data-pid='2']")).toHaveAttribute("data-state", "exited");
});

test("manages two sessions without cross-contamination", async ({ page }) => {
  await boot(page);
  await page.click("#new-session");
  await expect(page.locator(".session-tab")).toHaveCount(2);

  // Second session moves to /src; the first stays at the root.
  acceptDialog(page, "/src");
  await page.click("#new-dir");
  await runLine(page, "cd /src");
  await runLine(page, "pwd");
  await expect(page.locator("#prompt-label")).toHaveText("/src $");

  await page.locator(".session-tab").first().click();
  await expect(page.locator("#prompt-label")).toHaveText("/ $");
  await runLine(page, "pwd");
  await expect(page.locator("#scrollback")).toContainText("/");

  // Output of one session is not in the other's scrollback.
  await page.locator(".session-tab").nth(1).click();
  await expect(page.locator("#scrollback")).toContainText("pwd");
  await page.locator(".session-tab").first().click();
  await expect(page.locator("#scrollback")).not.toContainText("node");
});

test("keeps project filesystems separate", async ({ page }) => {
  await boot(page);

  // Project 1 gets a file that project 2 must never see.
  acceptDialog(page, "/only-in-playground.txt");
  await page.click("#new-file");

  acceptDialog(page, "other");
  await page.click("#new-project");
  await expect(page.locator("#project-name")).toHaveText("other");
  await expect(page.locator("#tree li[data-path='/only-in-playground.txt']")).toHaveCount(0);

  await runLine(page, "ls");
  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).not.toContainText("only-in-playground");

  await page.selectOption("#project-select", "project-1");
  await expect(page.locator("#tree li[data-path='/only-in-playground.txt']")).toBeVisible();
  await runLine(page, "ls");
  await expect(page.locator("#scrollback .line[data-stream='stdout']").last()).toContainText("only-in-playground.txt");
});

test("installs from the offline corpus and refuses commands outside the finite command set", async ({ page }) => {
  await boot(page);
  await runLine(page, "npm install");
  await expect(page.locator("#scrollback")).toContainText("added 0 package(s) from the offline corpus");

  await runLine(page, "cargo build");
  await expect(page.locator("#scrollback")).toContainText("cargo: not a supported command");

  await runLine(page, "help");
  await expect(page.locator("#scrollback")).toContainText("Supported commands");
  // An install or refused command must not fabricate a runtime process.
  await expect(page.locator(".process-chip")).toHaveCount(0);
});

test("terminal file commands operate on the project the explorer shows", async ({ page }) => {
  await boot(page);
  await runLine(page, "mkdir /lib");
  await runLine(page, "touch /lib/helper.js");
  await runLine(page, "ls /lib");

  await expect(page.locator("#tree li[data-path='/lib'][data-kind='dir']")).toBeVisible();
  await expect(page.locator("#tree li[data-path='/lib/helper.js']")).toBeVisible();
  await expect(page.locator("#scrollback")).toContainText("helper.js");
});

/**
 * The terminal facts cross two boundaries: the page describes the size, the Worker builds the terminal, the program reads it.
 *
 * This is the cheapest honest proof of that path. The page's prompt is line-based, so raw keystrokes into a program need the UI's
 * raw mode (still to come); but the size, the isTTY flags and require("tty") all have to arrive correctly for any interactive
 * program to work at all, and a mistake in the wire protocol shows up here as `undefined` rather than as 80.
 */
test("a program run from the terminal sees the session's terminal size", async ({ page }) => {
  await boot(page);
  await openFile(page, "/index.js");
  await setEditorText(page, `
    const tty = require("tty");
    console.log("cols=" + process.stdout.columns + " rows=" + process.stdout.rows);
    console.log("isTTY=" + process.stdout.isTTY + " isatty=" + tty.isatty(1));
    console.log("stdin=" + (process.stdin === null ? "null" : "stream"));
  `);

  await runLine(page, "node index.js");

  // 80x24 is the session default, and it has to survive the page → Worker → runtime → shim path to appear here.
  await expect(page.locator("#scrollback")).toContainText("cols=80 rows=24");
  await expect(page.locator("#scrollback")).toContainText("isTTY=true isatty=true");
  await expect(page.locator("#scrollback")).toContainText("stdin=stream");
});
