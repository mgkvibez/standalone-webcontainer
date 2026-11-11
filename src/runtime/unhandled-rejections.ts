/**
 * Watches the host's unhandled promise rejections for the length of a run, so a program's can be reported as its own failure.
 *
 * The defect this exists for was measured, not imagined. vite's dev server called `process.exit(1)` inside an async continuation nobody
 * awaited; that rejection belonged to no promise this runtime was holding, so it escaped the program and landed on the host. In Node
 * (the fixture harness) it killed the process, and in a browser it would surface as the page's own unhandled rejection, which nothing
 * in the runtime can attribute to the program. Worse, the harness had already been told `exit 0` for a dev server that exited 1: the
 * only honest verdict in that shape was missing entirely.
 *
 * WHAT NODE DOES, copied deliberately: since Node 15 the default for an unhandled rejection is `throw`. The process prints the reason
 * and exits with code 1. Node only reaches that default because no listener is registered: registering one is what suppresses the crash,
 * which is exactly the escape hatch this needs. The rejection is therefore printed in the same shape as an uncaught exception and the
 * run ends with exit 1, rather than being swallowed or being left to kill the host.
 *
 * THE ATTRIBUTION IT RELIES ON, stated plainly because it is a limit and not a detail: this runtime does not own a JavaScript engine,
 * it borrows the host's. A rejection cannot be traced back to the promise that produced it, so "unhandled rejection observed during a
 * run" is treated as the program's. That holds because the supervisor runs one program at a time and the host is otherwise idle during
 * a run; it would not hold for two programs sharing a thread, which this runtime deliberately does not do.
 */
export interface RejectionWatch {
  /** Stop observing. Idempotent, and never leaves a listener behind: a leaked one would suppress the host's own crash reporting. */
  stop(): void;
}

type NodeProcessLike = {
  on?: (event: "unhandledRejection", listener: (reason: unknown) => void) => unknown;
  removeListener?: (event: "unhandledRejection", listener: (reason: unknown) => void) => unknown;
  off?: (event: "unhandledRejection", listener: (reason: unknown) => void) => unknown;
};

type RejectionEventLike = { reason: unknown; preventDefault?: () => void };
type EventTargetLike = {
  addEventListener?: (event: "unhandledrejection", listener: (event: RejectionEventLike) => void) => unknown;
  removeEventListener?: (event: "unhandledrejection", listener: (event: RejectionEventLike) => void) => unknown;
};

/**
 * Installs the observer and returns its stop handle.
 *
 * Node is preferred when it is present because the harness runs there; a browser has no `process.on`, so the page event is the fallback.
 * A host with neither gets a no-op handle rather than a thrown error: losing this observation degrades the verdict, it does not make the
 * runtime unusable, and refusing to boot over it would be a worse trade.
 */
export const watchUnhandledRejections = (onRejection: (reason: unknown) => void): RejectionWatch => {
  const hostProcess = (globalThis as { process?: NodeProcessLike }).process;
  if (typeof hostProcess?.on === "function") {
    const listener = (reason: unknown): void => onRejection(reason);
    hostProcess.on("unhandledRejection", listener);
    return {
      stop: () => {
        // `off` is Node's modern name and `removeListener` is the one every version has; either removes the same listener. Called
        // through `.call` because these are methods of the process object, and a detached reference loses `this` (which Node then
        // fails on with "Cannot read properties of undefined (reading '_events')").
        const remove = hostProcess.off ?? hostProcess.removeListener;
        if (remove !== undefined) remove.call(hostProcess, "unhandledRejection", listener);
      },
    };
  }

  const target = globalThis as EventTargetLike;
  if (typeof target.addEventListener === "function") {
    const listener = (event: RejectionEventLike): void => {
      // Keeps the browser from logging its own unhandled rejection AND continues the page: without this the browser's default action
      // is a console error, which reads like a runtime bug but is not one.
      event.preventDefault?.();
      onRejection(event.reason);
    };
    target.addEventListener("unhandledrejection", listener);
    return { stop: () => void target.removeEventListener?.("unhandledrejection", listener) };
  }

  return { stop: () => undefined };
};
