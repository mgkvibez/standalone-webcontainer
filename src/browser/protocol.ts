/**
 * The message protocol between the page and the runtime Worker.
 *
 * Deliberately a closed, typed set rather than a generic RPC: the page may ask for one thing (run this project) and the
 * Worker may answer with one of three things. A protocol that can express nothing else is the cheapest way to keep the
 * boundary honest while the product is one screen wide.
 *
 * Every message carries an `id`, because the page keeps a map of in-flight requests and a reply that cannot be matched
 * to a request is a leaked promise. `id` is also what lets a late reply after `worker.terminate()` be dropped rather
 * than applied to the next Worker's state.
 */

import type { SchedulerEvidence } from "../runtime/scheduler.js";

/** Where a run's files are written. One project in P1a, and the page does not get to choose otherwise. */
export const APP_ROOT = "/app";

/** The entry file a run executes unless the request names another. */
export const DEFAULT_ENTRY = `${APP_ROOT}/index.js`;

export interface RunRequest {
  readonly type: "run";
  readonly id: number;
  /** Path to contents. Written into the runtime's VFS before the run starts. */
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
  /**
   * `argv` as the script sees it. Present because fixture 7's contract is "a CLI honours argv", and hiding it would
   * make the smoke test less truthful than the thing it is testing.
   */
  readonly argv?: readonly string[];
  /** Bounds async gaps only. A synchronous infinite loop cannot be interrupted by this; only terminating the Worker can. */
  readonly timeoutMs?: number;
}

export interface PingRequest {
  readonly type: "ping";
  readonly id: number;
}

export type ClientMessage = RunRequest | PingRequest;

export interface RunResponse {
  readonly type: "result";
  readonly id: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Evidence from the runtime's own timer queue, carried through instead of thrown away (ADR-0013). */
  readonly scheduler: SchedulerEvidence;
}

/**
 * A failure the page must show, never swallow.
 *
 * `code` is what the page branches on; `message` is what a person reads. A run that throws inside the runtime is NOT
 * this: that comes back as a `result` with a non-zero exit code and the stack on stderr, because a program crashing is
 * an outcome, not a transport error.
 */
export interface FailureResponse {
  readonly type: "error";
  readonly id: number;
  readonly code: "BAD_REQUEST" | "RUNTIME_ERROR" | "WORKER_FAILURE";
  readonly message: string;
  readonly stack?: string;
}

export interface PongResponse {
  readonly type: "pong";
  readonly id: number;
  /** Which runtime lane answered, so the page can prove it is talking to ours and not something else. */
  readonly lane: "in-process";
}

export type ServerMessage = RunResponse | FailureResponse | PongResponse;

/** Narrowing helper for the page's `worker.onerror`, which has no message shape of its own. */
export function workerFailure(message: string): FailureResponse {
  return { type: "error", id: -1, code: "WORKER_FAILURE", message };
}
