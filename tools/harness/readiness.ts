/**
 * Waiting for a server to be READY, which is a different fact from a process that is running (W-28).
 *
 * The distinction is measured, not rhetorical: through vite in this container the port is bound at ~1.1 s and the first request is
 * answered at ~5.1 s, so anything that treats "bound" as "ready" is wrong by four seconds. The only honest signal is a real request
 * that came back, so this asks the preview gateway over and over until a response arrives or the deadline expires, and returns the
 * count either way.
 *
 * What it will NOT do: treat a line of terminal output as readiness, or widen its own deadline. A caller that gives up gets
 * `ready: false` with the last error it saw, which is evidence; a caller that waits forever is a hang with no evidence at all.
 */

import type { HttpProbe } from "../../src/harness/assertions.js";

export interface ReadinessOptions {
  /** Ask the gateway for this URL. The same function a fixture's `http-*` assertion uses, so readiness and assertions agree. */
  readonly probe: (url: string) => Promise<HttpProbe>;
  readonly port: number;
  readonly deadlineMs: number;
  /** Between attempts. Short, because a dev server can bind and answer within the same second. */
  readonly intervalMs?: number;
}

export interface Readiness {
  readonly port: number;
  readonly ready: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly deadlineMs: number;
  readonly status?: number;
  readonly lastError?: string;
}

export async function awaitServerReady(options: ReadinessOptions): Promise<Readiness> {
  const started = Date.now();
  const intervalMs = options.intervalMs ?? 100;
  const url = `http://localhost:${options.port}/`;
  let attempts = 0;
  let lastError: string | undefined;
  let status: number | undefined;

  for (;;) {
    attempts += 1;
    try {
      const probe = await options.probe(url);
      // ANY status is readiness: a 404, a 500 or a 401 is a server that answered, and refusing to call that ready would turn a
      // fixture's own expectations into a harness fault. What is not ready is no answer at all.
      status = probe.status;
      return { port: options.port, ready: true, attempts, elapsedMs: Date.now() - started, deadlineMs: options.deadlineMs, status };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() - started + intervalMs > options.deadlineMs) {
      return {
        port: options.port,
        ready: false,
        attempts,
        elapsedMs: Date.now() - started,
        deadlineMs: options.deadlineMs,
        ...(status === undefined ? {} : { status }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
