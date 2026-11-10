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
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";

import type { Container } from "../container/container.js";
import { basename, dirname } from "../container/commands.js";
import type { ProcessRecord, Session } from "../container/types.js";
import type { ProjectStore } from "./projects.js";
import type { WorkerRuntimeClient } from "./worker-client.js";
import { resolvePreviewOrigin } from "./preview-origin.js";
import { connectPreviewFrame } from "./preview-handshake.js";

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
  const terminalBody = element<HTMLDivElement>("terminal-body");
  const rawPane = element<HTMLDivElement>("raw-pane");
  const rawScreen = element<HTMLDivElement>("raw-screen");
  const processList = element<HTMLDivElement>("processes");
  const processSummary = element<HTMLSpanElement>("process-summary");
  const saveState = element<HTMLSpanElement>("save-state");
  const previewOverlay = element<HTMLElement>("preview-overlay");
  const previewFrame = element<HTMLIFrameElement>("preview-frame");
  const previewTitle = element<HTMLSpanElement>("preview-overlay-title");

  let activeSessionId = options.initialSessionId;
  let openPath: string | null = null;
  let selectedPath: string | null = null;
  let historyIndex = 0;
  let saveTimer: number | null = null;
  let previewCleanup: (() => void) | null = null;
  let previewAbort: AbortController | null = null;
  let activePreview: { readonly pid: number; readonly port: number } | null = null;
  let previewGeneration = 0;

  const closePreview = (): void => {
    previewGeneration += 1;
    previewAbort?.abort();
    previewAbort = null;
    previewCleanup?.();
    previewCleanup = null;
    activePreview = null;
    previewFrame.src = "about:blank";
    previewOverlay.hidden = true;
  };

  const openPreview = async (pid: number, port: number): Promise<void> => {
    closePreview();
    const generation = previewGeneration;
    let baseDomain = document.querySelector<HTMLMetaElement>('meta[name="preview-base-domain"]')?.content.trim();
    if (baseDomain === undefined || baseDomain === "") {
      window.alert("Preview hosting is not configured. Set the preview-base-domain meta value.");
      return;
    }
    if (baseDomain === "preview.localhost" && window.location.port !== "") baseDomain += `:${window.location.port}`;
    let origin: string;
    try {
      origin = resolvePreviewOrigin(store.active().previewId, { baseDomain, hostOrigin: window.location.origin });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      return;
    }
    const abort = new AbortController();
    previewAbort = abort;
    activePreview = { pid, port };
    previewTitle.textContent = `Process ${pid} · ${origin}`;
    previewOverlay.hidden = false;
    try {
      const cleanup = await connectPreviewFrame(previewFrame, options.runtime, origin, port, 10_000, abort.signal);
      if (generation !== previewGeneration) cleanup();
      else previewCleanup = cleanup;
    } catch (error) {
      if (generation !== previewGeneration) return;
      closePreview();
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      if (previewAbort === abort) previewAbort = null;
    }
  };

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
    // A change from another tab is reported in the same place as a save, because it is the same question: is what I am looking at
    // what is stored? "saved" would be a lie while another tab has just changed a project here.
    saveState.textContent = store.lastError ?? store.lastNotice ?? "saved";
    saveState.className = store.lastError !== null
      ? "error"
      : store.lastNotice !== null
      ? "notice"
      : "muted";
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

  /**
   * Raw mode: while a program owns the keyboard, an xterm.js pane replaces the line prompt.
   *
   * The prompt collects a whole line before anything runs, which is the right shape for `ls` and the wrong shape for a program
   * that asks a question. Rather than teach the prompt to stream (a line editor is exactly what readline does better), the pane
   * appears only while a process is alive and hands every keystroke straight to the program's stdin. There is no echo and no
   * erase handling here, because the runtime has no line discipline: the program sees the bytes the user typed.
   *
   * xterm.js is here for one reason: a terminal shows escape sequences as colours and layout, and hand-rolling that parser would
   * be a second emulator with its own bugs. It is given the program's raw stream from `container.onChunk`, not the scrollback,
   * because scrollback holds whole lines and would hide a prompt the program is waiting behind.
   */
  let raw: { term: XtermTerminal; fit: XtermFitAddon; sessionId: string; processId: number } | null = null;
  let fitting = false;
  let opening = false;

  /**
   * xterm.js is loaded the first time a program actually takes the keyboard.
   *
   * It is about a third of the page bundle, and most visits never open an interactive program, so paying for it at boot would be a
   * cost with no benefit. The editor is not deferred: it is on screen immediately.
   */
  const loadXterm = async (): Promise<{ Terminal: typeof XtermTerminal; FitAddon: typeof XtermFitAddon } | null> => {
    try {
      const [mod, fitMod] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      await import("@xterm/xterm/css/xterm.css");
      return { Terminal: mod.Terminal, FitAddon: fitMod.FitAddon };
    } catch (error) {
      // A failed chunk fetch must not eat the keystroke: the scrollback still shows the program's output.
      console.error("terminal pane failed to load", error);
      return null;
    }
  };

  const closeRaw = (): void => {
    if (raw === null) return;
    const { term } = raw;
    raw = null;
    term.dispose();
    rawScreen.replaceChildren();
    rawPane.hidden = true;
    terminalBody.classList.remove("raw");
    commandInput.focus();
  };

  const fitRaw = (): void => {
    if (raw === null || fitting) return;
    fitting = true;
    try {
      raw.fit.fit();
      // The program is told the size the pane actually rendered at, which is what makes process.stdout.columns true.
      if (raw.term.cols > 0 && raw.term.rows > 0) {
        container.resizeSession(raw.sessionId, raw.term.cols, raw.term.rows);
      }
    } finally {
      fitting = false;
    }
  };

  const openRaw = async (process: ProcessRecord): Promise<void> => {
    if (raw !== null || opening) return;
    opening = true;
    const loaded = await loadXterm();
    opening = false;
    // The program may have finished while the chunk was in flight, in which case there is nothing to type into.
    if (loaded === null || raw !== null) return;
    const running = container.running();
    if (running === undefined || running.pid !== process.pid) return;

    terminalBody.classList.add("raw");
    rawPane.hidden = false;

    const { Terminal, FitAddon } = loaded;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: getComputedStyle(document.body).fontFamily,
      scrollback: 2_000,
      theme: { background: "#00000000" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(rawScreen);
    raw = { term, fit, sessionId: process.sessionId, processId: process.pid };

    // Keystrokes go to the program, not to the prompt. `onData` fires for printable keys and for control characters alike,
    // which is what a program in raw mode expects to receive.
    term.onData((data) => {
      if (raw === null) return;
      container.write(raw.sessionId, data);
    });

    // Whatever the program has already printed (usually its first prompt) comes before the live stream.
    if (process.stdout !== "") term.write(process.stdout);
    if (process.stderr !== "") term.write(process.stderr);

    fitRaw();
    term.focus();
  };

  // A resize is the window's, not the program's: report it so the program hears SIGWINCH, and re-fit so the pane matches.
  const rawResize = new ResizeObserver(() => fitRaw());
  rawResize.observe(rawScreen);

  container.onChunk((event) => {
    if (raw === null || event.sessionId !== raw.sessionId) return;
    raw.term.write(event.text);
  });

  element<HTMLButtonElement>("raw-close").addEventListener("click", () => closeRaw());

  /** Follows the process table: the pane exists exactly as long as a program does. */
  const syncRawMode = (): void => {
    const running = container.running();
    if (running === undefined) {
      closeRaw();
      return;
    }
    if (raw === null) void openRaw(running);
    else if (raw.processId !== running.pid) {
      // A different program took the session: start its stream clean rather than mixing two programs' output.
      closeRaw();
      void openRaw(running);
    }
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
      if (process.state === "running" && process.previewPorts !== undefined) {
        for (const port of process.previewPorts) {
          const preview = document.createElement("button");
          preview.type = "button";
          preview.textContent = `preview ${port}`;
          preview.dataset["action"] = "preview";
          preview.addEventListener("click", () => void openPreview(process.pid, port));
          chip.append(preview);
        }
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
    syncRawMode();
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
    // A program owns the keyboard while the pane is open, so a stray Enter (xterm not yet focused, focus moved by a click) must
    // not submit the hidden prompt and start a second program on top of the first. That failure looked like a pane that refused to
    // close, because the program it restarted was waiting for input of its own.
    if (raw !== null) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const line = commandInput.value;
    commandInput.value = "";
    void runLine(line);
  });

  container.onChange(() => {
    if (activePreview !== null) {
      const previewProcess = container.processes().find((process) => process.pid === activePreview?.pid);
      if (previewProcess?.state !== "running" || !previewProcess.previewPorts?.includes(activePreview.port)) closePreview();
    }
    renderScrollback();
    renderProcesses();
    renderSessions();
    // Never inside `refresh`: a running program reports changes mid-run, and that is exactly when the pane must appear.
    syncRawMode();
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
    closePreview();
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

  element<HTMLButtonElement>("close-preview").addEventListener("click", closePreview);

  window.addEventListener("beforeunload", () => {
    if (openPath !== null) store.writeFile(openPath, view.state.doc.toString());
  });

  const first = store.listFiles()[0];
  if (first !== undefined) openFile(first);
  refresh();
  commandInput.focus();

  // Another tab changed storage. Reconcile, then re-render.
  //
  // Without this listener the measured failure was silent data loss: each tab held the whole map, read storage only at boot, and
  // rewrote it from its own stale copy, so the second tab to save deleted the first tab's project with no notice to either
  // (docs/audit/persistence-limits.md). ADR-0017 splits the map per project and adds this listener, so a change now arrives here
  // instead of being overwritten.
  window.addEventListener("storage", (event) => {
    const wasActive = store.activeId();
    if (!store.handleExternalChange(event.key)) return;

    // If this tab's project was the one removed, the editor is showing a project that no longer exists. Fall back to "no file
    // open" rather than trying to keep a file from a project whose files are gone.
    if (store.activeId() !== wasActive) {
      openPath = null;
      openFileLabel.textContent = "no file open";
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    }
    refresh();
  });

  return {
    refresh,
    openFile,
    editorText: () => view.state.doc.toString(),
  };
}
