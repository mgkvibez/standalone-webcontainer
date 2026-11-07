/**
 * The workspace: explorer, editor, terminal and process list, wired to the container.
 *
 * The DOM is rebuilt from state on every change (`refresh`) rather than patched surgically. With a few dozen files and a
 * few hundred terminal lines that is both fast and impossible to desynchronise, and desynchronised UI is the failure mode
 * that makes an IDE feel broken.
 *
 * The editor is CodeMirror 6 (MIT). It edits the project store, which is the same store the container's file commands and
 * the Worker reseeding read from. There is exactly one copy of the files.
 */

import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

import type { Container } from "../container/container.js";
import { basename, dirname } from "../container/commands.js";
import type { ProcessRecord, Session } from "../container/types.js";
import type { ProjectStore } from "./projects.js";
import type { WorkerRuntimeClient } from "./worker-client.js";

export interface WorkspaceOptions {
  readonly store: ProjectStore;
  readonly container: Container;
  readonly runtime: WorkerRuntimeClient;
  readonly initialSessionId: string;
}

export interface Workspace {
  refresh(): void;
  openFile(path: string): void;
  /** Exposed for the browser tests: current editor text, without going near CodeMirror internals. */
  editorText(): string;
}

const element = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
};

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { store, container } = options;

  const projectSelect = element<HTMLSelectElement>("project-select");
  const projectName = element<HTMLSpanElement>("project-name");
  const tree = element<HTMLUListElement>("tree");
  const openFileLabel = element<HTMLSpanElement>("open-file");
  const editorHost = element<HTMLDivElement>("editor");
  const sessionTabs = element<HTMLDivElement>("session-tabs");
  const scrollback = element<HTMLDivElement>("scrollback");
  const promptLabel = element<HTMLSpanElement>("prompt-label");
  const commandInput = element<HTMLInputElement>("command");
  const processList = element<HTMLDivElement>("processes");
  const processSummary = element<HTMLSpanElement>("process-summary");
  const saveState = element<HTMLSpanElement>("save-state");

  let activeSessionId = options.initialSessionId;
  let openPath: string | null = null;
  let selectedPath: string | null = null;
  let historyIndex = 0;
  let saveTimer: number | null = null;

  const session = (): Session => {
    const found = container.findSession(activeSessionId);
    if (found === undefined) throw new Error(`session ${activeSessionId} vanished`);
    return found;
  };

  const view = new EditorView({
    doc: "",
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        markDirty();
        scheduleSave();
      }),
    ],
    parent: editorHost,
  });

  const markDirty = (): void => {
    saveState.textContent = "unsaved";
    saveState.className = "dirty";
  };

  const markSaved = (): void => {
    saveState.textContent = store.lastError ?? "saved";
    saveState.className = store.lastError === null ? "muted" : "error";
  };

  const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      if (openPath === null) return;
      store.writeFile(openPath, view.state.doc.toString());
      markSaved();
      renderTree();
    }, 250);
  };

  // ---------------------------------------------------------------- project + tree

  const renderProjects = (): void => {
    projectSelect.replaceChildren();
    for (const project of store.projects()) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      option.selected = project.id === store.activeId();
      projectSelect.append(option);
    }
    projectName.textContent = store.active().name;
  };

  const pathEntries = (): Array<{ path: string; dir: boolean }> => {
    const entries: Array<{ path: string; dir: boolean }> = [];
    const dirs = store.listDirs();
    for (const dir of dirs) entries.push({ path: dir, dir: true });
    for (const file of store.listFiles()) entries.push({ path: file, dir: false });
    return entries.sort((left, right) => {
      const leftKey = left.dir ? `${left.path}/` : left.path;
      const rightKey = right.dir ? `${right.path}/` : right.path;
      return leftKey.localeCompare(rightKey);
    });
  };

  const renderTree = (): void => {
    tree.replaceChildren();
    for (const entry of pathEntries()) {
      const item = document.createElement("li");
      const depth = entry.path.split("/").filter((part) => part !== "").length;
      item.style.paddingLeft = `${8 + depth * 10}px`;
      item.textContent = entry.dir ? `${basename(entry.path)}/` : basename(entry.path);
      item.dataset["path"] = entry.path;
      item.dataset["kind"] = entry.dir ? "dir" : "file";
      if (entry.dir) item.className = "dir";
      if (entry.path === openPath) item.classList.add("active");
      item.addEventListener("click", () => {
        selectedPath = entry.path;
        if (!entry.dir) openFile(entry.path);
        renderTree();
      });
      tree.append(item);
    }
  };

  const openFile = (path: string): void => {
    const contents = store.readFile(path);
    if (contents === null) return;
    openPath = path;
    selectedPath = path;
    openFileLabel.textContent = path;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contents } });
    markSaved();
    renderTree();
  };

  // ---------------------------------------------------------------- terminal

  const renderScrollback = (): void => {
    const current = session();
    const fragment = document.createDocumentFragment();
    for (const line of current.scrollback) {
      const node = document.createElement("span");
      node.className = `line ${line.stream}`;
      node.dataset["stream"] = line.stream;
      node.textContent = line.text;
      fragment.append(node);
    }
    scrollback.replaceChildren(fragment);
    scrollback.scrollTop = scrollback.scrollHeight;
  };

  const renderSessions = (): void => {
    sessionTabs.replaceChildren();
    for (const candidate of container.sessions()) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `session-tab${candidate.id === activeSessionId ? " active" : ""}`;
      tab.textContent = candidate.name;
      tab.dataset["session"] = candidate.id;
      tab.addEventListener("click", () => {
        activeSessionId = candidate.id;
        historyIndex = candidate.history.length;
        refresh();
        commandInput.focus();
      });
      sessionTabs.append(tab);
    }
  };

  const renderProcesses = (): void => {
    const processes = container.processes();
    processList.replaceChildren();
    for (const process of processes) {
      const chip = document.createElement("span");
      chip.className = `process-chip ${process.state}`;
      chip.dataset["pid"] = String(process.pid);
      chip.dataset["state"] = process.state;
      chip.append(`${process.pid} ${process.state} ${process.command}`);

      if (process.state === "running" || process.state === "queued") {
        const kill = document.createElement("button");
        kill.type = "button";
        kill.textContent = "stop";
        kill.dataset["action"] = "stop";
        kill.addEventListener("click", () => {
          container.terminate(process.pid);
        });
        chip.append(kill);
      }
      processList.append(chip);
    }

    const running = processes.filter(
      (process: ProcessRecord) => process.state === "running" || process.state === "queued",
    ).length;
    processSummary.textContent =
      processes.length === 0 ? "no processes" : `${processes.length} process(es), ${running} active`;
  };

  const refresh = (): void => {
    renderProjects();
    renderTree();
    renderSessions();
    renderScrollback();
    renderProcesses();
    promptLabel.textContent = `${session().cwd} $`;
    markSaved();
  };

  // ---------------------------------------------------------------- commands

  const runLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    historyIndex = session().history.length + 1;
    await container.execute(activeSessionId, trimmed);
    refresh();
  };

  commandInput.addEventListener("keydown", (event) => {
    const history = session().history;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      historyIndex = Math.max(0, Math.min(historyIndex - 1, history.length - 1));
      commandInput.value = history[historyIndex] ?? "";
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (history.length === 0) return;
      historyIndex = Math.min(history.length, historyIndex + 1);
      commandInput.value = history[historyIndex] ?? "";
    }
  });

  element<HTMLFormElement>("prompt").addEventListener("submit", (event) => {
    event.preventDefault();
    const line = commandInput.value;
    commandInput.value = "";
    void runLine(line);
  });

  container.onChange(() => {
    renderScrollback();
    renderProcesses();
    renderSessions();
  });

  // ---------------------------------------------------------------- topbar + explorer actions

  element<HTMLButtonElement>("run-file").addEventListener("click", () => {
    const target = openPath ?? "/index.js";
    if (store.readFile(target) === null) {
      void runLine("ls");
      return;
    }
    void runLine(`node ${target}`);
    commandInput.focus();
  });

  element<HTMLButtonElement>("new-session").addEventListener("click", () => {
    const created = container.createSession();
    activeSessionId = created.id;
    refresh();
    commandInput.focus();
  });

  element<HTMLButtonElement>("new-project").addEventListener("click", () => {
    const name = window.prompt("Project name", `project ${store.projects().length + 1}`);
    if (name === null) return;
    store.create(name);
    openPath = null;
    openFileLabel.textContent = "no file open";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    openFile("/index.js");
    refresh();
  });

  element<HTMLButtonElement>("rename-project").addEventListener("click", () => {
    const name = window.prompt("Rename project", store.active().name);
    if (name === null) return;
    store.renameProject(store.activeId(), name);
    refresh();
  });

  projectSelect.addEventListener("change", () => {
    store.switchTo(projectSelect.value);
    openPath = null;
    openFileLabel.textContent = "no file open";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    const first = store.listFiles()[0];
    if (first !== undefined) openFile(first);
    refresh();
  });

  const parentOfSelected = (): string => {
    if (selectedPath === null) return session().cwd === "/" ? "/" : session().cwd;
    return dirname(selectedPath) === "/" ? "/" : dirname(selectedPath);
  };

  element<HTMLButtonElement>("new-file").addEventListener("click", () => {
    const name = window.prompt("New file path", `${parentOfSelected() === "/" ? "" : `${parentOfSelected()}/`}untitled.js`);
    if (name === null) return;
    const path = name.startsWith("/") ? name : `${parentOfSelected() === "/" ? "" : parentOfSelected()}${name}`;
    store.createFile(path, "");
    openFile(path);
    refresh();
  });

  element<HTMLButtonElement>("new-dir").addEventListener("click", () => {
    const name = window.prompt("New directory path", `${parentOfSelected() === "/" ? "" : `${parentOfSelected()}/`}src`);
    if (name === null) return;
    const path = name.startsWith("/") ? name : `${parentOfSelected() === "/" ? "" : parentOfSelected()}${name}`;
    store.mkdir(path);
    refresh();
  });

  element<HTMLButtonElement>("rename-entry").addEventListener("click", () => {
    if (selectedPath === null) return;
    const next = window.prompt("Rename to", selectedPath);
    if (next === null || next === selectedPath) return;
    const result = store.renamePath(selectedPath, next.startsWith("/") ? next : `/${next}`);
    if (!result.ok) {
      window.alert(`Rename failed: ${result.reason}`);
      return;
    }
    if (openPath === selectedPath) openFile(next.startsWith("/") ? next : `/${next}`);
    selectedPath = next.startsWith("/") ? next : `/${next}`;
    refresh();
  });

  element<HTMLButtonElement>("delete-entry").addEventListener("click", () => {
    if (selectedPath === null) return;
    const result = store.delete(selectedPath);
    if (!result.ok) {
      window.alert(`Delete failed: ${result.reason}`);
      return;
    }
    if (openPath === selectedPath) {
      openPath = null;
      openFileLabel.textContent = "no file open";
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    }
    selectedPath = null;
    refresh();
  });

  window.addEventListener("beforeunload", () => {
    if (openPath !== null) store.writeFile(openPath, view.state.doc.toString());
  });

  const first = store.listFiles()[0];
  if (first !== undefined) openFile(first);
  refresh();
  commandInput.focus();

  return {
    refresh,
    openFile,
    editorText: () => view.state.doc.toString(),
  };
}
