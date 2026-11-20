/**
 * W-15: the preview nonce is a bearer capability that travels in a URL, so the shipped service worker must accept it only
 * for the shell it was minted for.
 *
 * These tests load `public/preview-sw.js` itself, not a copy and not a reimplementation, under a fake `self`. A rewrite of
 * the routing rules in TypeScript would pass while the shipped worker did something else, which is the failure mode this
 * file exists to prevent.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://abc123.preview.localhost";

interface FakeClient {
  readonly id: string;
  readonly url: string;
  readonly posted: Array<{ readonly message: Record<string, unknown>; readonly ports: MessagePort[] }>;
}

interface FetchEvent {
  readonly request: Request;
  readonly clientId?: string;
  respondWith(promise: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface Harness {
  readonly clients: FakeClient[];
  readonly fetchHandler: (event: FetchEvent) => void;
  readonly passthroughs: Request[];
}

function makeClient(id: string, url: string): FakeClient & { postMessage(message: unknown, transfer?: MessagePort[]): void } {
  const posted: Array<{ message: Record<string, unknown>; ports: MessagePort[] }> = [];
  return {
    id,
    url,
    posted,
    // The shell's half of the forward: record what the worker sent and keep the port so the test can answer on it.
    postMessage(message: unknown, transfer?: MessagePort[]): void {
      posted.push({ message: message as Record<string, unknown>, ports: transfer ?? [] });
    },
  };
}

/** Load the shipped worker and hand back the pieces a test drives. */
function loadWorker(clients: FakeClient[]): Harness {
  const source = readFileSync(new URL("../../public/preview-sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: FetchEvent) => void>();
  const passthroughs: Request[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: FetchEvent) => void) => {
      handlers.set(type, handler);
    },
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      get: async (id: string) => clients.find((client) => client.id === id),
      matchAll: async () => clients,
    },
  };
  // The worker's own `fetch` is only used for the reserved ws-client path and for shell passthrough; recording it keeps a
  // routing mistake visible instead of turning it into a network call.
  const workerFetch = async (input: Request): Promise<Response> => {
    passthroughs.push(input);
    return new Response("passthrough", { status: 200 });
  };
  const factory = new Function("self", "fetch", source) as (self: unknown, fetch: unknown) => void;
  factory(self, workerFetch);
  const handler = handlers.get("fetch");
  if (handler === undefined) throw new Error("the shipped worker registered no fetch handler");
  return { clients, fetchHandler: handler, passthroughs };
}

/** Drive one fetch event through the shipped worker and settle on the response it produces. */
async function dispatch(harness: Harness, url: string, clientId?: string): Promise<Response | null> {
  let responded: Promise<Response> | null = null;
  const event: FetchEvent = {
    request: new Request(url, { method: "GET" }),
    ...(clientId === undefined ? {} : { clientId }),
    respondWith: (promise) => {
      responded = promise;
    },
    waitUntil: () => undefined,
  };
  harness.fetchHandler(event);
  return responded === null ? null : await responded;
}

/** Answer a forwarded preview request the way the shell's transport does, so the response promise settles. */
function answer(client: FakeClient, status = 200, body = [104, 105]): void {
  const call = client.posted.find((entry) => entry.message["type"] === "preview-request");
  if (call === undefined) throw new Error("no preview-request was forwarded to this client");
  const request = call.message["request"] as { readonly id: string };
  const port = call.ports[0];
  if (port === undefined) throw new Error("the forwarded request carried no port");
  port.postMessage({
    type: "response",
    id: request.id,
    statusCode: status,
    statusMessage: "OK",
    headers: { "content-type": "text/plain" },
    body,
  });
}

/** Wait for the worker's own async lookups to finish and the forward to land. */
async function waitForForward(client: FakeClient): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (client.posted.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the worker never forwarded the request");
}

function shellUrl(nonce: string, port = 3000): string {
  return `${ORIGIN}/?__preview_shell=1&__preview_nonce=${nonce}&__preview_port=${String(port)}&__host_origin=https://app.localhost`;
}

