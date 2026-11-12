/**
 * What a previewed page is allowed to ask for, and how that becomes a message the runtime understands.
 *
 * The page half of a websocket is a fake `WebSocket` in the previewed document (ADR-0033). It cannot reach the runtime, so it asks the preview
 * shell, which is the frame's parent, and the shell asks the runtime Worker. This module is the part in the middle that has to be *right*: it
 * decides which URLs a page may open, translates the page's own ids into the runtime's message space, and refuses everything else with a
 * sentence a user can act on.
 *
 * Deliberately a pure set of functions over plain values. The shell's job is then only to move messages between two windows, which is the part a
 * unit test cannot check anyway.
 *
 * **On `wss:`.** A previewed page on an `https` origin will compute `wss://` for itself, and refusing that would refuse every deployment. What it
 * is asking for is that its bytes travel encrypted; they do, because the whole preview already runs inside the isolated, encrypted app origin.
 * There is no second TLS hop to make inside the container (ADR-0031 refuses `wss:` at the container's own client for that reason), so `wss:` is
 * accepted here and travelled as `ws:` one layer down. That is a real difference from a browser and it is documented rather than hidden.
 */

import type { SocketMessage } from "./protocol.js";

/** What the previewed page's client sends. Untrusted: every field is checked before it is used. */
export type PageSocketMessage = unknown;

export interface SocketTargetOptions {
  /** The shell's own origin, exactly as the browser reports it (`https://app.example`, `http://localhost:3000`). */
  readonly origin: string;
  /** The port this preview serves, from the shell's bootstrap parameters. Used when the URL does not say. */
  readonly port: number;
}

export type SocketTarget = { readonly port: number; readonly path: string } | { readonly refusal: string };

const PREVIEW_PREFIX = /^\/preview\/(\d{1,5})(\/.*)?$/;

/**
 * Where a `WebSocket` URL points, in terms the container understands.
 *
 * Three shapes reach here and all three are real:
 *
 * - `ws://app/preview/5173/src/main.ts` — a URL built from the page's own location, which is how most code that derives a socket URL works.
 * - `ws://app:5173/` — what Vite's client does, taking the *server's* port from its own config rather than from the page.
 * - `ws://app/` — a path-relative URL on a server that is mounted at the root.
 *
 * The host must be the shell's host. That is not a sandbox (nothing here is one): it is what makes the refusal legible, because a preview page
 * that asked for another machine would otherwise get a container-internal error about a port nobody serves.
 */
export function resolveSocketTarget(url: string, options: SocketTargetOptions): SocketTarget {
  const base = options.origin;
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return { refusal: `Not a URL a preview can open: ${url}` };
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { refusal: `A preview opens websockets, not ${parsed.protocol.replace(":", "")} URLs.` };
  }

  let baseHost: string;
  try {
    baseHost = new URL(base).hostname;
  } catch {
    return { refusal: `The preview shell has no usable origin: ${base}` };
  }
  // Host WITHOUT the port, because the port is the whole point of half these URLs: Vite asks for `ws://host:5173/`, where 5173 is the dev server
  // and not the app origin the page happens to be served from. Comparing `host` would refuse exactly the shape this feature exists to serve.
  if (parsed.hostname !== baseHost) {
    return { refusal: `A preview can only open a socket back to itself, not to ${parsed.hostname}.` };
  }

  const prefix = PREVIEW_PREFIX.exec(parsed.pathname);
  const explicitPort = parsed.port === "" ? null : Number(parsed.port);
  const port = explicitPort ?? (prefix === null ? options.port : Number(prefix[1]));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { refusal: `Not a port: ${parsed.port || String(port)}` };
  }

  // The preview prefix is the shell's own routing, not something the server ever mounted, so it comes off before the server sees the path. A
  // URL that does not carry it is already a path on the server.
  const path = prefix === null ? parsed.pathname : (prefix[2] ?? "/");
  return { port, path: `${path === "" ? "/" : path}${parsed.search}` };
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isProtocolList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 16 && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128);
}

/**
 * Turn what the page sent into what the runtime should hear, or into a refusal.
 *
 * The refusal is returned rather than thrown, because the caller is a `message` event listener on the shell: a throw there becomes an unhandled
 * rejection in a frame, which is the hardest kind of failure to see.
 */
export function toRuntimeSocketMessage(message: PageSocketMessage, options: SocketTargetOptions): SocketMessage | { readonly refusal: string } {
  if (typeof message !== "object" || message === null) return { refusal: "A preview socket message must be an object." };
  const candidate = message as { type?: unknown; id?: unknown; url?: unknown; protocols?: unknown; text?: unknown; body?: unknown; code?: unknown; reason?: unknown };

  if (!isId(candidate.id)) return { refusal: "A preview socket message must carry its page id." };

  switch (candidate.type) {
    case "socket-open": {
      if (typeof candidate.url !== "string" || candidate.url.length > 8192) {
        return { refusal: "A preview socket needs a URL to open." };
      }
      const protocols = candidate.protocols ?? [];
      if (!isProtocolList(protocols)) return { refusal: "Unusable websocket protocol list." };
      const target = resolveSocketTarget(candidate.url, options);
      if ("refusal" in target) return target;
      return { type: "socket-open", id: candidate.id, port: target.port, path: target.path, protocols: [...protocols] };
    }
    case "socket-send": {
      const hasText = typeof candidate.text === "string";
      const hasBody = candidate.body instanceof Uint8Array;
      // Exactly one. Both would be a client bug, and guessing which one the page meant would send the wrong bytes.
      if (hasText === hasBody) return { refusal: "A preview socket message carries one of text or bytes." };
      return hasText
        ? { type: "socket-send", id: candidate.id, text: candidate.text as string }
        : { type: "socket-send", id: candidate.id, body: candidate.body as Uint8Array };
    }
    case "socket-close": {
      const code = candidate.code;
      const reason = candidate.reason;
      const validCode = code === undefined || (typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999);
      if (!validCode) return { refusal: `A websocket close code is 1000-4999, not ${String(code)}.` };
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 123)) {
        return { refusal: "A websocket close reason is at most 123 bytes." };
      }
      return {
        type: "socket-close",
        id: candidate.id,
        ...(typeof code === "number" ? { code } : {}),
        ...(typeof reason === "string" ? { reason } : {}),
      };
    }
    default:
      return { refusal: `Not a preview socket message: ${String(candidate.type)}` };
  }
}

/** The four replies the runtime sends for a socket, so the shell can tell them apart from a response's `chunk`. */
export function isSocketReply(value: unknown): value is Extract<SocketMessage | { type: string }, { type: string }> & { type: `socket-${string}` } {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "socket-opened" || type === "socket-data" || type === "socket-closed" || type === "socket-failed";
}
