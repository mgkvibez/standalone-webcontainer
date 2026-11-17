/**
 * The documents the fixture serves. Kept in one place so every case runs exactly the
 * same client code and differs only in topology, which is what the matrix compares.
 */
export interface Hosts {
  readonly app: string;
  readonly other: string;
  readonly engine: string;
  readonly sameApp: string;
  readonly sameEngine: string;
}

export interface Documents {
  readonly embedder: (topHost: string, engineHost: string) => string;
  readonly engine: (tag: string) => string;
  readonly inertReader: string;
  /** Script-free: proves TLS without registering a worker or writing storage. */
  readonly preflight: string;
  readonly serviceWorker: string;
}

export const STORAGE_KEY = "partition-probe";

export function buildDocuments(hosts: Hosts, port: number): Documents {
  const engineOrigin = (host: string) => `https://${host}:${port}`;

  const embedder = (topHost: string, engineHost: string) => `<!doctype html><meta charset=utf-8><title>embedder ${topHost}</title><body>
<script>
window.findings = [];
addEventListener("message", (event) => {
  const expected = ${JSON.stringify(engineOrigin(engineHost))};
  if (event.origin === expected) window.findings.push(event.data);
});
const frame = document.createElement("iframe");
frame.id = "engine-frame";
frame.src = ${JSON.stringify(engineOrigin(engineHost))} + "/engine?tag=" + ${JSON.stringify(topHost)} + "&editor=" + ${JSON.stringify(topHost)};
document.body.appendChild(frame);
// One ambient credential the browser may or may not attach cross-site, and one that is
// explicitly cross-site. The pair is what distinguishes design A from design B.
document.cookie = "session=lax-probe; SameSite=Lax; Secure; Path=/";
document.cookie = "crosssite=none-probe; SameSite=None; Secure; Path=/";
// Recorded so a silently-rejected cookie (attribute, scheme, policy) is visible in the
// report instead of looking like a browser withholding it.
window.embedderCookies = document.cookie;
window.sameOriginProbe = null;
fetch("/echo", { credentials: "include" }).then((r) => r.json()).then((j) => { window.sameOriginProbe = j; }).catch((e) => { window.sameOriginProbe = String(e); });
</script></body>`;

  const engine = (tag: string) => `<!doctype html><meta charset=utf-8><title>engine ${tag}</title><body>
<script>
const QUERY = new URL(location.href).searchParams;
const TAG = QUERY.get("tag") || ${JSON.stringify(tag)};
const EDITOR_ORIGIN = "https://" + (QUERY.get("editor") || ${JSON.stringify(hosts.app)}) + ":${port}";
const post = (payload) => { window.__result = payload; if (window.top !== window) parent.postMessage(payload, "*"); };
(async () => {
  const out = {
    tag: TAG,
    thirdParty: window.top !== window,
    topOrigin: (() => { try { return window.top.location.origin; } catch { return "cross-origin"; } })(),
  };
  try {
    const prior = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, TAG);
    out.storagePrior = prior;
  } catch (error) { out.storageError = String(error && error.message || error); }
  try {
    // A registration call that never settles would hide every later observation behind a
    // harness timeout, so it is raced against a clock and the outcome is recorded explicitly.
    const registration = navigator.serviceWorker.register("/sw.js", { scope: "/" });
    out.registration = await Promise.race([
      registration.then(() => "accepted"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10000)),
    ]);
  } catch (error) {
    out.registration = "refused";
    out.registrationDetail = String(error && error.message || error);
    post(out); return;
  }
  // Activation first: ready resolves when the worker is active, and a claim cannot control
  // anything before that. It is still not proof of control, so the wait below proves that.
  out.activation = await Promise.race([
    navigator.serviceWorker.ready.then(() => "active"),
    new Promise((resolve) => setTimeout(() => resolve("activation-pending"), 10000)),
  ]);
  out.controlledBeforeWait = Boolean(navigator.serviceWorker.controller);
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 15000);
      navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolve("controllerchange"); }, { once: true });
    });
    out.controllerChange = "waited";
  }
  out.control = Boolean(navigator.serviceWorker.controller);
  try { out.workerServed = await (await fetch("/relay-probe")).json(); }
  catch (error) { out.workerServedError = String(error && error.message || error); }
  try { out.ownCookie = document.cookie; } catch (error) { out.ownCookieError = String(error); }
  out.editorOrigin = EDITOR_ORIGIN;
  if (out.thirdParty) {
    try {
      const response = await fetch(EDITOR_ORIGIN + "/echo", { credentials: "include" });
      out.credentialedFetch = await response.json();
    } catch (error) { out.credentialedFetchError = String(error && error.message || error); }
  }
  post(out);
})();
</script></body>`;

  // Reads the probe and writes nothing: a comparison page that writes is useless,
  // because the value it reports is its own write.
  const inertReader = `<!doctype html><meta charset=utf-8><title>inert reader</title><body>
<script>
window.__result = { tag: "first-party-inert", thirdParty: window.top !== window,
  storagePrior: (() => { try { return localStorage.getItem(${JSON.stringify(STORAGE_KEY)}); } catch (error) { return "error:" + String(error); } })() };
</script></body>`;

  // The worker answers /relay-probe from memory. For the transport paths it proxies it
  // uses credentials: "omit" — the Cookie request header is not reachable from a service
  // worker, so header removal is impossible and this is the mechanism (H2 design doc §8).
  //
  // It deliberately does NOT re-issue every request: the first version had a catch-all
  // `respondWith(fetch(request, { credentials: "omit" }))`, and with that in place the
  // third-party frame's own credentialed fetches carried NO cookies in all three browsers,
  // which made the cookie rows meaningless. Only our own paths are proxied here; everything
  // else is passed through untouched so the cookie rows measure the browser, not the worker.
  const serviceWorker = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/relay-probe") {
    event.respondWith(Response.json({ servedBySw: true, path: url.pathname }));
    return;
  }
  if (url.pathname.startsWith("/proxy/")) {
    event.respondWith(fetch(event.request, { credentials: "omit" }));
  }
});
`;

  const preflight = `<!doctype html><meta charset=utf-8><title>preflight</title><body>preflight</body>`;

  return { embedder, engine, inertReader, preflight, serviceWorker };
}