describe("W-15: preview nonce boundary", () => {
  it("refuses a request that carries no nonce at all", async () => {
    const harness = loadWorker([makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa"))]);
    const response = await dispatch(harness, `${ORIGIN}/preview/3000/index.html`);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("missing");
    expect(harness.clients[0]?.posted).toHaveLength(0);
  });

  it("refuses a nonce that belongs to no live shell", async () => {
    const harness = loadWorker([makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa"))]);
    const response = await dispatch(harness, `${ORIGIN}/preview/3000/index.html?__preview_nonce=nonce-unknown-bbbbbbbb`);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("not connected");
    expect(harness.clients[0]?.posted).toHaveLength(0);
  });

  it("refuses a shell that has gone away, even though its nonce is the one in the request", async () => {
    // The stale shell is simply not in the client list any more: a closed frame is not a client, so the nonce dies with it.
    const harness = loadWorker([]);
    const response = await dispatch(harness, `${ORIGIN}/preview/3000/?__preview_nonce=nonce-shell-aaaaaaaaaaaa`);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("not connected");
  });

  it("refuses a client that carries the nonce from another origin", async () => {
    const foreign = makeClient("foreign", `https://other.preview.localhost/?__preview_shell=1&__preview_nonce=nonce-shell-aaaaaaaaaaaa`);
    const harness = loadWorker([foreign]);
    const response = await dispatch(harness, `${ORIGIN}/preview/3000/?__preview_nonce=nonce-shell-aaaaaaaaaaaa`);
    expect(response?.status).toBe(503);
    expect(foreign.posted).toHaveLength(0);
  });

  it("routes to the shell the nonce was minted for, never to a sibling shell", async () => {
    const first = makeClient("first", shellUrl("nonce-first-aaaaaaaaaaaa", 3000));
    const second = makeClient("second", shellUrl("nonce-second-bbbbbbbbbbbb", 4000));
    const harness = loadWorker([first, second]);
    const pending = dispatch(harness, `${ORIGIN}/preview/3000/api?__preview_nonce=nonce-first-aaaaaaaaaaaa`);
    await waitForForward(first);
    answer(first);
    const response = await pending;
    expect(response?.status).toBe(200);
    expect(first.posted).toHaveLength(1);
    expect(second.posted).toHaveLength(0);
  });

  it("authorises the shell, not the port: a valid shell may address any port in its own kernel", async () => {
    // Intentional. One shell is one project's kernel, and the port is chosen by the request path. This test exists so the
    // boundary is recorded as a decision rather than discovered later as a surprise.
    const shell = makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa", 3000));
    const harness = loadWorker([shell]);
    const pending = dispatch(harness, `${ORIGIN}/preview/9999/deep/path?__preview_nonce=nonce-shell-aaaaaaaaaaaa`);
    await waitForForward(shell);
    answer(shell);
    const response = await pending;
    expect(response?.status).toBe(200);
    const request = shell.posted[0]?.message["request"] as { readonly url: string };
    expect(request.url).toBe("/preview/9999/deep/path");
  });

  it("strips the nonce from the URL it forwards, so the previewed server never sees it", async () => {
    const shell = makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa", 3000));
    const harness = loadWorker([shell]);
    const pending = dispatch(harness, `${ORIGIN}/preview/3000/page?__preview_nonce=nonce-shell-aaaaaaaaaaaa&keep=1`);
    await waitForForward(shell);
    answer(shell);
    await pending;
    const request = shell.posted[0]?.message["request"] as { readonly url: string };
    expect(request.url).toBe("/preview/3000/page?keep=1");
    expect(request.url).not.toContain("__preview_nonce");
  });

  it("leaves the shell's own document requests alone instead of routing them into the runtime", async () => {
    const shell = makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa", 3000));
    const harness = loadWorker([shell]);
    const response = await dispatch(harness, `${ORIGIN}/preview-ws-client.js`, "shell");
    expect(response?.status).toBe(200);
    expect(shell.posted).toHaveLength(0);
  });

  it("ignores a request that is not for this origin at all", async () => {
    const harness = loadWorker([makeClient("shell", shellUrl("nonce-shell-aaaaaaaaaaaa"))]);
    const response = await dispatch(harness, "https://elsewhere.example/preview/3000/");
    expect(response).toBeNull();
  });
});
