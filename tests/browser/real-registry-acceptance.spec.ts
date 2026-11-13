/**
 * The milestone's acceptance journey, in the real browser product, against the real public npm registry.
 *
 * Nothing here is stubbed. The page boots on the product's default lane (`?registry=network`), `npm install` reaches `registry.npmjs.org`, the
 * tarballs are the published ones, the dev server is the published `vite` running inside this runtime, and the preview is served through the
 * preview shell on its own origin. A test-only mock, a synthetic packument or a hand-written dev server would each make this file pass while the
 * product stayed where it was, which is exactly the substitution the directive refuses.
 *
 * The journey is one test rather than fifteen: each step depends on the last, and a step that fails has to report the furthest verified point rather
 * than a list of independent colour changes.
 */

import { expect, test, type Page } from "@playwright/test";

test.setTimeout(600_000);

interface RegistryStats {
  metadataRequests: number;
  metadataCacheHits: number;
  tarballRequests: number;
  tarballCacheHits: number;
  bytesDownloaded: number;
}

interface LockEntry {
  version?: string;
  integrity?: string;
  resolved?: string;
  dev?: boolean;
}

/** The page's own handles, which `main.ts` exposes for the browser tests and for devtools. Not a public API. */
interface PageHandles {
  __registry: { lane: string; origin?: string; stats?: () => RegistryStats };
  __store: { active: () => { files: Record<string, string> } };
  __container: { processes: () => readonly { pid: number; state: string; previewPorts?: readonly number[] }[] };
}

const registryStats = async (page: Page): Promise<RegistryStats> =>
  page.evaluate(() => {
    const registry = (window as unknown as PageHandles).__registry;
    if (registry.stats === undefined) throw new Error(`the ${registry.lane} lane has no stats`);
    return registry.stats();
  });

const readProjectFile = async (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((wanted) => (window as unknown as PageHandles).__store.active().files[wanted], path);

const boot = async (page: Page): Promise<void> => {
  await page.goto("/?registry=network");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
};

const runLine = async (page: Page, line: string): Promise<void> => {
  await page.fill("#command", line);
  await page.press("#command", "Enter");
};

/**
 * Create a file and wait for the save to reach the project store.
 *
 * `#save-state` is NOT a reliable signal: it already reads "saved" from the previous edit, so asserting on it can pass before this edit has been
 * written. Polling the store is the real state, and it is what the runtime will be handed at the next run.
 */
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

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "react-app",
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
  },
  null,
  2,
)}\n`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>react-app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

/**
 * The app, written without JSX on purpose.
 *
 * Vite transforms JSX with esbuild, and this runtime substitutes `esbuild-wasm` for the native build (ADR: substitutions.ts), which needs an
 * initialise hook before its API exists. That substitution is real and worth exercising, but it is a different claim from "React renders and its
 * component updates over HMR". So the JSX question is kept out of this file: `createElement` needs no transform, and a failure here is a failure of
 * the journey rather than of a compiler hook.
 */
const MAIN_JS = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = createRoot(document.getElementById("root"));
root.render(createElement(App));

// The HMR boundary. This is Vite's own client protocol: on an update for App.js the runtime re-executes that module and hands the new exports
// here, so the page re-renders without a reload. No custom event, no simulated push.
if (import.meta.hot) {
  import.meta.hot.accept("./App.js", (next) => {
    if (next !== undefined) root.render(createElement(next.App));
  });
}
`;

const APP_JS = `import { createElement } from "react";

export function App() {
  return createElement("h1", { id: "greeting" }, "hello-v1");
}
`;

const lockfile = async (page: Page): Promise<Record<string, LockEntry>> => {
  const text = await readProjectFile(page, "/package-lock.json");
  if (text === undefined) throw new Error("the install wrote no package-lock.json");
  const parsed = JSON.parse(text) as { packages: Record<string, LockEntry> };
  return parsed.packages;
};

