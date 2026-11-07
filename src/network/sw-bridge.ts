/**
 * The bridge between a service worker and the page that owns the runtime.
 *
 * **Why this exists at all.** A service worker runs in a separate global scope with no shared memory, so
 * the `fetch` listener cannot call the page's `PreviewGateway`. It has to ask the page and wait for an
 * answer. That turns every preview request into a round trip across `postMessage`, which brings the exact
 * problems this codebase has been solving everywhere else: correlation, ordering, deadlines, and what
 * happens when the other side is gone.
 *
 * Both halves are written against a `send`/`reply` function rather than a `MessagePort`, so a test can wire
 * two instances together through a fake bus that reorders messages on purpose. A bridge that only works
 * when messages arrive in order is a bridge that fails under load.
 *
 * **The failure this is built to survive.** If no page client is awake, or the page navigated away, a
 * worker-side request would otherwise wait forever and the browser tab would spin. Every pending request
 * carries a deadline and is answered with 504 when it expires, and a reply arriving after that is dropped
 * rather than allowed to settle a request its caller has already abandoned.
 *
 * Message bodies are `Uint8Array` and survive structured cloning as-is. Transferring them instead would
 * avoid a copy, but transfer lists need care around reuse and this is already the slower path; a copy is
 * the honest trade (ADR-0005, D-12).
 */

import { RequestRegistry, RequestTimeoutError } from "./request-registry.js";
import type { PreviewGateway } from "./preview-gateway.js";
import type { WireResponse } from "../shims/http.js";

/** What the worker sends to the page. */
export interface PreviewRequestMessage {
  readonly type: "preview-request";
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** What the page sends back when a handler answered. */
export interface PreviewResponseMessage {
  readonly type: "preview-response";
  readonly id: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** What the page sends back when it could not answer at all. */
export interface PreviewErrorMessage {
  readonly type: "preview-error";
  readonly id: string;
  readonly message: string;
}

export type WorkerMessage = PreviewRequestMessage;
export type PageMessage = PreviewResponseMessage | PreviewErrorMessage;

function textResponse(statusCode: number, message: string): WireResponse {
  const body = new TextEncoder().encode(message);
  return {
    statusCode,
    statusMessage: "",
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length) },
    body,
  };
}

export interface WorkerSideOptions {
  /** Sends a message to the page. In a real worker this posts to the client that made the request. */
  readonly send: (message: PreviewRequestMessage) => void;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface WorkerSideProxy {
  /** Answer one intercepted request, asking the page for the result. */
  handle(request: { method: string; url: string; headers: Record<string, string>; body: Uint8Array }): Promise<WireResponse>;
  /** Feed a message from the page in. Unrelated or late messages are ignored. */
  receive(message: PageMessage): void;
  /** How many requests are waiting. */
  readonly pending: number;
  /** Fail everything, for the worker's `activate` or a teardown. */
  closeAll(): readonly string[];
}

/**
 * The worker half. It owns correlation and the deadline; it knows nothing about servers or ports.
 */
export function createWorkerSideProxy(options: WorkerSideOptions): WorkerSideProxy {
  const requests = new RequestRegistry<WireResponse>();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  let nextId = 1;

  return {
    async handle(request): Promise<WireResponse> {
      const id = `preview-${nextId++}`;
      const startedAt = now();
      // openWithId, not open: the id in the message is the one the page will echo back, so it must be the
      // id the registry is waiting on. Using open() here generates a second, private id and every reply
      // then settles nothing, which presents as a request that times out while the page answers fine.
      const pending = requests.openWithId(id, { deadline: startedAt + timeoutMs, now: startedAt });

      let timer: ReturnType<typeof setTimeout> | undefined;
      // The timer's only job is to make the registry look at the clock. `reap` rejects the waiting promise
      // itself, so the rejection below is belt-and-braces for the race window, not a second mechanism.
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          requests.reap(now());
          reject(new RequestTimeoutError(id, timeoutMs));
        }, timeoutMs);
      });

      try {
        options.send({ type: "preview-request", id, ...request });
        return await Promise.race([pending.settled, expiry]);
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          return textResponse(
            504,
            `The preview page did not answer within ${timeoutMs}ms. It may be busy, asleep, or closed.`,
          );
        }
        return textResponse(500, error instanceof Error ? error.message : "Preview bridge failed");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        requests.fail(id, new Error("bridge request finished"));
      }
    },

    receive(message): void {
      if (message.type === "preview-response") {
        requests.settle(message.id, {
          statusCode: message.statusCode,
          statusMessage: "",
          headers: message.headers,
          body: message.body,
        });
        return;
      }
      if (message.type === "preview-error") {
        requests.fail(message.id, new Error(message.message));
      }
    },

    get pending(): number {
      return requests.size;
    },

    closeAll(): readonly string[] {
      return requests.closeAll(new Error("preview bridge closed"));
    },
  };
}

export interface PageSideOptions {
  readonly gateway: PreviewGateway;
  /** Sends a message back to the worker that asked. */
  readonly reply: (message: PageMessage) => void;
}

/**
 * The page half. It listens for requests from the worker and answers them through the gateway.
 *
 * `accept` never throws and always replies, including on failure. A silent drop here would leave the worker
 * waiting until its deadline, so even an internal error becomes a `preview-error` message.
 */
export function createPageSideResponder(options: PageSideOptions): {
  accept(message: WorkerMessage): Promise<void>;
} {
  return {
    async accept(message): Promise<void> {
      if (message.type !== "preview-request") return;
      try {
        const response = await options.gateway.handle({
          method: message.method,
          url: message.url,
          headers: message.headers,
          body: message.body,
        });
        options.reply({
          type: "preview-response",
          id: message.id,
          statusCode: response.statusCode,
          headers: response.headers,
          body: response.body,
        });
      } catch (error) {
        options.reply({
          type: "preview-error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
