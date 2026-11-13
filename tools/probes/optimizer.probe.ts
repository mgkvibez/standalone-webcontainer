import { expect, test, type Page } from "@playwright/test";

test.setTimeout(600_000);

interface PageHandles {
  __store: { active: () => { files: Record<string, string> } };
}

const readProjectFile = async (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((wanted) => (window as unknown as PageHandles).__store.active().files[wanted], path);

const createFile = async (page: Page, path: string, text: string): Promise<void> => {
  const existing = page.locator(`#tree li[data-path="${path}"]`);
  if ((await existing.count()) > 0) {
    await existing.click();
    await page.locator(".cm-content").fill(text);
  } else {
    page.once("dialog", (dialog) => void dialog.accept(path));
    await page.click("#new-file");
    await page.locator(".cm-content").fill(text);
  }
  await expect.poll(() => readProjectFile(page, path), { timeout: 15_000 }).toBe(text);
};

const runLine = async (page: Page, line: string): Promise<void> => {
  await page.fill("#command", line);
  await page.press("#command", "Enter");
};

const PACKAGE_JSON = `${JSON.stringify({ name: "probe-app", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`;
const INDEX_HTML = '<!doctype html>\n<html><head><meta charset="utf-8" /><title>probe</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n';
const MAIN_JS = 'import { createElement } from "react";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")).render(createElement("h1", null, "probe"));\n';

/**
 * The question this run answers: in the BROWSER product, does the optimizer's write ever land?
 *
 * The offline lanes (InProcessRuntime, and the real registry in-process) both complete and serve the pre-bundled files, so the remaining `504 Outdated
 * Optimize Dep` has to come from something only the browser lane has. That lane's difference is a REMOTE filesystem: every write is a message to the
 * kernel and every completion arrives as an event. So the probe starts the same server, asks for the same transform, and then watches the directory for
 * twenty seconds from inside the same program, printing what it sees. A directory that never appears is a write that never completed; a directory that
 * appears late is a write that started but was never pumped to completion.
 */
const PROBE_JS = `const t0 = Date.now();
const fs = require("fs");
const log = (...a) => console.log("[" + (Date.now() - t0) + "ms]", ...a);
process.on?.("unhandledRejection", (e) => log("UNHANDLED REJECTION", String(e && (e.stack || e.message)).slice(0, 600)));
import("/node_modules/vite/dist/node/index.js")
  .then(async (vite) => {
    const server = await vite.createServer({ root: "/", configFile: false, logLevel: "info", server: { port: 3100, host: "127.0.0.1" } });
    await server.listen();
    log("listening");
    const result = await server.transformRequest("/src/main.js");
    log("specifiers:", (String(result && result.code).match(/deps\\/[A-Za-z0-9_-]+\\.js\\?v=[0-9a-f]+/g) || []).join(" "));
    log("optimizer-ish keys on server:", Object.keys(server).filter((k) => /optim/i.test(k)).join(",") || "none");
    for (let tick = 1; tick <= 20; tick++) {
      let listing = "ENOENT";
      try { listing = fs.readdirSync("/node_modules/.vite/deps").join(","); } catch (e) { listing = "ENOENT"; }
      let meta = "-";
      try { meta = JSON.stringify(JSON.parse(String(fs.readFileSync("/node_modules/.vite/deps/_metadata.json"))).browserHash); } catch (e) { meta = "none"; }
      log("tick " + tick + "s deps=" + (listing === "ENOENT" ? "ENOENT" : listing.slice(0, 120)) + " browserHash=" + meta);
      await new Promise((r) => setTimeout(r, 1000));
    }
    log("done watching");
  })
  .catch((e) => log("FAILED:", String(e && (e.stack || e.message)).slice(0, 2000)));
`;

test("probe: which vite optimizer stage never returns", async ({ page }) => {
  await page.goto("/?registry=network");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
  await createFile(page, "/package.json", PACKAGE_JSON);
  await createFile(page, "/index.html", INDEX_HTML);
  await createFile(page, "/src/main.js", MAIN_JS);
  await createFile(page, "/probe-optimize.js", PROBE_JS);

  await runLine(page, "npm install react react-dom vite@^5.4.11");
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, { timeout: 300_000 });

  await runLine(page, "node /probe-optimize.js");
  await page.waitForTimeout(120_000);
  console.log("PROBE TRANSCRIPT>>>\n" + (await page.locator("#scrollback").innerText()).slice(-8_000));
});
