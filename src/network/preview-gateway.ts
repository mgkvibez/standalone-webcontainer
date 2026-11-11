/**
 * The preview gateway: one function from "a real browser request arrived" to "an http handler answered".
 *
 * It exists so the service worker does not need to know anything about servers, ports, or deadlines. The
 * worker decodes a fetch, hands the request here, and turns the result back into a `Response`. That keeps
 * the worker thin, which matters because worker code is the hardest part of this system to test.
 *
 * Routing is `/preview/<port>/<path>`, transcribing the model ADR-0002 #5 selected. Two properties of
 * that model are worth stating plainly because they are consequences, not choices made here:
 *
 * - **User code shares the host origin.** The preview is a path on the app's own origin, so a handler
 *   cannot reach anything the app itself could not. This is recorded as risk P0-1 in
 *   docs/references/discovery-stackblitz-public.md; the incumbent puts user code on a separate origin and
 *   pays for it in documentation pain. Changing this is an architectural decision, not a gateway change.
 * - **The path is rewritten before the handler sees it.** A handler mounted at `listen(3000)` expects
 *   `/foo`, not `/preview/3000/foo`, so the prefix is stripped. Getting this wrong is the classic bug
 *   where every static site serves its index at every URL.
 *
 * Every request carries a deadline. A handler that never calls `end()` would otherwise leave the browser
 * waiting with no error, which is exactly the failure both reference implementations exhibit (see
 * docs/references/discovery-labor-openwebcontainer.md §5). Here it becomes a 504 that names the port.
 */

import { RequestRegistry, RequestTimeoutError } from "./request-registry.js";
import { PortRegistry, type ServeProtocol } from "./port-registry.js";
import { Server, type RequestListener, type WireRequest, type WireResponse } from "../shims/http.js";

export interface GatewayOptions {
  readonly registry: PortRegistry;
  /** Default 30s. Long enough for a cold rebuild, short enough that a hung preview is visible. */
  readonly timeoutMs?: number;
  /** Injected clock, in milliseconds. Tests pass a fixed value instead of sleeping. */
  readonly now?: () => number;
  /** Mount prefix. Configurable because the tests do not need to pretend to be the real path. */
  readonly mountPath?: string;
}

/**
 * Ensures the request carries a `Host` header, which HTTP/1.1 requires and which this layer has to supply.
 *
 * Found by running vite: its dev server refuses with 403 "This host (undefined) is not allowed" when `req.headers.host` is missing,
 * and every request through the preview gateway was missing it. The absence is structural, not an oversight in one caller: `Host` is
 * a forbidden header name, so a browser neither exposes it to a service worker nor lets the worker set it, and a Node-side probe has
 * no network stack to add it. On a real network the server's HTTP parser always produces it, so the gateway is the last place that can
 * put it back. The authority is the preview origin the browser addressed (`localhost:<port>`), which is also what the fixture's own
 * `http://localhost:<port>/` target names.
 */
const withHost = (headers: Readonly<Record<string, string>>, port: number): Record<string, string> => {
  const present = Object.keys(headers).some((name) => name.toLowerCase() === "host");
  return present ? { ...headers } : { ...headers, host: `localhost:${port}` };
};

export interface ResolvedTarget {
  readonly protocol: ServeProtocol;
  readonly port: number;
  readonly path: string;
}

export class PreviewGateway {
  readonly #registry: PortRegistry;
  readonly #requests = new RequestRegistry<WireResponse>();
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #mountPath: string;

  constructor(options: GatewayOptions) {
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? (() => Date.now());
    this.#mountPath = (options.mountPath ?? "/preview").replace(/\/+$/, "");
  }

  /** How many requests are outstanding. Used by the liveness check and by tests. */
  get inFlight(): number {
    return this.#requests.size;
  }

  /**
   * Parse `/preview/<port>/<rest>` into a target. Returns null for anything else so the worker can pass
   * non-preview requests (the app's own assets, API calls) straight through to the network.
   */
  resolve(url: string): ResolvedTarget | null {
    const prefix = `${this.#mountPath}/`;
    if (!url.startsWith(prefix)) return null;

    const afterPrefix = url.slice(prefix.length);
    const slash = afterPrefix.indexOf("/");
    const portPart = slash === -1 ? afterPrefix : afterPrefix.slice(0, slash);
    const rest = slash === -1 ? "/" : afterPrefix.slice(slash);
    if (!/^\d+$/.test(portPart)) return null;

    const port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { protocol: "http", port, path: rest };
  }

