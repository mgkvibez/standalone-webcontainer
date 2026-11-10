import { describe, expect, it } from "vitest";
import { INDEX_KEY, ProjectStore, STORAGE_KEY, projectKey, type StorageLike } from "../../src/browser/projects.js";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  /** Counts writes per key, so a test can prove a save did not rewrite what did not change. */
  readonly writes = new Map<string, number>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
  }
  removeItem(key: string): void { this.values.delete(key); }
}

/** The preview ids as they actually sit in storage under the v2 layout, in index order. */
const readStoredPreviewIds = (storage: StorageLike): string[] => {
  const index = JSON.parse(storage.getItem(INDEX_KEY) ?? "{}") as { order?: string[] };
  return (index.order ?? []).map((id) => {
    const record = JSON.parse(storage.getItem(projectKey(id)) ?? "{}") as { project?: { previewId?: string } };
    return record.project?.previewId ?? "";
  });
};

describe("ProjectStore preview identity", () => {
  it("assigns unique opaque preview IDs and preserves them across reloads", () => {
    const storage = new MemoryStorage();
    const store = ProjectStore.load(storage);
    const firstId = store.active().previewId;
    const secondId = store.create("second").previewId;

    expect(firstId).toMatch(/^[a-f0-9]{32}$/);
    expect(secondId).toMatch(/^[a-f0-9]{32}$/);
    expect(secondId).not.toBe(firstId);
    expect(ProjectStore.load(storage).projects().map((project) => project.previewId)).toEqual([firstId, secondId]);
  });

  it("migrates older saved projects and repairs duplicate or invalid preview IDs", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      activeId: "project-2",
      projects: [
        { id: "project-1", name: "first", files: {}, dirs: [], updatedAt: 1 },
        { id: "project-2", previewId: "not-a-host-label", name: "second", files: {}, dirs: [], updatedAt: 2 },
        { id: "project-3", previewId: "a".repeat(32), name: "third", files: {}, dirs: [], updatedAt: 3 },
        { id: "project-4", previewId: "a".repeat(32), name: "fourth", files: {}, dirs: [], updatedAt: 4 },
      ],
    }));

    const store = ProjectStore.load(storage);
    const previewIds = store.projects().map((project) => project.previewId);
    expect(new Set(previewIds).size).toBe(4);
    expect(previewIds.every((id) => /^[a-f0-9]{32}$/.test(id))).toBe(true);
    // ADR-0017: migration writes the v2 layout and only then drops the legacy key, so the repaired ids have to be found through
    // the index and the per-project keys rather than in the old single key.
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(readStoredPreviewIds(storage)).toEqual(previewIds);
  });
});

/**
 * ADR-0017: one key per project, an index, and reconciliation with other tabs.
 *
 * These tests exist because the layout's whole purpose is two properties that a passing happy path does not show: a save costs
 * one project, and another tab's change reaches this tab instead of being overwritten by it.
 */
