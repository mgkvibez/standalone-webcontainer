/**
 * Projects: the page's copy of the truth.
 *
 * The Worker holds a VFS only for the duration of one run; the page owns the files. That split is what makes persistence,
 * project isolation and host restarts possible at once: a killed Worker loses nothing, and a run can never see another
 * project's files because the host is reseeded from exactly one project's map each time.
 *
 * Storage is `localStorage`, synchronously: one key per project, plus a small index key naming the projects and the active one.
 * That split is ADR-0027, and it exists because of two measured failures of the single-key layout (docs/audit/persistence-limits.md):
 * a save rewrote every project, so one large project could exhaust the quota for all of them, and two tabs each rewrote the whole
 * map from their own stale copy, silently deleting each other's projects.
 *
 * Two rules keep the new layout honest:
 *
 * - the index is written LAST, so another tab can never see an index naming a project whose own key is not on disk yet;
 * - only projects whose serialized content actually changed are rewritten, so a save costs what the edit cost.
 *
 * A quota or privacy-mode failure is still reported upward rather than swallowed, and so is a change made by another tab: losing
 * someone's project silently is the worst possible outcome here.
 */

import type { ProjectFiles } from "../container/types.js";

export interface Project {
  readonly id: string;
  /** Opaque, stable DNS label for the future project-isolated preview origin. */
  readonly previewId: string;
  name: string;
  files: Record<string, string>;
  /** Explicitly created directories, including empty ones. Directories implied by file paths are derived. */
  dirs: string[];
  updatedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /**
   * Optional because a `StorageLike` need not be localStorage. Without it a removed project's key is left behind rather than
   * deleted: wasteful, never incorrect, since the index is what decides which projects exist.
   */
  removeItem?(key: string): void;
}

/** Legacy single-key layout. Read once to migrate, never written again. */
export const STORAGE_KEY = "swc.projects.v1";

/** The index: which projects exist and which one this tab had selected. Small enough to rewrite on every save. */
export const INDEX_KEY = "swc.projects.v2.index";

/** One project per key, so a save is proportional to the project that changed. */
export const PROJECT_KEY_PREFIX = "swc.projects.v2.project.";

export const projectKey = (id: string): string => `${PROJECT_KEY_PREFIX}${id}`;

interface StoredIndex {
  readonly version: 2;
  readonly activeId: string;
  readonly order: readonly string[];
}

interface StoredProject {
  readonly version: 2;
  readonly project: Project;
}

interface StoredState {
  readonly version: 1;
  readonly activeId: string;
  readonly projects: readonly Project[];
}

const SEED_INDEX = `// Welcome to the container. Press Run, or type "node index.js" in the terminal.
const fs = require("fs");

fs.writeFileSync("/hello.txt", "written by the runtime\\n");
console.log("read back:", fs.readFileSync("/hello.txt", "utf8").trim());
console.log("argv:", process.argv.join(" "));

let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  console.log("tick", ticks);
  if (ticks === 2) clearInterval(timer);
}, 5);

console.log("this line runs before the timer queue drains");
`;

const SEED_MANIFEST = `${JSON.stringify({ name: "playground", version: "1.0.0", private: true }, null, 2)}\n`;

