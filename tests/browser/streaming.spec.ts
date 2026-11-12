/**
 * W-4, first half: a response that leaves the process before it ends.
 *
 * Two tests, because there are two claims and they fail for different reasons. The transport one is about the wire: does a chunk reach
 * the page as its own message, in write order, before the reply? The preview one is about the browser: does a real `fetch` inside the
 * preview see the first bytes while the handler is still holding the rest of the response, which is the difference between a live dev
 * server and a page that appears after the build.
 *
 * Neither test measures elapsed time, and that is deliberate: the runtime runs on a virtual clock (ADR-0013), so a `setTimeout` between
 * two writes costs zero milliseconds and a timing-based assertion would measure nothing. Instead the second half of the response is
 * released by a second request, so a buffered implementation has no first chunk to hand over and DEADLOCKS on its own deadline. Failing
 * by deadlock is worth more than failing by a stopwatch: it cannot pass by luck on a fast machine.
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

/**
 * Replace the open file's contents, and wait until the STORE actually holds them.
 *
 * Waiting for `#save-state` to read "saved" is a race dressed as a wait: the label says "saved" before the fill too, so the assertion
 * passes in the same millisecond the keystrokes land and the program can be run against a half-written or stale file. Reading the saved
 * text back is the only check that cannot pass early.
 */
const setEditorText = async (page: Page, text: string): Promise<void> => {
  await page.locator(".cm-content").fill(text);
  const path = await page.locator("#open-file").innerText();
  await expect.poll(async () => page.evaluate(
    (target) => (window as unknown as { __store: { active(): { files: Record<string, string> } } }).__store.active().files[target] ?? null,
    path.trim(),
  ), { timeout: 5_000 }).toBe(text);
};

const acceptDialog = (page: Page, value: string): void => {
  page.once("dialog", (dialog) => void dialog.accept(value));
};

/**
 * The handler both tests use, and why it looks like this.
 *
 * The obvious way to write a streaming server is `write("first")` then `setTimeout(() => end("second"), 800)`. That is useless here,
 * and not because of a bug: the runtime runs on a virtual clock (ADR-0013), so a program whose only remaining work is a pending timer
 * has its time advanced to that timer immediately. The 800ms costs nothing, both writes happen in the same millisecond, and a buffered
 * response is indistinguishable from a streamed one.
 *
 * So the second half of the response is released by a SECOND REQUEST. That makes the assertion about causality rather than about
 * elapsed time: the first chunk cannot appear before `/finish` is called, and a buffered implementation deadlocks instead of passing
 * slowly, which is a far better way to fail.
 */
const STREAMING_SERVER = [
  'const http = require("http");',
  "let pending = null;",
  "http.createServer((request, response) => {",
  '  if (request.url === "/stream") {',
  '    response.setHeader("content-type", "text/plain");',
  '    response.write("first");',
  "    pending = response;",
  "    return;",
  "  }",
  '  if (request.url === "/finish") {',
  '    response.end("released");',
  "    if (pending !== null) {",
  '      pending.end("second");',
  "      pending = null;",
  "    }",
  "    return;",
  "  }",
  '  response.setHeader("content-type", "text/html");',
  "  response.end(\"<main id=served>streaming preview</main>\");",
  "}).listen(3212);",
].join("\n");

test("delivers a streamed response to the page as ordered messages, not one buffered body", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/server.js");
  await page.click("#new-file");
  await setEditorText(page, STREAMING_SERVER);
  await runLine(page, "node server.js");
  await expect(page.locator(".process-chip[data-pid='1']")).toHaveAttribute("data-state", "running");
  await expect(page.locator("#scrollback")).toContainText("server listening on port(s) 3212");

  const transcript = await page.evaluate(async () => {
    const runtime = (window as unknown as {
      __runtime: { connectTransport(port: MessagePort): number; disconnectTransport(id: number): void };
    }).__runtime;
    const channel = new MessageChannel();
    const seen: { kind: string; detail: string }[] = [];
    const done = new Promise<void>((resolve) => {
      channel.port2.onmessage = (event: MessageEvent<{ type: string; id: string; statusCode?: number; body?: Uint8Array; headers?: Record<string, string>; streamed?: boolean }>) => {
        const message = event.data;
        // The release request streams its own reply on the same port, and its events are not what this test is about.
        if (message.id !== "stream-1") return;
        if (message.type === "start") {
          seen.push({ kind: "start", detail: String(message.statusCode) });
          return;
        }
        if (message.type === "chunk") {
          seen.push({ kind: "chunk", detail: new TextDecoder().decode(message.body) });
          // The handler is holding the rest of the response open. Nothing releases it but the second request, which is the point:
          // this transcript can only complete if the first chunk was already on its way while the first handler was still running.
          if (seen.filter((entry) => entry.kind === "chunk").length === 1) {
            channel.port2.postMessage({
              type: "request",
              id: "stream-2",
              method: "GET",
              url: "/preview/3212/finish",
              headers: {},
              body: new Uint8Array(),
            });
          }
          return;
        }
        if (message.type === "response") {
          seen.push({ kind: "response", detail: String(message.streamed === true) });
          resolve();
        }
      };
      channel.port2.start();
    });
    const transportId = runtime.connectTransport(channel.port1);
    channel.port2.postMessage({
      type: "request",
      id: "stream-1",
      method: "GET",
      url: "/preview/3212/stream",
      headers: {},
      body: new Uint8Array(),
    });
    await done;
    runtime.disconnectTransport(transportId);
    return seen;
  });

  // Headers, then the first chunk, then the second, then the reply that says the body already went.
  expect(transcript).toEqual([
    { kind: "start", detail: "200" },
    { kind: "chunk", detail: "first" },
    { kind: "chunk", detail: "second" },
    { kind: "response", detail: "true" },
  ]);
});

