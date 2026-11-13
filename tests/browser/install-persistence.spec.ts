/**
 * Persistence, measured: what survives a reload, what is rebuilt, and what is only in memory.
 *
 * This is deliberately separate from the acceptance journey. The journey's reload step sits behind a running Vite; this one installs the same way and stops
 * before a dev server, so the persistence claims can be evidenced whether or not the dependency optimizer is working.
 *
 * The point of the split is that "it persisted" is three different claims and they have three different mechanisms:
 *
 *   1. PROJECT FILES (and `package-lock.json`) live in `localStorage`, written by the page on every save. They survive a reload because they were never in
 *      the Worker at all.
 *   2. INSTALLED DEPENDENCIES are NOT persisted. `node_modules` lives in a volatile memory overlay inside the kernel Worker, which dies with the page. It
 *      is REBUILT at boot from the lockfile, and the rebuild is verified from cached tarball bytes; the install line has to say it happened, because a
 *      project whose `node_modules` silently vanished and then failed on first use is exactly the failure this assertion exists to catch.
 *   3. The TARBALL BYTES are in IndexedDB (when the browser offers it), keyed by URL, and every entry is re-verified against `dist.integrity` on every
 *      install, so a cache hit is a download saved and not a trust granted. This spec reports the cache's counters rather than assuming it helped.
 */

import { expect, test, type Page } from "@playwright/test";

test.setTimeout(420_000);

interface Handles {
  __store: { active: () => { files: Record<string, string> } };
  // The whole `RegistryStats`, not a hand-written subset: the subset went stale the moment the installer started reporting metadata requests, and
  // the assertion below could not see the counter it needed to prove "zero network" with.
  __registry: { lane: string; stats?: () => import("../../src/registry/network.js").RegistryStats };
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

const PACKAGE_JSON = `${JSON.stringify({ name: "persist-app", private: true, version: "0.0.0", type: "module", dependencies: { react: "latest", "react-dom": "latest" } }, null, 2)}\n`;

/** What the page actually stores, and how much room it has taken. Read from the page, not from the code that wrote it. */
const storageReport = async (page: Page): Promise<{ keys: string[]; bytes: number }> =>
  page.evaluate(() => {
    const keys = Object.keys(localStorage);
    let bytes = 0;
    for (const key of keys) bytes += (localStorage.getItem(key) ?? "").length;
    return { keys, bytes };
  });

test("a reload recovers the project, rebuilds the installed tree from the lockfile, and says so", async ({ page }) => {
  await page.goto("/?registry=network");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();

  await createFile(page, "/package.json", PACKAGE_JSON);
  await createFile(page, "/src/App.js", "export const greeting = 'still-here';\n");

  await page.fill("#command", "npm install");
  await page.press("#command", "Enter");
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, { timeout: 300_000 });

  const firstInstall = await page.evaluate(() => (window as unknown as Handles).__registry.stats?.());
  const lockfileBefore = await readFile(page, "/package-lock.json");
  expect(lockfileBefore).toContain('"lockfileVersion"');
  const before = await storageReport(page);
  console.log(`before reload: ${JSON.stringify({ firstInstall, storage: before })}`);
  expect(before.keys.length).toBeGreaterThan(0);

  // ---------------------------------------------------------------- reload
  await page.reload();
  await expect(page.locator("#tree li[data-path='/src/App.js']")).toBeVisible();

  // 1. the project is the same project
  expect(await readFile(page, "/package.json")).toBe(PACKAGE_JSON);
  expect(await readFile(page, "/src/App.js")).toBe("export const greeting = 'still-here';\n");
  expect(await readFile(page, "/package-lock.json")).toBe(lockfileBefore);
  const after = await storageReport(page);
  console.log(`after reload: ${JSON.stringify({ storage: after })}`);
  // The store did not grow a second project, and it is still the same bytes.
  expect(after.keys).toEqual(before.keys);

  // 2. dependencies are NOT persisted; they are rebuilt from the lockfile, and the terminal says which project it rebuilt
  await expect(page.locator("#scrollback")).toContainText("restoring dependencies from /package-lock.json", { timeout: 300_000 });
  await expect(page.locator("#scrollback")).toContainText(/added \d+ package\(s\) from registry\.npmjs\.org/, { timeout: 300_000 });

  // 3. the rebuild is real. Proven by REQUIRING the package, not by `ls`: `ls` reads the project store, which is the page's truth and never holds
  // `node_modules` - the installed tree is the kernel's overlay. Asserting on `ls` here failed with "no such directory" while the rebuild had in fact
  // just added three packages, which is the difference between the two filesystems being visible in one place.
  await createFile(page, "/check.js", "const react = require('react');\nconsole.log('REACT_VERSION', react.version);\n");
  await page.fill("#command", "node /check.js");
  await page.press("#command", "Enter");
  await expect(page.locator("#scrollback")).toContainText(/REACT_VERSION 1[89]\./, { timeout: 120_000 });

  const secondInstall = await page.evaluate(() => (window as unknown as Handles).__registry.stats?.());
  console.log(`after rebuild: ${JSON.stringify(secondInstall)}`);
  // The counters belong to the page, so they restart at the reload - and that is what makes them worth asserting on: the rebuilt tree has to be zero
  // network requests and one cache hit per tarball the first install downloaded. A cache hit is not a trust granted: the installer re-verifies every
  // tarball against `dist.integrity` on every install, hit or miss, so these three were checked again here.
  expect(secondInstall).toBeDefined();
  expect(secondInstall?.metadataRequests).toBe(0);
  expect(secondInstall?.tarballRequests).toBe(0);
  expect(secondInstall?.bytesDownloaded).toBe(0);
  expect(secondInstall?.tarballCacheHits).toBe(firstInstall?.tarballRequests ?? 0);

});