function newPreviewId(used = new Set<string>()): string {
  let id: string;
  do {
    id = globalThis.crypto.randomUUID().replaceAll("-", "").toLowerCase();
  } while (used.has(id));
  return id;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The save reached both keys, but another tab wrote the index at the same time and the list could not be confirmed. */
const UNCONFIRMED_INDEX = "saved, but another tab wrote the project list at the same time; reload if a project is missing";

/**
 * A project id that cannot collide with one another tab chooses.
 *
 * Numbered ids were derived from the ids a tab could see, so two tabs creating a project in the same instant both picked
 * `project-4`: the later write replaced the earlier project outright, key and all. A random id removes that class by
 * construction, and it costs one `crypto.randomUUID` that is already used for preview ids. The loop guards the impossible
 * case (a candidate that is already in memory) rather than a likely one.
 */
const mintProjectId = (used: ReadonlySet<string>): string => {
  let id: string;
  do {
    id = `project-${globalThis.crypto.randomUUID().replaceAll("-", "").toLowerCase()}`;
  } while (used.has(id));
  return id;
};

/**
 * The next free default name, derived from the names present.
 *
 * A numbered id used to supply this (`project 2` for `project-2`), which no longer exists now that ids are random. Names are
 * display-only, so the first unused number is enough; duplicate names were already possible through `renameProject`.
 */
const nextDefaultName = (projects: readonly Project[]): string => {
  const used = new Set(projects.map((project) => project.name));
  let number = 1;
  while (used.has(`project ${number}`)) number += 1;
  return `project ${number}`;
};

const describeRemoved = (removed: readonly Project[]): string =>
  removed.length === 1 ? (removed[0]?.name ?? "a project") : `${removed.length} projects`;

const seedProject = (): Project => ({
  id: "project-1",
  previewId: newPreviewId(),
  name: "playground",
  files: { "/index.js": SEED_INDEX, "/package.json": SEED_MANIFEST },
  dirs: [],
  updatedAt: Date.now(),
});

export class ProjectStore {
  readonly #storage: StorageLike;
  #projects: Project[];
  #activeId: string;
  #lastError: string | null = null;
  #lastNotice: string | null = null;
  /**
   * What each project's key was last written with, so `persist` can skip unchanged projects. Keyed by project id; the value is
   * the project's own serialization, not the whole file, so a comparison is a string compare with no re-serialisation.
   */
  #written = new Map<string, string>();
  /**
   * Projects this tab deleted whose removal the index does not reflect yet. Adoption reads the index, which still names them, so
   * without this a save would read its own pending deletion back and resurrect the project it just removed.
   */
  readonly #removed = new Set<string>();

  private constructor(storage: StorageLike, projects: Project[], activeId: string) {
    this.#storage = storage;
    this.#projects = projects;
    this.#activeId = activeId;
  }

  /**
   * Build the store from storage, preferring the v2 layout and migrating the v1 single key once.
   *
   * Every read path is a fallback chain ending in a fresh project with an error recorded: corrupt or unreadable storage must
   * never brick the page, but it must also never look like a clean start.
   */
  static load(storage: StorageLike): ProjectStore {
    const v2 = ProjectStore.#loadV2(storage);
    if (v2 !== null) return v2;

    const legacy = ProjectStore.#loadLegacy(storage);
    if (legacy !== null) {
      // Write the v2 layout before dropping the v1 key. If the write fails, the legacy key stays as the only copy.
      legacy.persist();
      if (legacy.lastError === null && storage.removeItem !== undefined) storage.removeItem(STORAGE_KEY);
      return legacy;
    }

    const fresh = ProjectStore.#loadV2(storage);
    if (fresh !== null) return fresh;
    const project = seedProject();
    const store = new ProjectStore(storage, [project], project.id);
    store.persist();
    return store;
  }

  /** The v2 layout, or null when there is nothing readable there. */
  static #loadV2(storage: StorageLike): ProjectStore | null {
    let rawIndex: string | null;
    try {
      rawIndex = storage.getItem(INDEX_KEY);
    } catch (error) {
      const project = seedProject();
      const store = new ProjectStore(storage, [project], project.id);
      store.#lastError = `storage is unavailable: ${describeError(error)}`;
      return store;
    }
    if (rawIndex === null) return null;

    try {
      const index = JSON.parse(rawIndex) as StoredIndex;
      if (index.version !== 2 || !Array.isArray(index.order)) throw new Error("bad index shape");
      const projects: Project[] = [];
      for (const id of index.order) {
        if (typeof id !== "string") continue;
        // Per project, not around the loop: one corrupt record must cost that project, not every project after it. The first
        // version of this caught the whole loop and a single bad key silently reseeded the workspace.
        try {
          const raw = storage.getItem(projectKey(id));
          if (raw === null) continue;
          const parsed = JSON.parse(raw) as StoredProject;
          if (parsed.version !== 2 || typeof parsed.project !== "object" || parsed.project === null) continue;
          projects.push(parsed.project);
        } catch {
          continue;
        }
      }
      if (projects.length === 0) return null;
      const activeId = projects.some((project) => project.id === index.activeId) ? index.activeId : projects[0]!.id;
      const store = new ProjectStore(storage, projects, activeId);
      // Nothing has been written by THIS store yet, so the first save must not skip projects it did not write.
      store.#written.clear();
      if (projects.length !== index.order.length) {
        store.#lastError = "some saved projects could not be read; the rest were loaded";
      }
      return store;
    } catch {
      return null;
    }
  }

  /** The legacy single key, migrated in memory; null when there is nothing readable there. */
  static #loadLegacy(storage: StorageLike): ProjectStore | null {
    let raw: string | null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredState;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length === 0) throw new Error("bad shape");
      const activeId = parsed.projects.some((project) => project.id === parsed.activeId)
        ? parsed.activeId
        : (parsed.projects[0]?.id ?? "project-1");
      const usedPreviewIds = new Set<string>();
      const projects = parsed.projects.map((project) => {
        const previewId = typeof project.previewId === "string" && /^[a-f0-9]{32}$/.test(project.previewId) &&
            !usedPreviewIds.has(project.previewId)
          ? project.previewId
          : newPreviewId(usedPreviewIds);
        usedPreviewIds.add(previewId);
        return { ...project, previewId };
      });
      return new ProjectStore(storage, projects, activeId);
    } catch {
      // Corrupt storage must not brick the app: start fresh and say so.
      const project = seedProject();
      const store = new ProjectStore(storage, [project], project.id);
      store.#lastError = "saved workspace could not be read; started a fresh project";
      return store;
    }
  }

  /** The last persistence failure, if any. The UI shows it; nothing is dropped on the floor. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** The last change made by another tab, if any. Shown where saves are reported, because it is the same question. */
  get lastNotice(): string | null {
    return this.#lastNotice;
  }

  /** A local edit answers the notice: the state the notice described has been superseded by the user's own change. */
  #clearNotice(): void {
    this.#lastNotice = null;
  }

  projects(): readonly Project[] {
    return this.#projects;
  }

  active(): Project {
    const project = this.#projects.find((candidate) => candidate.id === this.#activeId);
    if (project === undefined) throw new Error(`active project ${this.#activeId} is missing`);
    return project;
  }

  activeId(): string {
    return this.#activeId;
  }

  switchTo(id: string): void {
    if (!this.#projects.some((project) => project.id === id)) return;
    this.#activeId = id;
    this.persist();
  }

  create(name: string): Project {
    const project: Project = {
      id: mintProjectId(new Set(this.#projects.map((existing) => existing.id))),
      previewId: newPreviewId(new Set(this.#projects.map((existing) => existing.previewId))),
      name: name.trim() === "" ? nextDefaultName(this.#projects) : name.trim(),
      files: { "/index.js": 'console.log("hello from a new project");\n' },
      dirs: [],
      updatedAt: Date.now(),
    };
    this.#projects.push(project);
    this.#activeId = project.id;
    this.persist();
    return project;
  }

  renameProject(id: string, name: string): void {
    const project = this.#projects.find((candidate) => candidate.id === id);
    if (project === undefined || name.trim() === "") return;
    project.name = name.trim();
    this.persist();
  }

  remove(id: string): void {
    if (this.#projects.length <= 1) return;
    if (!this.#projects.some((project) => project.id === id)) return;
    this.#removed.add(id);
    this.#projects = this.#projects.filter((project) => project.id !== id);
    if (this.#activeId === id) this.#activeId = this.#projects[0]?.id ?? this.#activeId;
    this.persist();
  }

  // ---------------------------------------------------------------- files

  readFile(path: string): string | null {
    return this.active().files[path] ?? null;
  }

  writeFile(path: string, contents: string): void {
    const project = this.active();
    project.files[path] = contents;
    project.updatedAt = Date.now();
    this.persist();
  }

  createFile(path: string, contents = ""): void {
    const project = this.active();
    if (project.files[path] !== undefined) return;
    project.files[path] = contents;
    project.updatedAt = Date.now();
    this.persist();
  }

  mkdir(path: string): boolean {
    const project = this.active();
    if (project.dirs.includes(path) || this.listDirs().includes(path)) return false;
    project.dirs = [...project.dirs, path];
    project.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** Delete a file, or an empty directory. Refuses a non-empty directory rather than recursing. */
  delete(path: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const project = this.active();
    if (project.files[path] !== undefined) {
      delete project.files[path];
      project.updatedAt = Date.now();
      this.persist();
      return { ok: true };
    }
    if (project.dirs.includes(path)) {
      const populated =
        Object.keys(project.files).some((file) => file.startsWith(`${path}/`)) ||
        project.dirs.some((dir) => dir.startsWith(`${path}/`));
      if (populated) return { ok: false, reason: "directory is not empty" };
      project.dirs = project.dirs.filter((dir) => dir !== path);
      project.updatedAt = Date.now();
      this.persist();
      return { ok: true };
    }
    return { ok: false, reason: "no such file or directory" };
  }

  renamePath(from: string, to: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const project = this.active();
    const contents = project.files[from];
    if (contents !== undefined) {
      if (project.files[to] !== undefined) return { ok: false, reason: "target already exists" };
      delete project.files[from];
      project.files[to] = contents;
      project.updatedAt = Date.now();
      this.persist();
      return { ok: true };
    }
    if (project.dirs.includes(from)) {
      if (project.dirs.includes(to)) return { ok: false, reason: "target already exists" };
      project.dirs = project.dirs.map((dir) => (dir === from ? to : dir));
      for (const path of Object.keys(project.files)) {
        if (path.startsWith(`${from}/`)) {
          const moved = `${to}${path.slice(from.length)}`;
          const fileContents = project.files[path] ?? "";
          delete project.files[path];
          project.files[moved] = fileContents;
        }
      }
      project.updatedAt = Date.now();
      this.persist();
      return { ok: true };
    }
    return { ok: false, reason: "no such file or directory" };
  }

  listFiles(): readonly string[] {
    return Object.keys(this.active().files).sort();
  }

  listDirs(): readonly string[] {
    const project = this.active();
    const dirs = new Set<string>(project.dirs);
    for (const path of Object.keys(project.files)) {
      const parts = path.split("/").filter((part) => part !== "");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        dirs.add(current);
      }
    }
    return [...dirs].sort();
  }

  /** The `ProjectFiles` view the container's file commands use. Same data, no second filesystem. */
  filesFor(): ProjectFiles {
    const thisStore = this;
    return {
      get projectId() { return thisStore.activeId(); },
      list: () => this.listFiles(),
      listDirs: () => this.listDirs(),
      read: (path) => this.readFile(path),
      write: (path, contents) => this.writeFile(path, contents),
      mkdir: (path) => this.mkdir(path),
      remove: (path) => this.delete(path).ok,
    };
  }

  /** Serialise now. A storage failure is recorded for the UI and never thrown into a keystroke handler. */
  persist(): void {
    try {
      this.#clearNotice();
      // Before this save writes the index: pick up a project created elsewhere whose event has not arrived yet, so this write
      // does not replace the list with one that omits it.
      this.#adoptUnseenFromIndex();
      const live = new Set(this.#projects.map((project) => project.id));

      // Deleted projects: their keys go first, which frees the quota and makes the absence unambiguous to another tab (a project
      // left out of the list but still on disk is a lost list, not a deletion). `#removed` is the record of the intent: iterating
      // `#written` instead missed every project loaded from storage, whose record then survived a deletion forever.
      const gone = new Set<string>(this.#removed);
      for (const id of this.#written.keys()) if (!live.has(id)) gone.add(id);
      for (const id of gone) {
        this.#storage.removeItem?.(projectKey(id));
        this.#written.delete(id);
      }

      // Each project's key is rewritten only when that project's own content changed. A save therefore costs one project, not the
      // whole map, which is the point of the split: a large project no longer forces every other project through the quota.
      for (const project of this.#projects) {
        const serialized = JSON.stringify(project);
        if (this.#written.get(project.id) === serialized) continue;
        const record: StoredProject = { version: 2, project };
        this.#storage.setItem(projectKey(project.id), JSON.stringify(record));
        this.#written.set(project.id, serialized);
      }

      // Index LAST: another tab reading it must never find an id whose project key has not been written yet.
      const confirmed = this.#writeIndex();
      if (confirmed) this.#removed.clear();
      this.#lastError = confirmed ? null : UNCONFIRMED_INDEX;
    } catch (error) {
      this.#lastError = `could not save: ${describeError(error)}`;
    }
  }

  /**
   * Write the index, then read it back and repair it if another tab's save landed in between.
   *
   * The index is one key listing every project, so two saves that interleave their read and their write leave one tab's projects
   * out of the list: the later write replaces the whole order. That is not a number collision, it is a lost list, and reading
   * the index immediately before writing it closes only most of the window. Confirming after the write closes the rest: a tab
   * that lost the race sees its own id missing, adopts whatever the other tab added, and writes again.
   *
   * Three attempts, not a loop and not a lock: two tabs would have to lose every attempt in a row to still disagree, and a
   * bounded number keeps a storage object that lies (a fake, or a browser under a quota failure) from spinning a keystroke.
   */
  #writeIndex(): boolean {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const mine = this.#projects.map((project) => project.id);
      // Union, not replacement. A list arriving from storage may name a project this tab has not heard about yet, and its record
      // exists, so this write must not be the one that forgets it. An id whose record is gone is a deletion and is left out.
      const order = [...mine];
      for (const id of this.#readIndexOrder() ?? []) {
        if (order.includes(id)) continue;
        if (this.#readProject(id) === null) continue;
        order.push(id);
      }
      const index: StoredIndex = { version: 2, activeId: this.#activeId, order };
      this.#storage.setItem(INDEX_KEY, JSON.stringify(index));

      const stored = this.#readIndexOrder();
      // Unreadable or absent: the write itself succeeded, and there is nothing to compare against. Report the write, not a guess.
      if (stored === null) return true;
      const present = new Set(stored);
      if (mine.every((id) => present.has(id))) return true;
      this.#adoptUnseenFromIndex();
    }
    return false;
  }

  #readIndexOrder(): string[] | null {
    try {
      const raw = this.#storage.getItem(INDEX_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as StoredIndex;
      if (parsed.version !== 2 || !Array.isArray(parsed.order)) return null;
      return parsed.order.filter((id): id is string => typeof id === "string");
    } catch {
      return null;
    }
  }

  /**
   * Adopt projects another tab created whose `storage` event has not arrived here yet.
   *
   * `storage` events are asynchronous, so a save can run before this tab has heard about a project created a millisecond ago,
   * and the index it is about to write would omit that project. Additions only: dropping a project whose key is briefly missing
   * would risk destroying something a save failure left unsaved, while adopting one can only surface a project that exists.
   * Deletions stay the event's job, where they are already tested.
   */
  #adoptUnseenFromIndex(): void {
    const order = this.#readIndexOrder();
    if (order === null) return;
    const adopted: string[] = [];
    for (const id of order) {
      if (this.#removed.has(id)) continue;
      if (this.#projects.some((project) => project.id === id)) continue;
      const project = this.#readProject(id);
      if (project === null) continue;
      this.#projects.push(project);
      this.#written.set(project.id, JSON.stringify(project));
      adopted.push(project.name);
    }
    if (adopted.length === 1) this.#lastNotice = `${adopted[0]} added in another tab`;
    if (adopted.length > 1) this.#lastNotice = `${adopted.length} projects added in another tab`;
  }

  /**
   * Reconcile with a change another tab made. Returns whether anything changed here, which is when the page must re-render.
   *
   * `key` is the `StorageEvent.key` that fired: a project key, the index, or null for a full clear. Only the changed keys are
   * read, so the cost of another tab's edit is proportional to what it edited.
   *
   * The active project is deliberately NOT adopted from the index: selection is per tab, and two tabs taking turns over it would
   * fight. A tab only gives up its selection when that project no longer exists.
   */
  handleExternalChange(key: string | null): boolean {
    if (key === null) return this.#adoptIndex(true);
    if (key === INDEX_KEY) return this.#adoptIndex(false);
    if (key.startsWith(PROJECT_KEY_PREFIX)) return this.#adoptProject(key.slice(PROJECT_KEY_PREFIX.length));
    return false;
  }

  #adoptIndex(cleared: boolean): boolean {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(INDEX_KEY);
    } catch {
      return false;
    }
    if (raw === null) {
      if (!cleared) return false;
      // Another tab cleared storage. Keep working in memory and say so rather than pretending the projects are saved.
      this.#lastNotice = "saved workspace was cleared in another tab";
      this.#written.clear();
      return true;
    }
    let index: StoredIndex;
    try {
      index = JSON.parse(raw) as StoredIndex;
    } catch {
      return false;
    }
    if (index.version !== 2 || !Array.isArray(index.order)) return false;

    const wanted = new Set(index.order.filter((id): id is string => typeof id === "string"));
    let changed = false;

    // Projects another tab created: read their keys and add them.
    for (const id of wanted) {
      if (this.#projects.some((project) => project.id === id)) continue;
      const project = this.#readProject(id);
      if (project === null) continue;
      this.#projects.push(project);
      this.#written.set(project.id, JSON.stringify(project));
      changed = true;
    }

    // A project this tab holds but the arriving list does not name. The list is one key and a save replaces it whole, so absence
    // is ambiguous: either another tab deleted the project (which removes its own key) or a stale save wrote a list it did not know
    // about. The key decides. Without this the loser of a simultaneous create had its project dropped from memory by the arriving
    // list, which is the same loss in a quieter form.
    const orphaned: Project[] = [];
    const deleted: Project[] = [];
    const kept = this.#projects.filter((project) => {
      if (wanted.has(project.id)) return true;
      if (this.#readProject(project.id) !== null) {
        orphaned.push(project);
        return true;
      }
      deleted.push(project);
      return false;
    });
    if (deleted.length > 0 && kept.length > 0) {
      for (const project of deleted) this.#written.delete(project.id);
      this.#projects = kept;
      changed = true;
      this.#lastNotice = `${describeRemoved(deleted)} deleted in another tab`;
    }
    // Repair the list rather than accept it: the project's record is on disk and only the list lost track of it.
    if (orphaned.length > 0) {
      this.#writeIndex();
      changed = true;
      this.#lastNotice = `restored ${describeRemoved(orphaned)} to the saved list`;
    }

    if (!this.#projects.some((project) => project.id === this.#activeId) && this.#projects[0] !== undefined) {
      this.#activeId = this.#projects[0].id;
      changed = true;
    }
    return changed;
  }

  #adoptProject(id: string): boolean {
    const theirs = this.#readProject(id);
    if (theirs === null) return false;
    const mineIndex = this.#projects.findIndex((project) => project.id === id);
    if (mineIndex === -1) {
      this.#projects.push(theirs);
      this.#written.set(theirs.id, JSON.stringify(theirs));
      this.#lastNotice = `${theirs.name} added in another tab`;
      return true;
    }
    const mine = this.#projects[mineIndex]!;
    if (JSON.stringify(mine) === JSON.stringify(theirs)) return false;
    // Last write wins, per project: the other tab's save is the newer one, so it is adopted rather than merged. Saying so is the
    // part that matters, because the previous layout lost the same edit with no signal at all.
    this.#projects[mineIndex] = theirs;
    this.#written.set(theirs.id, JSON.stringify(theirs));
    this.#lastNotice = `${theirs.name} changed in another tab`;
    return true;
  }

  #readProject(id: string): Project | null {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(projectKey(id));
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredProject;
      if (parsed.version !== 2 || typeof parsed.project !== "object" || parsed.project === null) return null;
      return parsed.project;
    } catch {
      return null;
    }
  }

}
