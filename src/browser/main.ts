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
import { bootRegistryLane, createProductRegistry } from "./registry.js";

const store = ProjectStore.load(window.localStorage);
const runtime = new WorkerRuntimeClient();
window.addEventListener("beforeunload", () => runtime.dispose(), { once: true });
// The lane comes from the URL: the real npm registry by default, the committed corpus only when asked for by name.
const registry = await createProductRegistry(bootRegistryLane(window.location.search));
const container = new Container({ runtime, files: store.filesFor(), registry });
const session = container.createSession("main");

const workspace = createWorkspace({
  store,
  container,
  runtime,
  initialSessionId: session.id,
});

// A reload leaves the page with its files and its lockfile but no installed tree, because node_modules lives in the container's memory rather
// than in project storage (ADR-0027's quota is why). Rebuilding it from the lockfile is the recovery step, and doing it here - before the user
// types anything - is what makes `npm run dev` work on a project that was last touched in another session.
void workspace.restoreDependencies();

// Exposed for the browser tests and for anyone debugging in devtools. Not a public API.
Object.assign(window as unknown as Record<string, unknown>, {
  __workspace: workspace,
  __store: store,
  __container: container,
  __runtime: runtime,
  __registry: registry,
});
