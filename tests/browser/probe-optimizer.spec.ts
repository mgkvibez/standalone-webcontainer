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

const PROBE_JS = "const t0 = Date.now();\nconst fs = require(\"fs\");\nconst log = (...a) => console.log(\"[\" + (Date.now() - t0) + \"ms]\", ...a);\nprocess.on?.(\"unhandledRejection\", (e) => log(\"UNHANDLED REJECTION\", String(e && (e.stack || e.message)).slice(0, 800)));\nimport(\"/node_modules/vite/dist/node/index.js\")\n  .then(async (vite) => {\n    const server = await vite.createServer({ root: \"/\", configFile: false, logLevel: \"info\", server: { port: 3100, host: \"127.0.0.1\" } });\n    log(\"created\");\n    await server.listen();\n    log(\"listening on\", JSON.stringify(server.resolvedUrls));\n    const result = await server.transformRequest(\"/src/main.js\");\n    log(\"transformRequest code head:\", String(result && result.code).slice(0, 400));\n    const opt = server.depsOptimizer;\n    if (!opt) { log(\"NO server.depsOptimizer\"); } else {\n      log(\"optimizer own keys:\", JSON.stringify(Object.keys(opt)));\n      log(\"optimizer state:\", String(opt.state), \"discovered:\", JSON.stringify(opt.discovered));\n      log(\"optimizer metadata:\", JSON.stringify(opt.metadata));\n    }\n    log(\"server._optimizeDepsMetadata:\", JSON.stringify(server._optimizeDepsMetadata));\n    try { log(\"deps dir:\", JSON.stringify(fs.readdirSync(\"/node_modules/.vite/deps\"))); } catch (e) { log(\"deps dir failed\", e.code); }\n    await server.close();\n    log(\"closed\");\n  })\n  .catch((e) => log(\"FAILED:\", String(e && (e.stack || e.message)).slice(0, 2500)));\n";

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
