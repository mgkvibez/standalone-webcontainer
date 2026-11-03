/**
 * The fetch side of the preview: a real `Request` in, a real `Response` out.
 *
 * This is the piece that makes the network layer reachable from a browser at all. Until now the gateway
 * could only be called by a test holding a hand-built `WireRequest`; nothing translated actual web
 * requests into that shape.
 *
 * It is deliberately a pure function over `Request` and `Response` rather than a service-worker script.
 * A `fetch` listener is the hardest thing in this system to test, so the logic lives here where a test can
 * call it directly, and the worker script is left with nothing but plumbing. The split matters because the
 * worker cannot be unit-tested at all, and every line in it is a line that only fails in production.
 *
 * **A note on where this runs.** A service worker has its own global scope and cannot touch the page's
 * runtime object, so in the browser this function is called on the *page* side of a message bridge (see
 * `sw-bridge.ts`). It is written without any assumption about that: it takes requests, it answers them.
 *
 * Two response details are handled because getting them wrong breaks real pages in ways that are hard to
 * attribute: a `HEAD` response and a `204`/`304` must carry no body, and constructing a `Response` with one
 * throws rather than degrading.
 */

import type { PreviewGateway } from "./preview-gateway.js";
import type { WireRequest, WireResponse } from "../shims/http.js";

export interface PreviewFetchOptions {
  /** The gateway routing to servers. It also decides which URLs are preview URLs. */
  readonly gateway: PreviewGateway;
  /** Called for anything that is not a preview URL. Defaults to the global `fetch`. */
  readonly passthrough?: (request: Request) => Promise<Response>;
}

const STATUS_WITHOUT_BODY = new Set([204, 205, 304]);

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function toResponse(wire: WireResponse, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(wire.headers)) {
    // content-length is recomputed by the platform from the body it is given. Passing a stale one through
    // would produce a response the browser truncates, which looks like a server bug from the outside.
    if (name.toLowerCase() === "content-length") continue;
    try {
      headers.set(name, value);
    } catch {
      // A header name the browser refuses (a bare invalid token from a handler) must not fail the whole
      // response: dropping one header is survivable, a 500 is not.
    }
  }

  const bodyless = method.toUpperCase() === "HEAD" || STATUS_WITHOUT_BODY.has(wire.statusCode);
  if (bodyless) {
    return new Response(null, { status: wire.statusCode, headers });
  }
  // Copy into a fresh buffer: the processor's view must not alias the handler's chunks.
  return new Response(new Uint8Array(wire.body), { status: wire.statusCode, headers });
}

function errorResponse(statusCode: number, message: string): Response {
  return new Response(message, {
    status: statusCode,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Build the handler a service worker (or a page-level fetch patch) calls.
 *
 * It never throws: a failure while reading the request body becomes a 500 with the reason in the body,
 * because a rejected promise inside a `fetch` listener surfaces to the browser as an opaque network error
 * with no explanation.
 */
export function createPreviewFetchHandler(
  options: PreviewFetchOptions,
): (request: Request) => Promise<Response> {
  const gateway = options.gateway;
  // The gateway owns the mount path. Taking a copy of it here would be a second source of truth that can
  // disagree with the one doing the routing, so the handler asks the gateway instead.
  const passthrough = options.passthrough ?? ((request: Request) => fetch(request));

  return async function handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, `Not a valid request URL: ${request.url}`);
    }

    const path = `${url.pathname}${url.search}`;
    const target = gateway.resolve(path);
    if (target === null) {
      // Everything that is not a preview belongs to whatever is hosting the page.
      return passthrough(request);
    }

    let body: Uint8Array;
    try {
      const buffer = request.method === "GET" || request.method === "HEAD" ? new ArrayBuffer(0) : await request.arrayBuffer();
      body = new Uint8Array(buffer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return errorResponse(500, `Could not read the request body: ${reason}`);
    }

    const wire: WireRequest = {
      method: request.method.toUpperCase(),
      url: path,
      headers: headersToRecord(request.headers),
      body,
    };

    try {
      return toResponse(await gateway.handle(wire), request.method);
    } catch (error) {
      // The gateway is written not to throw. If it ever does, the browser must still get an answer.
      const reason = error instanceof Error ? error.message : String(error);
      return errorResponse(500, `Preview request failed: ${reason}`);
    }
  };
}
