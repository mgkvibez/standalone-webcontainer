/**
 * A dev server watches a project file and pushes the change into a page that is already open (W-26).
 *
 * This is the loop the whole websocket story exists for, and every boundary it claims to cross is real here: the page is served by the preview
 * shell on its own origin, the injected client asks the shell, the shell posts into the runtime Worker, the Worker asks the kernel, and the kernel
 * reaches the program that owns the port. The edit is made the way a person makes one, through the editor, and the program learns about it the
 * way a dev server learns about it, through `fs.watch` on the kernel's filesystem.
 *
 * What replaces Vite: the protocol SHAPE, not the package. The container can now install a real `vite` (the real-registry journey does exactly
 * that), but this spec is about the transport, so a hundred-line dev server keeps it hermetic and makes the failure land on the socket rather than
 * on a package. Guiding wrong-guess cost: the shape is what would break, so the shape is what is pinned here. One difference is real and recorded in
 * ADR-0034 rather than hidden: inside a previewed page `location.port` is the HOST app's port, not the previewed server's, so the client builds
 * `ws://<hostname>` with no port and the `/preview/<port>/` prefix supplies it.
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

const setEditorText = async (page: Page, text: string): Promise<void> => {
  await page.locator(".cm-content").fill(text);
  await expect(page.locator("#save-state")).toHaveText("saved", { timeout: 5_000 });
};

const openFile = async (page: Page, path: string): Promise<void> => {
  await page.locator(`#tree li[data-path="${path}"]`).click();
  await expect(page.locator("#open-file")).toHaveText(path);
};

const createFile = async (page: Page, path: string, text: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path));
  await page.click("#new-file");
  await setEditorText(page, text);
};

/** The fractional part of "v1"/"v2": what the page renders, replaced by an edit and pushed over the socket. */
const moduleSource = (value: string): string => `document.getElementById("root").textContent = ${JSON.stringify(value)};\n`;

/**
 * A dev server with no dependencies: it serves a page, watches the module, and pushes the new source down the socket on every change.
 *
 * Written by hand because the container has no registry, and deliberately the same shape a bundled dev server uses: an upgrade listener that
 * answers with the subprotocol it was offered, and a watcher that turns a filesystem event into a message on every open connection.
 */
const DEV_SERVER = `
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MODULE = "/app.js";
const sockets = new Set();

const PAGE = [
  "<!doctype html><html><head><title>hmr</title></head><body>",
  "<div id=\\"root\\">pending</div>",
  "<script>",
  // The realm marker: an update must not replace this document, so these two values have to survive it.
  "window.__docId = Math.random().toString(36).slice(2);",
  "window.__updates = 0;",
  "window.__status = \\"connecting\\";",
  "function apply(code) { new Function(code)(); }",
  "fetch(\\"/app.js\\").then(function (r) { return r.text(); }).then(apply);",
  // No port: inside a previewed page location.port is the HOST app's port, and the /preview/<port>/ prefix is what says which server this is.
  "var socket = new WebSocket(\\"ws://\\" + location.hostname + \\"/\\", \\"vite-hmr\\");",
  "socket.onopen = function () { window.__status = \\"open:\\" + socket.protocol; };",
  "socket.onerror = function () { window.__status = \\"error\\"; };",
  "socket.onmessage = function (event) {",
  "  var message = JSON.parse(event.data);",
  "  if (message.type !== \\"update\\") return;",
  "  window.__updates += 1;",
  "  apply(message.code);",
  "};",
  "</script></body></html>",
].join("");

function textFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x81, 126, (payload.length >> 8) & 255, payload.length & 255]), payload]);
}

const server = http.createServer(function (request, response) {
  if (request.url.split("?")[0] === "/app.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(fs.readFileSync(MODULE, "utf8"));
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(PAGE);
});

server.on("upgrade", function (request, socket) {
  const key = request.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  const offered = request.headers["sec-websocket-protocol"];
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\n" +
      "Upgrade: websocket\\r\\n" +
      "Connection: Upgrade\\r\\n" +
      "Sec-WebSocket-Accept: " + accept + "\\r\\n" +
      (offered === undefined ? "" : "Sec-WebSocket-Protocol: " + String(offered).split(",")[0].trim() + "\\r\\n") +
      "\\r\\n",
  );
  sockets.add(socket);
  socket.on("close", function () { sockets.delete(socket); });
  socket.on("error", function () { sockets.delete(socket); });
  // The client only listens, so inbound frames are drained and ignored rather than parsed.
  socket.on("data", function () {});
});

fs.watch(MODULE, function () {
  const code = fs.readFileSync(MODULE, "utf8");
  const message = textFrame(JSON.stringify({ type: "update", code: code }));
  for (const socket of sockets) socket.write(message);
  console.log("pushed an update to " + sockets.size + " client(s)");
});

server.listen(5173, function () { console.log("dev server listening on 5173"); });
`;

test("a dev server pushes an edit into a live preview without a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  await createFile(page, "/dev-server.js", DEV_SERVER);
  await createFile(page, "/app.js", moduleSource("v1"));

  await runLine(page, "node dev-server.js");
  const server = page.locator(".process-chip[data-pid='1']");
  await expect(server).toHaveAttribute("data-state", "running");
  await expect(page.locator("#scrollback")).toContainText("dev server listening on 5173");

  await server.getByRole("button", { name: "preview 5173" }).click();
  const preview = page.frameLocator("#preview-frame").frameLocator("iframe[title='Project preview on port 5173']");

  // The page's own script fetched the module, so this is the served document running, not a fixture standing in for it.
  await expect(preview.locator("#root")).toHaveText("v1", { timeout: 20_000 });
  // The websocket crossed four boundaries before this text appeared: page -> shell -> runtime Worker -> kernel -> the program's upgrade listener.
  await expect(preview.locator("body")).toHaveCSS("margin", /.+/);
  const before = await preview.locator("#root").evaluate(() => ({
    docId: (window as unknown as { __docId: string }).__docId,
    updates: (window as unknown as { __updates: number }).__updates,
    status: (window as unknown as { __status: string }).__status,
  }));
  expect(before.status).toBe("open:vite-hmr");
  expect(before.updates).toBe(0);

  // The edit, through the editor, which is the path a user takes -- and possible only because the preview is a panel beside the editor
  // rather than a dialog over it.
  await openFile(page, "/app.js");
  await setEditorText(page, moduleSource("v2"));

  await expect(preview.locator("#root")).toHaveText("v2", { timeout: 30_000 });
  const after = await preview.locator("#root").evaluate(() => ({
    docId: (window as unknown as { __docId: string }).__docId,
    updates: (window as unknown as { __updates: number }).__updates,
  }));
  // The claim is "without a reload", so the realm has to be the same one: a replaced document would have a new id and lose the counter.
  expect(after.docId).toBe(before.docId);
  expect(after.updates).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#scrollback")).toContainText("pushed an update to 1 client");
});