describe("ProjectStore persistence layout (ADR-0017)", () => {
  const loadWith = (storage: MemoryStorage, count: number): ProjectStore => {
    const store = ProjectStore.load(storage);
    for (let index = 1; index < count; index += 1) store.create(`project ${index + 1}`);
    return store;
  };

  it("rewrites one project's key when one project changes, not every project's", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 3);
    const [first, second] = store.projects();
    storage.writes.clear();

    store.renameProject(second!.id, "renamed");

    expect(storage.writes.get(projectKey(second!.id))).toBe(1);
    // The untouched project is not rewritten. This is the property the single-key layout could not have: every save cost the whole
    // map, so one large project pushed the others toward the quota.
    expect(storage.writes.get(projectKey(first!.id))).toBeUndefined();
    // The index is still written, because it is what names the projects and it is small.
    expect(storage.writes.get(INDEX_KEY)).toBe(1);
  });

  it("deletes the key of a removed project and stops naming it", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 2);
    const doomed = store.projects()[1]!;

    store.remove(doomed.id);

    expect(storage.getItem(projectKey(doomed.id))).toBeNull();
    expect(JSON.parse(storage.getItem(INDEX_KEY) ?? "{}").order).toEqual([store.projects()[0]!.id]);
  });

  it("reloads the projects and the selection from the v2 layout", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 2);
    store.switchTo(store.projects()[0]!.id);
    store.renameProject(store.projects()[0]!.id, "kept");

    const reloaded = ProjectStore.load(storage);

    expect(reloaded.projects().map((project) => project.name)).toEqual(store.projects().map((project) => project.name));
    expect(reloaded.activeId()).toBe(store.activeId());
    expect(reloaded.lastError).toBeNull();
  });

  it("keeps the readable projects when one project's stored record is corrupt", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 3);
    const broken = store.projects()[1]!;
    storage.setItem(projectKey(broken.id), "{not json");

    const reloaded = ProjectStore.load(storage);

    expect(reloaded.projects()).toHaveLength(2);
    // Loud, not silent: the page can say that something did not load.
    expect(reloaded.lastError).toMatch(/could not be read/);
  });

  it("adopts a project another tab added, and says so", () => {
    const storage = new MemoryStorage();
    const mine = loadWith(storage, 1);

    // Another tab, sharing the same storage, creates a project.
    const otherTab = ProjectStore.load(storage);
    const theirs = otherTab.create("from the other tab");

    // The storage event fires for the new project's key, then for the index (the index is written last, so that is the order a
    // reader sees). The project key alone is enough to adopt it, so the index pass then has nothing left to do: asserting `true`
    // there was my mistake, not the store's, and `false` is what "nothing changed" correctly looks like.
    expect(mine.handleExternalChange(projectKey(theirs.id))).toBe(true);
    expect(mine.handleExternalChange(INDEX_KEY)).toBe(false);

    expect(mine.projects().map((project) => project.name)).toContain("from the other tab");
    expect(mine.lastNotice).toMatch(/added in another tab/);
    // Selection is per tab: adopting another tab's project must not steal this tab's place.
    expect(mine.activeId()).toBe(mine.projects()[0]!.id);
  });

  it("adopts another tab's newer version of a project, and says so instead of losing it", () => {
    const storage = new MemoryStorage();
    const mine = loadWith(storage, 1);
    const id = mine.activeId();

    const otherTab = ProjectStore.load(storage);
    otherTab.renameProject(id, "renamed elsewhere");

    expect(mine.handleExternalChange(projectKey(id))).toBe(true);

    expect(mine.active().name).toBe("renamed elsewhere");
    expect(mine.lastNotice).toMatch(/changed in another tab/);
  });

  it("does nothing when the change it is told about is its own", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 1);
    // A tab does not receive its own storage events, and if it somehow did, re-reading its own value must be a no-op rather than a
    // notice or a re-render.
    expect(store.handleExternalChange(projectKey(store.activeId()))).toBe(false);
    expect(store.handleExternalChange(INDEX_KEY)).toBe(false);
    expect(store.lastNotice).toBeNull();
  });

  it("drops a project another tab deleted, but never the last one", () => {
    const storage = new MemoryStorage();
    const mine = loadWith(storage, 2);
    const otherTab = ProjectStore.load(storage);
    const victim = otherTab.projects()[1]!;
    otherTab.remove(victim.id);

    expect(mine.handleExternalChange(INDEX_KEY)).toBe(true);
    expect(mine.projects().map((project) => project.id)).not.toContain(victim.id);
    expect(mine.lastNotice).toMatch(/deleted in another tab/);

    // The other tab deletes everything it can. This tab must still hold a project, because a page with none cannot run or save.
    const lastGone = ProjectStore.load(storage);
    while (lastGone.projects().length > 1) lastGone.remove(lastGone.projects()[1]!.id);
    mine.handleExternalChange(INDEX_KEY);
    expect(mine.projects().length).toBeGreaterThan(0);
  });

  it("keeps a project number free by looking at the ids present, not at how many there are", () => {
    const storage = new MemoryStorage();
    const store = loadWith(storage, 3);
    store.remove(store.projects()[1]!.id);
    const created = store.create("after removal");

    // Counting would have produced project-3 here, which already exists, overwriting that project's key.
    const ids = store.projects().map((project) => project.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(created.id);
  });
});
