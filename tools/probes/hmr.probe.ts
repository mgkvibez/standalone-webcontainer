/**
 * Which link of the hot-update chain stops when the dev server is REAL vite.
 *
 * The acceptance journey renders `hello-v1` through real vite and then never receives the edit, and vite's own transcript never printed
 * `hmr update /src/App.js`. That line is the discriminator: vite prints it when it decides to send, and nothing at all when its watcher never saw
 * the change. So the question here is narrower than "does HMR work": does a save reach chokidar, which is the watcher vite actually uses.
 *
 * The instrument is a vite plugin, not a second program. The container runs one command at a time (a server holds the queue), so a separate
 * watcher process cannot run beside the dev server at all; a `configureServer` hook runs INSIDE the vite process, on the very watcher object
 * whose silence is the failure, and prints what it hears.
 */
import { expect, test, type Page } from "@playwright/test";

test.setTimeout(600_000);

interface Handles {
  __store: { active: () => { files: Record<string, string> } };
}

const readFile = async (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((wanted) => (window as unknown as Handles).__store.active().files[wanted], path);

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
  await expect.poll(() => readFile(page, path), { timeout: 15_000 }).toBe(text);
};

const runLine = async (page: Page, line: string): Promise<void> => {
  await page.fill("#command", line);
  await page.press("#command", "Enter");
};

const PACKAGE_JSON = `${JSON.stringify({ name: "probe-hmr", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" } }, null, 2)}\n`;

const INDEX_HTML =
  '<!doctype html>\n<html><head><meta charset="utf-8" /></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n';

const MAIN_JS = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = createRoot(document.getElementById("root"));
root.render(createElement(App));
`;

/**
 * Everything the probe needs to know about vite's watcher, printed from inside the process that owns it.
 *
 * `options` names the mode chokidar chose (a polling fallback and a native watch look identical from outside), `watched` lists the paths
 * chokidar believes it is watching, and the `all` listener is the one vite's own update logic is built on, so an event here and a missing
 * `hmr update` would mean the runtime is fine and vite's filtering is not.
 */
const VITE_CONFIG = `import { defineConfig } from "vite";
import fs from "fs";
import util from "util";

const print = (...parts) => console.log("PROBE", ...parts);
const attempt = (label, run) => {
  try {
    print(label, JSON.stringify(run()).slice(0, 500));
  } catch (error) {
    print(label, "THREW", error && error.message);
  }
};

