import "./styles.css";
import type { TransportReply, TransportRequest } from "./protocol.js";

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

function isReply(value: unknown): value is TransportReply {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<TransportReply>;
  return (message.type === "response" || message.type === "error") && typeof message.id === "string";
}

function onRuntimeMessage(event: MessageEvent<unknown>): void {
  if (!isReply(event.data)) return;
  const responsePort = inFlight.get(event.data.id);
  if (responsePort === undefined) return;
  inFlight.delete(event.data.id);
  responsePort.postMessage(event.data);
  responsePort.close();
}

function failInFlight(message: string): void {
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
  preview.title = `Project preview on port ${port}`;
  preview.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
  preview.src = `/preview/${port}/?__preview_nonce=${encodeURIComponent(nonce)}`;
  document.body.append(preview);
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
