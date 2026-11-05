/**
 * Bootstrap: build the store, the container and the workspace, in that order.
 *
 * The page owns projects (localStorage) and the DOM; the Worker owns execution. The container sits between them and is the
 * only thing that knows both, which is why it takes the store's file view rather than the store itself.
 */

import "./styles.css";

import { Container } from "../container/container.js";
import { ProjectStore } from "./projects.js";
import { WorkerRuntimeClient } from "./worker-client.js";
import { createWorkspace } from "./workspace.js";
import { loadOfflineRegistry } from "./offline-registry.js";

const store = ProjectStore.load(window.localStorage);
const runtime = new WorkerRuntimeClient();
window.addEventListener("beforeunload", () => runtime.dispose(), { once: true });
const registry = await loadOfflineRegistry();
const container = new Container({ runtime, files: store.filesFor(), registry });
const session = container.createSession("main");

const workspace = createWorkspace({
  store,
  container,
  runtime,
  initialSessionId: session.id,
});

// Exposed for the browser tests and for anyone debugging in devtools. Not a public API.
Object.assign(window as unknown as Record<string, unknown>, {
  __workspace: workspace,
  __store: store,
  __container: container,
  __runtime: runtime,
});
