import "./styles.css";
import type { TransportReply, TransportRequest } from "./protocol.js";
import { createHtmlInjector, isHtmlDocument, type HtmlInjector } from "./html-inject.js";
import { isSocketReply, toRuntimeSocketMessage } from "./socket-relay.js";

const params = new URLSearchParams(window.location.search);
const nonce = params.get("__preview_nonce");
const hostOrigin = params.get("__host_origin");
const port = Number(params.get("__preview_port"));
const host = hostOrigin === null ? null : new URL(hostOrigin);

if (
  nonce === null || nonce.length < 16 || host === null || hostOrigin === null || host.origin !== hostOrigin ||
  host.origin === window.location.origin || !Number.isInteger(port) || port < 1 || port > 65535
) {
  document.body.textContent = "Invalid preview shell configuration.";
  throw new Error("invalid preview shell bootstrap parameters");
}

const status = document.getElementById("preview-status");
if (status === null) throw new Error("preview shell is missing its status element");
status.textContent = "Connecting to the runtime…";

async function waitForController(): Promise<void> {
  if (navigator.serviceWorker.controller !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("preview service worker did not take control")), 10_000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (navigator.serviceWorker.controller === null) return;
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

try {
  await navigator.serviceWorker.register("/preview-sw.js", { scope: "/", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  await waitForController();
} catch (error) {
  status.textContent = `Preview routing unavailable: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
}

window.parent.postMessage({ type: "preview-ready", nonce }, hostOrigin);

let runtimePort: MessagePort | null = null;
const inFlight = new Map<string, MessagePort>();
/** One injector per response that is a document: the client has to land in the HTML the dev server wrote, and the body is still arriving. */
const injectors = new Map<string, HtmlInjector>();
let previewFrame: HTMLIFrameElement | null = null;
const CLIENT_TAG = '<script data-swc-preview-client src="/__swc/ws-client.js"></script>';

function isReply(value: unknown): value is Extract<TransportReply, { id: string }> {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<TransportReply>;
  return (message.type === "response" || message.type === "error" || message.type === "start" || message.type === "chunk") &&
    typeof message.id === "string";
}

/**
 * Relay a reply to the request it belongs to.
 *
 * `start` and `chunk` do NOT close the port: a streaming response is still being written, and closing on the first chunk would turn
 * every stream into a one-chunk response that then hangs. Only `response` and `error` end the request, which is why the map entry is
 * dropped there and nowhere else.
 */
function onRuntimeMessage(event: MessageEvent<unknown>): void {
  if (isSocketReply(event.data)) {
    // A socket reply belongs to the previewed page, not to the service worker: it is not a response to anything the worker asked for.
    previewFrame?.contentWindow?.postMessage(event.data, window.location.origin);
    return;
  }
  if (!isReply(event.data)) return;
  const responsePort = inFlight.get(event.data.id);
  if (responsePort === undefined) return;

  if (event.data.type === "start") {
    if (isHtmlDocument(event.data.headers["content-type"])) injectors.set(event.data.id, createHtmlInjector(CLIENT_TAG));
    responsePort.postMessage(event.data);
    return;
  }

  if (event.data.type === "chunk") {
    const injector = injectors.get(event.data.id);
    if (injector === undefined) {
      responsePort.postMessage(event.data);
      return;
    }
    // Bytes before the closing head leave immediately; only the bounded tail is held, so the document still streams.
    for (const body of injector.push(event.data.body)) responsePort.postMessage({ type: "chunk", id: event.data.id, body });
    return;
  }

  const injector = injectors.get(event.data.id);
  injectors.delete(event.data.id);
  if (injector !== undefined) {
    // Whatever the injector held goes out before the response ends, in the same order the server wrote it.
    for (const body of injector.end()) responsePort.postMessage({ type: "chunk", id: event.data.id, body });
  }
  if (event.data.type === "error") {
    inFlight.delete(event.data.id);
    responsePort.postMessage(event.data);
    responsePort.close();
    return;
  }
  inFlight.delete(event.data.id);
  responsePort.postMessage(event.data);
  responsePort.close();
}

function failInFlight(message: string): void {
  injectors.clear();
  for (const [id, responsePort] of inFlight) {
    responsePort.postMessage({ type: "error", id, message });
    responsePort.close();
  }
  inFlight.clear();
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== hostOrigin || event.source !== window.parent || typeof event.data !== "object" || event.data === null) return;
  const message = event.data as { type?: unknown; nonce?: unknown };
  if (message.type !== "preview-connect" || message.nonce !== nonce || event.ports.length !== 1 || runtimePort !== null) return;
  runtimePort = event.ports[0] ?? null;
  if (runtimePort === null) return;
  runtimePort.addEventListener("message", onRuntimeMessage);
  runtimePort.addEventListener("messageerror", () => failInFlight("Preview runtime transport failed."));
  runtimePort.addEventListener("close", () => failInFlight("Preview runtime transport closed."), { once: true });
  runtimePort.start();
  status.textContent = `Preview server on port ${port}`;
  window.parent.postMessage({ type: "preview-connected", nonce }, hostOrigin);

  const preview = document.createElement("iframe");
  previewFrame = preview;
  preview.title = `Project preview on port ${port}`;
  preview.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
  preview.src = `/preview/${port}/?__preview_nonce=${encodeURIComponent(nonce)}`;
  document.body.append(preview);
});

// A websocket from the previewed page. The page has no other way to reach the runtime, so this frame is the only door, and it only opens for
// the frame this shell created: a message from anywhere else is ignored rather than translated.
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (previewFrame === null || event.source !== previewFrame.contentWindow || event.origin !== window.location.origin) return;
  if (runtimePort === null) return;
  const message = event.data as { type?: unknown } | null;
  if (message === null || typeof message.type !== "string" || message.type.indexOf("socket-") !== 0) return;
  const translated = toRuntimeSocketMessage(message, { origin: window.location.origin, port });
  if ("refusal" in translated) {
    const id = (message as { id?: unknown }).id;
    if (typeof id === "number") previewFrame.contentWindow?.postMessage({ type: "socket-failed", id, message: translated.refusal }, window.location.origin);
    return;
  }
  runtimePort.postMessage(translated);
});

navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== navigator.serviceWorker.controller || runtimePort === null || typeof event.data !== "object" || event.data === null) return;
  const message = event.data as { type?: unknown; request?: unknown };
  const replyPort = event.ports[0];
  const request = message.request as Partial<TransportRequest> | null;
  if (
    message.type !== "preview-request" || replyPort === undefined || request === null || typeof request !== "object" ||
    typeof request.id !== "string" || typeof request.method !== "string" || typeof request.url !== "string" ||
    typeof request.headers !== "object" || request.headers === null || !(request.body instanceof Uint8Array)
  ) {
    replyPort?.postMessage({ type: "error", id: "", message: "Invalid preview request." });
    replyPort?.close();
    return;
  }
  inFlight.set(request.id, replyPort);
  runtimePort.postMessage(request);
});
