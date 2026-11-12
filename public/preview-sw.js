const PREVIEW_ROUTE = /^\/preview\/(\d+)(\/.*)?$/;
const NO_BODY = new Set([204, 205, 304]);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(routePreviewRequest(event, url));
});

async function routePreviewRequest(event, url) {
  const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
  const clientUrl = client ? new URL(client.url) : null;
  if (clientUrl?.searchParams.get("__preview_shell") === "1") return fetch(event.request);

  const directMatch = PREVIEW_ROUTE.exec(url.pathname);
  const clientMatch = clientUrl ? PREVIEW_ROUTE.exec(clientUrl.pathname) : null;
  const port = directMatch?.[1] ?? clientMatch?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) return fetch(event.request);

  const nonce = url.searchParams.get("__preview_nonce") ?? clientUrl?.searchParams.get("__preview_nonce");
  if (!nonce) return new Response("Preview session is missing.", { status: 503 });
  const shellClient = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((candidate) => {
    const candidateUrl = new URL(candidate.url);
    return candidateUrl.origin === self.location.origin && candidateUrl.searchParams.get("__preview_shell") === "1" &&
      candidateUrl.searchParams.get("__preview_nonce") === nonce;
  });
  if (!shellClient) return new Response("Preview shell is not connected.", { status: 503 });

  const target = new URL(url.href);
  target.searchParams.delete("__preview_nonce");
  const routeMatch = PREVIEW_ROUTE.exec(target.pathname);
  if (routeMatch) {
    target.pathname = `/preview/${port}${routeMatch[2] ?? "/"}`;
  } else {
    target.pathname = `/preview/${port}${target.pathname.startsWith("/") ? target.pathname : `/${target.pathname}`}`;
  }

  let body;
  try {
    body = event.request.method === "GET" || event.request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await event.request.arrayBuffer());
  } catch (error) {
    return plain(400, `Could not read preview request: ${String(error)}`);
  }

  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const response = new Promise((resolve) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(plain(504, "Preview runtime did not respond in time."));
    }, 30_000);
    let controller = null;
    let started = false;

    // Response headers are fixed the moment this resolves, so the decision to stream cannot be unmade: once a `start` message has been
    // seen, the browser already holds a Response object whose body is a ReadableStream, and buffering afterwards is impossible.
    const decorate = (headers) => {
      headers.delete("content-length");
      // COEP world: every response this worker synthesises is a subresource of a cross-origin-isolated document, so it has
      // to declare that it may be embedded. Without this the preview shell (or the preview document itself, once it is
      // isolated) refuses the response and the frame renders empty with no visible error in the page.
      headers.set("cross-origin-resource-policy", "cross-origin");
      // A document served into a cross-origin-isolated embedder has to be isolated as well, or the frame is blocked
      // outright (`net::ERR_BLOCKED_BY_RESPONSE`) rather than merely running unisolated. Only documents get these two:
      // COEP on every asset would demand CORP from anything the previewed app loads.
      const contentType = headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        headers.set("cross-origin-opener-policy", "same-origin");
        headers.set("cross-origin-embedder-policy", "require-corp");
      }
      return headers;
    };

    channel.port1.onmessage = (messageEvent) => {
      const message = messageEvent.data;
      if (!message || message.id !== id) return;

      if (message.type === "start") {
        started = true;
        clearTimeout(timer);
        const headers = decorate(new Headers(message.headers));
        // A HEAD request, or a status that cannot carry a body, still gets its headers from here; the stream below is what
        // carries the bytes for everything else.
        const bodyless = event.request.method === "HEAD" || NO_BODY.has(message.statusCode);
        const stream = bodyless
          ? null
          : new ReadableStream({
              start(streamController) {
                controller = streamController;
              },
              cancel() {
                // The page stopped reading (a navigation, an aborted fetch). Close the channel so the runtime stops writing into a
                // port nobody drains, and let its own timeout end the handler.
                controller = null;
                channel.port1.close();
              },
            });
        resolve(new Response(stream, { status: message.statusCode, statusText: message.statusMessage || undefined, headers }));
        return;
      }

      if (message.type === "chunk") {
        if (controller === null) return;
        try {
          controller.enqueue(new Uint8Array(message.body));
        } catch {
          // The stream was cancelled between the check and the enqueue. Nothing to do: the consumer is gone.
          controller = null;
        }
        return;
      }

      clearTimeout(timer);
      channel.port1.close();
      if (message.type === "error") {
        if (controller !== null) {
          controller.error(new Error(message.message));
          controller = null;
          return;
        }
        resolve(plain(502, message.message ?? "Invalid preview runtime response."));
        return;
      }

      // A whole response, either because the runtime buffered it or because nothing was written before it ended.
      const headers = decorate(new Headers(message.headers));
      const whole = event.request.method === "HEAD" || NO_BODY.has(message.statusCode) ? null : new Uint8Array(message.body);
      if (!started) {
        resolve(new Response(whole, { status: message.statusCode, statusText: message.statusMessage || undefined, headers }));
        return;
      }
      // Headers already went out with the stream, so only the bytes and the end of it remain.
      if (controller !== null) {
        if (whole !== null && whole.byteLength > 0) controller.enqueue(whole);
        controller.close();
        controller = null;
      }
    };
    channel.port1.start();
  });

  shellClient.postMessage({
    type: "preview-request",
    request: {
      type: "request",
      id,
      method: event.request.method,
      url: `${target.pathname}${target.search}`,
      headers: Object.fromEntries(event.request.headers.entries()),
      body,
    },
  }, [channel.port2]);
  return response;
}

function plain(status, text) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