test("installs React, React DOM and Vite from the public registry and runs the app through the real preview", async ({ page }) => {
  await boot(page);

  // ---------------------------------------------------------------- 1-4: a project, and the three installs
  await createFile(page, "/package.json", PACKAGE_JSON);
  await createFile(page, "/index.html", INDEX_HTML);
  await createFile(page, "/src/main.js", MAIN_JS);
  await createFile(page, "/src/App.js", APP_JS);

  const installStart = Date.now();
  // Vite is pinned to the 5.x line on purpose, and the pin is in the command so the scrollback says which tree was installed. Vite 6+ is a
  // rolldown build whose only bindings are native or wasm32-wasi platform packages, which this runtime refuses by design (it cannot load a
  // native addon); 5.x is the line that runs on the JS rollup fallback and esbuild-wasm, and it is the line the dev-server fixture proves. The
  // limitation is documented rather than hidden behind `latest`.
  await runLine(page, "npm install react react-dom vite@^5.4.11");
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, {
    timeout: 300_000,
  });
  const installMs = Date.now() - installStart;
  console.log(`install wall clock: ${String(installMs)}ms`);

  // ---------------------------------------------------------------- 5: real metadata was retrieved
  const stats = await registryStats(page);
  console.log(`registry stats: ${JSON.stringify(stats)}`);
  expect(stats.metadataRequests).toBeGreaterThan(0);
  expect(stats.bytesDownloaded).toBeGreaterThan(0);

  // ---------------------------------------------------------------- 6-7: real tarballs, verified
  expect(stats.tarballRequests).toBeGreaterThan(0);
  const packages = await lockfile(page);
  const react = packages["node_modules/react"];
  const reactDom = packages["node_modules/react-dom"];
  const vite = packages["node_modules/vite"];
  expect(react?.version).toMatch(/^(18|19)\./);
  expect(reactDom?.version).toMatch(/^(18|19)\./);
  expect(vite?.version).toMatch(/^5\./);
  // Every entry names the published tarball and an sha512 digest the installer verified before writing a byte.
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith("node_modules/")) continue;
    expect(entry.integrity, `${path} has no integrity`).toMatch(/^sha512-/);
    expect(entry.resolved, `${path} has no resolved URL`).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  }
  // The install line must not carry an integrity warning: a warning here means bytes were installed without a strong digest.
  await expect(page.locator("#scrollback")).not.toContainText("INTEGRITY");

  // ---------------------------------------------------------------- 8: the tree
  const installed = Object.keys(packages).filter((path) => path.startsWith("node_modules/"));
  console.log(`tree: ${String(installed.length)} packages, head: ${installed.slice(0, 8).join(", ")}`);
  expect(installed.length).toBeGreaterThan(10);
});

/** The component after an edit: the value an HMR update must deliver, and a full reload would also deliver. The marker is what tells them apart. */
const APP_JS_EDITED = `import { createElement } from "react";

export function App() {
  return createElement("h1", { id: "greeting" }, "hello-v2");
}
`;

const previewButton = (port: number) => `button[data-action='preview']:has-text('preview ${String(port)}')`;

// TEMPORARY DIAGNOSTIC: the terminal transcript whenever this test fails.
test.afterEach(async ({ page }) => {
  if (test.info().status === "passed") return;
  const text = await page.locator("#scrollback").innerText().catch(() => "<no scrollback>");
  console.log("SCROLLBACK>>>\n" + text.slice(-5000));
});

