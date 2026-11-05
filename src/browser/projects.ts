/**
 * Projects: the page's copy of the truth.
 *
 * The Worker holds a VFS only for the duration of one run; the page owns the files. That split is what makes persistence,
 * project isolation and host restarts possible at once: a killed Worker loses nothing, and a run can never see another
 * project's files because the host is reseeded from exactly one project's map each time.
 *
 * Storage is `localStorage`, synchronously, under one versioned key. A quota or privacy-mode failure is reported upward
 * rather than swallowed: losing someone's project silently is the worst possible outcome here.
 */

import type { ProjectFiles } from "../container/types.js";

export interface Project {
  readonly id: string;
  name: string;
  files: Record<string, string>;
  /** Explicitly created directories, including empty ones. Directories implied by file paths are derived. */
  dirs: string[];
  updatedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY = "swc.projects.v1";

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

const seedProject = (): Project => ({
  id: "project-1",
  name: "playground",
  files: { "/index.js": SEED_INDEX, "/package.json": SEED_MANIFEST },
  dirs: [],
  updatedAt: Date.now(),
});

export class ProjectStore {
  readonly #storage: StorageLike;
  #projects: Project[];
  #activeId: string;
  #nextId = 1;
  #lastError: string | null = null;

  private constructor(storage: StorageLike, projects: Project[], activeId: string) {
    this.#storage = storage;
    this.#projects = projects;
    this.#activeId = activeId;
    this.#nextId = projects.length + 1;
  }

  static load(storage: StorageLike): ProjectStore {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      const project = seedProject();
      const store = new ProjectStore(storage, [project], project.id);
      store.persist();
      return store;
    }
    try {
      const parsed = JSON.parse(raw) as StoredState;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length === 0) throw new Error("bad shape");
      const activeId = parsed.projects.some((project) => project.id === parsed.activeId)
        ? parsed.activeId
        : (parsed.projects[0]?.id ?? "project-1");
      return new ProjectStore(storage, [...parsed.projects], activeId);
    } catch {
      // Corrupt storage must not brick the app: start fresh and say so.
      const project = seedProject();
      const store = new ProjectStore(storage, [project], project.id);
      store.#lastError = "saved workspace could not be read; started a fresh project";
      store.persist();
      return store;
    }
  }

  /** The last persistence failure, if any. The UI shows it; nothing is dropped on the floor. */
  get lastError(): string | null {
    return this.#lastError;
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
    const id = `project-${this.#nextId++}`;
    const project: Project = {
      id,
      name: name.trim() === "" ? `project ${this.#nextId - 1}` : name.trim(),
      files: { "/index.js": 'console.log("hello from a new project");\n' },
      dirs: [],
      updatedAt: Date.now(),
    };
    this.#projects.push(project);
    this.#activeId = id;
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
    return {
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
    const state: StoredState = { version: 1, activeId: this.#activeId, projects: this.#projects };
    try {
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(state));
      this.#lastError = null;
    } catch (error) {
      this.#lastError = `could not save: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
