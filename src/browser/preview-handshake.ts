import type { WorkerRuntimeClient } from "./worker-client.js";

interface PreviewHandshakeMessage {
  readonly type: "preview-ready" | "preview-connected";
  readonly nonce: string;
}

function isHandshakeMessage(value: unknown): value is PreviewHandshakeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<PreviewHandshakeMessage>;
  return (message.type === "preview-ready" || message.type === "preview-connected") && typeof message.nonce === "string";
}

/** Bootstrap the preview shell only when both its exact origin and iframe WindowProxy match. */
export function connectPreviewFrame(
  frame: HTMLIFrameElement,
  runtime: WorkerRuntimeClient,
  previewOrigin: string,
  port: number,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<() => void> {
  const origin = new URL(previewOrigin).origin;
  if (origin === window.location.origin) return Promise.reject(new Error("preview must use a separate origin"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("invalid preview port"));

  const nonce = crypto.randomUUID();
  const shellUrl = new URL("/", origin);
  shellUrl.searchParams.set("__preview_shell", "1");
  shellUrl.searchParams.set("__preview_nonce", nonce);
  shellUrl.searchParams.set("__preview_port", String(port));
  shellUrl.searchParams.set("__host_origin", window.location.origin);
  frame.src = shellUrl.href;

  return new Promise((resolve, reject) => {
    let channel: MessageChannel | null = null;
    let transportId: number | null = null;
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        if (transportId !== null) runtime.disconnectTransport(transportId);
        channel?.port1.close();
        frame.src = "about:blank";
        reject(error);
      }
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== origin || event.source !== frame.contentWindow || !isHandshakeMessage(event.data) || event.data.nonce !== nonce) return;
      if (event.data.type === "preview-ready") {
        if (channel !== null) return;
        channel = new MessageChannel();
        transportId = runtime.connectTransport(channel.port1);
        frame.contentWindow?.postMessage({ type: "preview-connect", nonce }, origin, [channel.port2]);
        return;
      }
      if (channel === null) return;
      finish();
      resolve(() => {
        if (transportId !== null) runtime.disconnectTransport(transportId);
        transportId = null;
        channel?.port1.close();
        frame.src = "about:blank";
      });
    };
    const onAbort = (): void => finish(new DOMException("preview connection cancelled", "AbortError"));
    const timeout = window.setTimeout(() => finish(new Error("preview origin handshake timed out")), timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("message", onMessage);
  });
}
