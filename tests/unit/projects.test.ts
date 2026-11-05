import { describe, expect, it } from "vitest";
import { ProjectStore, STORAGE_KEY, type StorageLike } from "../../src/browser/projects.js";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

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
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").projects.map((project: { previewId: string }) => project.previewId))
      .toEqual(previewIds);
  });
});