  /**
   * Answer one request. Never throws: a preview failure becomes a response the browser can display, because
   * an exception in the worker would surface as a blank page with no explanation.
   */
  async handle(wire: WireRequest): Promise<WireResponse> {
    const target = this.resolve(wire.url);
    if (target === null) return text(404, `Not a preview request: ${wire.url}`);

    const server = this.#serverFor(target.port);
    if (server === undefined) {
      return text(
        404,
        `No preview server is listening on port ${target.port}. Start one with server.listen(${target.port}).`,
      );
    }

    const startedAt = this.#now();
    const pending = this.#requests.open({ deadline: startedAt + this.#timeoutMs, now: startedAt });

    void server.dispatch({ ...wire, url: target.path, headers: withHost(wire.headers, target.port) }).then(
      (response) => this.#requests.settle(pending.id, response),
      (error: unknown) => this.#requests.fail(pending.id, error),
    );

    // A single timer per request, cleared when the request settles. The registry does the deciding; the
    // timer only saves it from waiting. Both are needed: without the timer nothing reaps, and without the
    // registry the reaping would not settle the promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, rejectTimer) => {
      timer = setTimeout(() => {
        const [expired] = this.#requests.reap(this.#now());
        if (expired === undefined) rejectTimer(new RequestTimeoutError(pending.id, this.#timeoutMs));
      }, this.#timeoutMs);
    });

    try {
      return await Promise.race([pending.settled, expiry]);
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        return text(504, `Preview on port ${target.port} did not respond within ${this.#timeoutMs}ms.`);
      }
      return text(500, error instanceof Error ? error.message : "Preview failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Settle anything the race left behind so a late reply cannot resurrect the entry.
      this.#requests.fail(pending.id, new Error("gateway request finished"));
    }
  }

  /**
   * Create a server already wired to this gateway's port registry and already routable.
   *
   * Offering this rather than expecting callers to assemble the pieces is not sugar: a server built with
   * `http.createServer()` alone lands in the module-level registry while the gateway reads its own, which
   * produces a server that is listening and unroutable. That mistake is silent, so the supported path is
   * the one that cannot make it.
   */
  createServer(handler?: RequestListener): Server {
    const server = new Server(handler, { registry: this.#registry });
    this.attach(server);
    return server;
  }

  /** Fail everything outstanding. Called on teardown so no request outlives the runtime. */
  closeAll(): readonly string[] {
    return this.#requests.closeAll(new Error("preview gateway closed"));
  }

  /** Stop selected in-memory servers, or all of them during a project/Worker reset. */
  closeServers(ports: readonly number[] = [...this.#servers.keys()]): readonly number[] {
    const closed: number[] = [];
    for (const port of ports) {
      const server = this.#servers.get(port);
      if (server === undefined) continue;
      server.close();
      closed.push(port);
    }
    return closed;
  }

  /**
   * Server lookup goes through the port registry, which stores bindings rather than servers, so the
   * gateway keeps its own map from port to handler. The registry stays the single source of truth for
   * "is this port bound", and this map only answers "who answers it".
   */
  readonly #servers = new Map<number, Server>();

  /**
   * Wire a server to this gateway so its port becomes routable the moment it listens, and stops being
   * routable when it closes. Automatic rather than manual on purpose: a caller who forgets to register
   * would get a 404 for a server that is demonstrably running, which is a miserable thing to debug.
   *
   * Returns a detach function for teardown.
   */
  attach(server: Server): () => void {
    // `bind` and `unbind` rather than `listening` and `close`: the latter are asynchronous, and a request
    // that arrives between listen() and the event would otherwise be routed to nothing.
    const onBind = (port: unknown): void => {
      if (typeof port === "number") this.register(server, port);
    };
    const onUnbind = (port: unknown): void => {
      if (typeof port === "number") this.unregister(port);
    };
    server.on("bind", onBind);
    server.on("unbind", onUnbind);
    // A server that is already listening when it is attached must be routable immediately.
    const address = server.address();
    if (address !== null) this.register(server, address.port);
    return () => {
      server.off("bind", onBind);
      server.off("unbind", onUnbind);
      // Detaching means the gateway stops answering for this server, so the route must go with it.
      const current = server.address();
      if (current !== null) this.unregister(current.port);
    };
  }

  register(server: Server, port: number): void {
    this.#servers.set(port, server);
  }

  unregister(port: number): void {
    this.#servers.delete(port);
  }

  #serverFor(port: number): Server | undefined {
    if (!this.#registry.has("http", port)) return undefined;
    return this.#servers.get(port);
  }
}

function text(statusCode: number, message: string): WireResponse {
  const body = new TextEncoder().encode(message);
  return {
    statusCode,
    statusMessage: "",
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length) },
    body,
  };
}