export default defineConfig({
  plugins: [
    {
      name: "probe-watcher",
      configureServer(server) {
        const watcher = server.watcher;
        print("options", JSON.stringify({ usePolling: watcher.options.usePolling, ignoreInitial: watcher.options.ignoreInitial, depth: watcher.options.depth }));

        // chokidar swallows ENOENT/ENOTDIR without emitting, so its own error funnel is the only place a silent scan failure can be seen.
        const handleError = watcher._handleError.bind(watcher);
        watcher._handleError = (error) => {
          print("handleError", error && ((error.code || "no-code") + " " + error.message).slice(0, 200));
          return handleError(error);
        };

        attempt("ignored src", () => watcher._isIgnored("/src"));
        attempt("ignored index.html", () => watcher._isIgnored("/index.html"));
        attempt("ignored paths", () => [...(watcher._ignoredPaths ?? [])].map(String).slice(0, 8));

        // The scan chokidar runs over a directory, called exactly as _handleRead calls it.
        try {
          const stream = watcher._readdirp("/", { type: "all" });
          if (stream === undefined) print("scan unavailable");
          else {
            stream.on("data", (entry) => print("scan data", JSON.stringify({ path: entry.path, fullPath: entry.fullPath, stats: entry.stats ? (typeof entry.stats.isDirectory === "function" ? (entry.stats.isDirectory() ? "dir" : "file") : "no-predicates") : String(entry.stats) }).slice(0, 300)));
            stream.on("error", (error) => print("scan error", error && ((error.code || "no-code") + " " + error.message).slice(0, 300)));
            stream.on("end", () => print("scan end"));
            stream.on("close", () => print("scan close"));
          }
        } catch (error) {
          print("scan THREW", error && error.message);
        }

        // chokidar's own stat step, promisified the same way it promisifies it, for every entry the scan should have produced.
        for (const target of ["/index.html", "/src", "/package.json", "/vite.config.js", "/node_modules"]) {
          util.promisify(fs.stat)(target).then(
            (stats) => print("stat ok", target, JSON.stringify({ dir: stats.isDirectory(), file: stats.isFile(), hasPredicates: typeof stats.isDirectory === "function" })),
            (error) => print("stat FAILED", target, error && (error.code || "no-code"), error && error.message),
          );
        }

        try {
          fs.watch("/src", (event, name) => print("raw /src", event, String(name)));
          print("raw /src watching");
        } catch (error) {
          print("raw /src THREW", error && error.message);
        }

        for (const event of ["all", "add", "addDir", "change", "unlink", "ready", "error"]) {
          watcher.on(event, (...args) => print("watcher", event, args.map((value) => String(value)).join(" ").slice(0, 240)));
        }
        // Is the process still running its own loop at all? If the ticks stop, the question is no longer about watching.
        let tick = 0;
        setInterval(() => {
          tick += 1;
          print("tick", String(tick));
        }, 1000);
        process.on("uncaughtException", (error) => print("uncaught", error && error.message));
        process.on("unhandledRejection", (error) => print("unhandled", String(error).slice(0, 300)));
        for (const delay of [2000, 5000, 9000, 13000]) {
          setTimeout(() => print("watched@" + String(delay), JSON.stringify(watcher.getWatched()).slice(0, 900)), delay);
        }
      },
    },
  ],
});
`;

const APP_V1 = 'import { createElement } from "react";\n\nexport function App() {\n  return createElement("h1", { id: "greeting" }, "hello-v1");\n}\n';
const APP_V2 = 'import { createElement } from "react";\n\nexport function App() {\n  return createElement("h1", { id: "greeting" }, "hello-v2");\n}\n';

test("probe: does a save reach vite's own watcher", async ({ page }) => {
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("DBG")) console.log(text);
  });
  await page.goto("/?registry=network");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
  await createFile(page, "/package.json", PACKAGE_JSON);
  await createFile(page, "/index.html", INDEX_HTML);
  await createFile(page, "/src/main.js", MAIN_JS);
  await createFile(page, "/src/App.js", APP_V1);
  await createFile(page, "/vite.config.js", VITE_CONFIG);
  console.log("PROBE step: files written");

  await runLine(page, "npm install react react-dom vite@^5.4.11");
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, { timeout: 300_000 });
  console.log("PROBE step: install done");

  await runLine(page, "npm run dev -- --port 3000 --host 127.0.0.1");
  await expect(page.locator("#scrollback")).toContainText("PROBE options", { timeout: 150_000 });
  console.log("PROBE step: vite up, watcher instrumented");

  // Does a request restart the process's own loop? Two preview opens, three seconds apart, before the save under test.
  for (const round of [1, 2]) {
    await page.locator('#processes button[data-action="preview"]').first().click();
    await page.waitForTimeout(3_000);
    console.log(`PROBE step: preview round ${String(round)} opened`);
    await page.locator("#close-preview").click().catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  const editAt = Date.now();
  await createFile(page, "/src/App.js", APP_V2);
  console.log(`PROBE step: edited, save took ${String(Date.now() - editAt)}ms`);
  await page.waitForTimeout(20_000);

  const scrollback = await page.locator("#scrollback").innerText();
  console.log("PROBE SCROLLBACK>>>\n" + scrollback.split("\n").slice(-80).join("\n"));
  expect(await readFile(page, "/src/App.js")).toBe(APP_V2);
  // The two claims in one assertion each: chokidar's scan produced entries, and vite itself decided to send an update.
  console.log("PROBE has hmr update: " + String(scrollback.includes("hmr update")));
});
