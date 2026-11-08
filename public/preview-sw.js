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
    channel.port1.onmessage = (messageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const message = messageEvent.data;
      if (!message || message.id !== id || message.type === "error") {
        resolve(plain(502, message?.message ?? "Invalid preview runtime response."));
        return;
      }
      const headers = new Headers(message.headers);
      headers.delete("content-length");
      const responseBody = event.request.method === "HEAD" || NO_BODY.has(message.statusCode)
        ? null
        : new Uint8Array(message.body);
      resolve(new Response(responseBody, { status: message.statusCode, statusText: message.statusMessage || undefined, headers }));
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
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