test("runs the installed Vite, serves the app through the preview, hot-updates it, and rebuilds the tree after a reload", async ({ page }) => {
  await boot(page);
  await createFile(page, "/package.json", PACKAGE_JSON);
  await createFile(page, "/index.html", INDEX_HTML);
  await createFile(page, "/src/main.js", MAIN_JS);
  await createFile(page, "/src/App.js", APP_JS);
  await runLine(page, "npm install react react-dom vite@^5.4.11");
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, {
    timeout: 300_000,
  });

  // ---------------------------------------------------------------- 9-10: the real dev server, and its port
  await runLine(page, "npm run dev -- --port 3000 --host 127.0.0.1");
  const preview = page.locator(previewButton(3000));
  await expect(preview).toBeVisible({ timeout: 120_000 });
  const processes = await page.evaluate(() => (window as unknown as PageHandles).__container.processes());
  const dev = processes.find((entry) => entry.previewPorts?.includes(3000));
  expect(dev?.state).toBe("running");

  // ---------------------------------------------------------------- 11-12: the preview serves the app
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(`console.${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("preview.localhost")) return;
    if (response.status() === 200) {
      console.log("RESP", response.status(), url.slice(0, 140));
      return;
    }
    void response
      .text()
      .then((text) => console.log("RESP", response.status(), url.slice(0, 140), "BODY:", text.slice(0, 400)))
      .catch(() => console.log("RESP", response.status(), url.slice(0, 140)));
  });
  // TEMPORARY DIAGNOSTIC: the preview frame's own socket traffic, which is the only place a refusal sentence is visible.
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: unknown } | null;
      if (data === null || typeof data !== "object" || typeof data.type !== "string" || !data.type.startsWith("socket-")) return;
      console.log("SWCSOCKET " + JSON.stringify(data).slice(0, 400));
    });
  });
  await preview.click();
  await page.waitForTimeout(25_000);
  const app = page.frameLocator("#preview-frame");
  console.log("CONSOLE>>>", consoleLines.join("\n"));
  for (const frame of page.frames()) {
    if (!frame.url().includes("/preview/3000/")) continue;
    const state = await frame
      .evaluate(() => ({
        root: document.getElementById("root")?.innerHTML ?? null,
        body: document.body.innerHTML.slice(0, 400),
      }))
      .catch((error: unknown) => `FRAME EVAL FAILED ${String(error)}`);
    console.log("PREVIEW FRAME>>>", JSON.stringify(state));
  }
  await expect(app.locator("#root h1#greeting")).toHaveText("hello-v1", { timeout: 180_000 });

  // A marker only this page's own JavaScript can have set, so its survival proves the document was never reloaded. Vite's client keeps the
  // module graph in this same window, which is what an HMR update needs and a reload would destroy.
  await app.locator("body").evaluate((body) => {
    (window as unknown as { __hmrMarker?: string }).__hmrMarker = "kept";
    body.dataset["hmrMarker"] = "kept";
  });

  // ---------------------------------------------------------------- 13: genuine HMR, no reload
  await createFile(page, "/src/App.js", APP_JS_EDITED);
  await expect(app.locator("#root h1#greeting")).toHaveText("hello-v2", { timeout: 120_000 });
  const markerSurvived = await app.locator("body").evaluate(() => {
    const body = document.querySelector("body");
    return (
      (window as unknown as { __hmrMarker?: string }).__hmrMarker === "kept" && body?.dataset["hmrMarker"] === "kept"
    );
  });
  expect(markerSurvived).toBe(true);

  // ---------------------------------------------------------------- 14-16: reload, files, tree, rerun
  const lockfileBefore = await readProjectFile(page, "/package-lock.json");
  expect(lockfileBefore).toContain("node_modules/vite");
  await page.reload();
  await expect(page.locator("#tree li[data-path='/src/App.js']")).toBeVisible();
  expect(await readProjectFile(page, "/src/App.js")).toBe(APP_JS_EDITED);
  expect(await readProjectFile(page, "/package-lock.json")).toBe(lockfileBefore);
  // Boot rebuilds the installed tree from the lockfile, and says so: a project whose node_modules silently vanished and then failed on first use
  // is the shape of failure this line exists to prevent.
  await expect(page.locator("#scrollback")).toContainText("restoring dependencies from /package-lock.json", { timeout: 300_000 });
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, { timeout: 300_000 });

  await runLine(page, "npm run dev -- --port 3001 --host 127.0.0.1");
  await expect(page.locator(previewButton(3001))).toBeVisible({ timeout: 120_000 });
  await page.locator(previewButton(3001)).click();
  await expect(page.frameLocator("#preview-frame").locator("#root h1#greeting")).toHaveText("hello-v2", { timeout: 180_000 });
});