test("streams a preview response into a real fetch before the handler finishes", async ({ page }) => {
  await boot(page);
  acceptDialog(page, "/server.js");
  await page.click("#new-file");
  await setEditorText(page, STREAMING_SERVER);
  await runLine(page, "node server.js");

  const server = page.locator(".process-chip[data-pid='1']");
  await expect(server).toHaveAttribute("data-state", "running");
  // The port has to be known before anything asks for it: a preview opened in the window between "process started" and "port
  // registered" answers 503, which is a real product behaviour and would be a confusing way for this test to fail.
  await expect(page.locator("#scrollback")).toContainText("server listening on port(s) 3212");
  await server.getByRole("button", { name: "preview 3212" }).click();
  await expect(page.locator("#preview-frame")).toHaveAttribute("src", /\.preview\.localhost:\d+\//);
  const shell = page.frameLocator("#preview-frame");
  await expect(shell.locator("#preview-status")).toContainText("Preview server on port 3212");
  const served = shell.frameLocator("iframe[title='Project preview on port 3212']");
  await expect(served.locator("#served")).toContainText("streaming preview", { timeout: 15_000 });

  // The fetch happens inside the served document, which is the origin the preview service worker controls: a service worker is
  // per-origin, so the workspace page cannot reach it and the shell cannot either.
  const documentFrame = page.frames().find((frame) => frame.url().includes("/preview/3212/"));
  expect(documentFrame).toBeDefined();
  const measured = await documentFrame!.evaluate(async () => {
    const withDeadline = <T,>(work: Promise<T>, stage: string): Promise<T | { readonly stuckAt: string }> =>
      Promise.race([
        work,
        new Promise<{ readonly stuckAt: string }>((resolve) => setTimeout(() => resolve({ stuckAt: stage }), 10_000)),
      ]);
    const started = performance.now();

    const opened = await withDeadline(fetch("/preview/3212/stream"), "headers");
    if ("stuckAt" in opened) return { stuckAt: opened.stuckAt, status: 0, first: "", rest: "", firstAtMs: 0, endAtMs: 0 };
    const reader = opened.body?.getReader();
    if (reader === undefined) return { stuckAt: "no body", status: opened.status, first: "", rest: "", firstAtMs: 0, endAtMs: 0 };

    // Nothing has released the rest of this response yet. A streamed body gives this chunk now; a buffered one never gives it.
    const firstRead = await withDeadline(reader.read(), "first chunk before the response ends");
    if ("stuckAt" in firstRead) return { stuckAt: firstRead.stuckAt, status: opened.status, first: "", rest: "", firstAtMs: 0, endAtMs: 0 };
    const firstAtMs = performance.now() - started;
    const first = firstRead.value === undefined ? "" : new TextDecoder().decode(firstRead.value);

    // Only now, with the first chunk in hand, is the rest of the response released.
    await fetch("/preview/3212/finish");
    let rest = "";
    for (;;) {
      const chunk = await withDeadline(reader.read(), "the rest of the response");
      if ("stuckAt" in chunk) return { stuckAt: chunk.stuckAt, status: opened.status, first, rest, firstAtMs, endAtMs: 0 };
      if (chunk.done) break;
      if (chunk.value !== undefined) rest += new TextDecoder().decode(chunk.value);
    }
    return { stuckAt: "", status: opened.status, first, rest, firstAtMs, endAtMs: performance.now() - started };
  });

  expect(measured.stuckAt).toBe("");
  expect(measured.status).toBe(200);
  expect(measured.first).toBe("first");
  expect(measured.rest).toBe("second");

  const previewDocument = page.frames().find((frame) => frame.url().includes("/preview/3212/"));
  await previewDocument!.evaluate(async () => {
    await Promise.all((await navigator.serviceWorker.getRegistrations()).map((registration) => registration.unregister()));
  });
  await page.click("#close-preview");
  await server.locator("button[data-action='stop']").click();
  await expect(server).toHaveAttribute("data-state", "killed");
});
