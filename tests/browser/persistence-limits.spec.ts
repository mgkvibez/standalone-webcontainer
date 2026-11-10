/**
 * Where localStorage actually stops working, measured in a real browser.
 *
 * Persistence is `localStorage` today: synchronous, one versioned key, whole project map rewritten on every change. That choice is
 * cheap and it works, but three claims about it have never been measured, and the persistence decision (ADR-0017) should not be
 * made on instinct:
 *
 *   1. what the quota ceiling actually is for this origin,
 *   2. what happens to a save that exceeds it (the store records an error rather than dropping data silently),
 *   3. what two tabs do to each other, since each holds its own copy of the whole map.
 *
 * The assertions here are deliberately narrow: they pin the PROMISES the store already makes (an error is surfaced, the app keeps
 * working, nothing is corrupted). The numbers are printed, because a measurement that is asserted becomes a brittle test the day a
 * browser changes its quota, and this file's job is evidence, not a gate.
 */

import { expect, test, type Page } from "@playwright/test";

const boot = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#tree li[data-path='/index.js']")).toBeVisible();
};

test("measures the quota ceiling by filling one key until it refuses", async ({ page }) => {
  await boot(page);

  const measured = await page.evaluate(() => {
    // A separate key, so a failed measurement cannot damage the saved workspace.
    const key = "swc.quota-probe";
    const chunk = "x".repeat(64 * 1024);
    let bytes = 0;
    let error: string | null = null;
    try {
      // Each localStorage character is two bytes of UTF-16 in the usual accounting, but the browser's limit is in its own terms,
      // so this reports what was accepted rather than converting to a claim about megabytes.
      for (let index = 0; index < 2000; index += 1) {
        localStorage.setItem(key, chunk.repeat(index + 1));
        bytes = chunk.length * (index + 1);
      }
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    }
    localStorage.removeItem(key);
    return { bytes, error };
  });

  console.log(`measured quota ceiling: ${(measured.bytes / 1024 / 1024).toFixed(2)} M chars per key, refused at ${measured.error}`);
  // The only assertion: the browser DOES refuse eventually, and with a named error rather than silent truncation. The exact
  // ceiling is printed, not asserted, because it is the browser's number and not ours.
  expect(measured.error).not.toBeNull();
  expect(measured.error).toMatch(/QuotaExceeded|quota/i);
});

test("surfaces a save failure instead of dropping the project silently", async ({ page }) => {
  await boot(page);

  // Fill the origin's storage so the next real save must fail, then create a project through the UI.
  //
  // The fill shrinks its chunk size as it goes (64 KB, then 1 KB, then 16 bytes) so the leftover slack is smaller than the few
  // hundred bytes a project needs. A single chunk size leaves up to a chunk of slack, which was enough for the save to succeed and
  // made the first version of this test assert nothing.
  await page.evaluate(() => {
    const sizes = [64 * 1024, 1024, 16];
    for (const size of sizes) {
      const chunk = "y".repeat(size);
      for (let index = 0; index < 4096; index += 1) {
        try {
          localStorage.setItem(`swc.fill.${size}.${index}`, chunk);
        } catch {
          break;
        }
      }
    }
  });

  // Creating a project asks for a name in a prompt, so the dialog is answered rather than the prompt being bypassed: the save is
  // triggered by the same path a user takes.
  page.on("dialog", (dialog) => void dialog.accept("cannot be saved"));
  await page.click("#new-project");

  // The promise: the failure is visible where saves are reported, and the app is still usable rather than wedged.
  await expect(page.locator("#save-state")).toHaveText(/could not save/i, { timeout: 10_000 });
  await expect(page.locator("#save-state")).toHaveClass(/error/);
  // Still alive: the editor answers, which is what "not wedged" means concretely.
  await expect(page.locator(".cm-content")).toBeVisible();

  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("swc.fill.")) localStorage.removeItem(key);
    }
  });
});

test("measures what two tabs do to each other", async ({ browser }) => {
  // ONE context, two pages. `browser.newPage()` would give each page its own context and therefore its own storage, which makes the
  // first version of this test measure nothing at all: two isolated tabs agreeing perfectly.
  const context = await browser.newContext();
  const first = await context.newPage();
  await boot(first);

  // A second tab, opened before anything changes, so it holds a copy of the state from that moment.
  const second = await context.newPage();
  await boot(second);

  // Tab A creates a project. Tab B knows nothing about it.
  first.on("dialog", (dialog) => void dialog.accept("made in tab A"));
  await first.click("#new-project");
  await expect(first.locator("#project-select")).toContainText("made in tab A");

  // The hazard is a STALE VIEW, not a stale store: localStorage is shared, but tab B keeps its own copy of the map in memory and
  // only reads storage at boot. So B's picker does not offer A's project while storage already contains it.
  const bOffersA = ((await second.locator("#project-select").textContent()) ?? "").includes("made in tab A");

  // Tab B now saves its own state, which is the whole map as B remembers it.
  second.on("dialog", (dialog) => void dialog.accept("made in tab B"));
  await second.click("#new-project");
  // Proof the second tab really saved, so a dialog that silently returned null cannot look like a tab-collision result.
  await expect(second.locator("#project-select")).toContainText("made in tab B");

  const after = await first.evaluate(() => {
    const raw = localStorage.getItem("swc.projects.v1") ?? "{}";
    const parsed = JSON.parse(raw) as { projects?: { name?: string }[] };
    return (parsed.projects ?? []).map((project) => project.name ?? "");
  });

  console.log(
    `tab B offered tab A's project: ${bOffersA}; names in storage after B saved: ${JSON.stringify(after)}`,
  );

  // Measured, not endorsed: B saves the whole map as it remembers it, so A's project is dropped from storage without a warning to
  // either tab. The numbers go in the report; "it is lost" is deliberately NOT asserted, because pinning it as a passing
  // expectation would freeze a defect as the contract.
  expect(bOffersA).toBe(false);
  // What must hold either way: storage stays parseable and holds a project, so a tab collision degrades rather than bricks.
  expect(after.length).toBeGreaterThan(0);
  expect(after).toContain("made in tab B");

  await context.close();
});
