/**
 * Where localStorage actually stops working, measured in a real browser.
 *
 * Persistence is `localStorage` today: synchronous, one versioned key, whole project map rewritten on every change. That choice is
 * cheap and it works, but three claims about it have never been measured, and the persistence decision (ADR-0027) should not be
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

/**
 * The two-tab behaviour AFTER ADR-0027.
 *
 * This test used to measure silent loss: tab B rewrote the whole map from its own stale copy and tab A's project vanished from
 * storage. Those numbers are kept in docs/audit/persistence-limits.md as the reason for the change. What is asserted now is the
 * behaviour the change was for, because a test that only prints a bad outcome does not stop it coming back.
 */
test("a project one tab creates reaches the other, and neither loses anything", async ({ browser }) => {
  // ONE context, two pages: `browser.newPage()` would give each page its own storage and the tabs would agree perfectly while
  // sharing nothing (that mistake is recorded in the audit doc).
  const context = await browser.newContext();
  const first = await context.newPage();
  await boot(first);
  const second = await context.newPage();
  await boot(second);

  first.on("dialog", (dialog) => void dialog.accept("made in tab A"));
  await first.click("#new-project");
  await expect(first.locator("#project-select")).toContainText("made in tab A");

  // The storage event carries it: tab B was holding a copy from before the change.
  await expect(second.locator("#project-select")).toContainText("made in tab A");
  await expect(second.locator("#save-state")).toHaveText(/added in another tab/);

  // Now the other tab saves too. Under the old layout this is where A's project disappeared.
  second.on("dialog", (dialog) => void dialog.accept("made in tab B"));
  await second.click("#new-project");
  await expect(second.locator("#project-select")).toContainText("made in tab B");

  const names = await first.evaluate(() => {
    const raw = localStorage.getItem("swc.projects.v2.index") ?? "{}";
    const index = JSON.parse(raw) as { order?: string[] };
    return (index.order ?? []).map((id) => {
      const record = JSON.parse(localStorage.getItem(`swc.projects.v2.project.${id}`) ?? "{}") as {
        project?: { name?: string };
      };
      return record.project?.name ?? "";
    });
  });
  console.log(`names in storage after both tabs saved: ${JSON.stringify(names)}`);

  // Both survive, which is the whole point: a save costs one project rather than the whole map.
  expect(names).toContain("made in tab A");
  expect(names).toContain("made in tab B");
  await expect(first.locator("#project-select")).toContainText("made in tab B");

  await context.close();
});

test("two tabs creating at the same instant both keep their project", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await boot(first);
  await boot(second);

  // Neither tab waits for the other's storage event, so both create from a list that predates the other's write. The index is a
  // single key naming every project, so the later save used to replace the whole order with one that did not know about the other
  // project: its key stayed on disk, named by nothing, and the project was gone on the next load.
  const create = (page: Page, name: string): Promise<string> =>
    page.evaluate((projectName) => {
      const store = (window as unknown as { __store: { create(name: string): { id: string } } }).__store;
      return store.create(projectName).id;
    }, name);

  const [idA, idB] = await Promise.all([create(first, "instant A"), create(second, "instant B")]);
  expect(new Set([idA, idB]).size).toBe(2);

  // Convergence is eventual, not instantaneous: the repair is driven by the storage event, which is asynchronous by design. The
  // promise is that the two tabs agree afterwards, so that is what is asserted, with a deadline rather than a snapshot.
  const names = (): Promise<string[]> =>
    first.evaluate(() => {
      const raw = localStorage.getItem("swc.projects.v2.index") ?? "{}";
      const index = JSON.parse(raw) as { order?: string[] };
      return (index.order ?? []).map((id) => {
        const record = JSON.parse(localStorage.getItem(`swc.projects.v2.project.${id}`) ?? "{}") as {
          project?: { name?: string };
        };
        return record.project?.name ?? "";
      });
    });

  await expect.poll(names, { timeout: 5000 }).toEqual(expect.arrayContaining(["instant A", "instant B"]));
  console.log(`names in storage after two simultaneous creates: ${JSON.stringify(await names())}`);

  // The claim that matters: a page that loads afterwards sees both, so neither project was orphaned.
  const third = await context.newPage();
  await boot(third);
  await expect(third.locator("#project-select")).toContainText("instant A");
  await expect(third.locator("#project-select")).toContainText("instant B");

  await context.close();
});

test("an edit to the same project in another tab is adopted and reported, not silently overwritten", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await boot(first);
  const second = await context.newPage();
  await boot(second);

  // Each tab edits the SAME project through the rename path, which is the realistic collision.
  first.on("dialog", (dialog) => void dialog.accept("renamed in tab A"));
  await first.click("#rename-project");
  await expect(second.locator("#project-select")).toContainText("renamed in tab A");

  // Last write wins per project, which is the documented rule; the part that matters is that the other tab is told.
  await expect(second.locator("#save-state")).toHaveText(/changed in another tab/);

  // Both tabs now show the same name, so they cannot drift apart while both stay open.
  await expect(first.locator("#project-select")).toContainText("renamed in tab A");
  await expect(second.locator("#project-select")).toContainText("renamed in tab A");

  await context.close();
});

test("migrates a workspace saved under the old single key, and keeps the projects", async ({ page }) => {
  await page.goto("/");
  // Seed the legacy layout exactly as an existing user would have it, then reload so the app boots against it.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "swc.projects.v1",
      JSON.stringify({
        version: 1,
        activeId: "project-2",
        projects: [
          {
            id: "project-1",
            previewId: "a".repeat(32),
            name: "old one",
            files: { "/index.js": 'console.log("from the old layout");\n' },
            dirs: [],
            updatedAt: 1,
          },
          {
            id: "project-2",
            previewId: "b".repeat(32),
            name: "old two",
            files: { "/index.js": 'console.log("second");\n' },
            dirs: [],
            updatedAt: 2,
          },
        ],
      }),
    );
  });
  await page.reload();

  // Both projects survive the migration, and the one that was active is still active.
  await expect(page.locator("#project-select")).toContainText("old one");
  await expect(page.locator("#project-select")).toContainText("old two");
  await expect(page.locator("#project-select")).toHaveValue("project-2");

  // The new layout is what is on disk now, and the legacy key is gone rather than left to be migrated twice.
  const migrated = await page.evaluate(() => ({
    legacy: localStorage.getItem("swc.projects.v1"),
    index: localStorage.getItem("swc.projects.v2.index"),
    second: localStorage.getItem("swc.projects.v2.project.project-2"),
  }));
  expect(migrated.legacy).toBeNull();
  expect(migrated.index).toContain("project-2");
  expect(migrated.second).toContain("second");

  // The migrated project still runs: migration that loads but breaks execution would be worse than no migration.
  await page.click("#run-file");
  await expect(page.locator("#scrollback")).toContainText("second", { timeout: 20_000 });
});
