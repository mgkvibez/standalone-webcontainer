const PREVIEW_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface PreviewOriginOptions {
  /** A dedicated preview base such as `preview.localhost` or `preview.example.com`. */
  readonly baseDomain: string;
  /** Optional explicit scheme for local reverse-proxy setups. Production defaults to HTTPS. */
  readonly protocol?: "http:" | "https:";
  /** The editor origin; previews are rejected if resolution would share it. */
  readonly hostOrigin: string;
}

/** Resolve an opaque project preview ID to a dedicated origin, never a host-app path. */
export function resolvePreviewOrigin(previewId: string, options: PreviewOriginOptions): string {
  if (!PREVIEW_ID_PATTERN.test(previewId)) throw new Error("preview ID must be a 128-bit lowercase hexadecimal label");

  const rawDomain = options.baseDomain.trim();
  if (rawDomain === "" || rawDomain.includes("/") || rawDomain.includes("@") || rawDomain.includes("#") || rawDomain.includes("?")) {
    throw new Error("preview base domain must be a hostname, optionally with a port");
  }
  const parsedDomain = new URL(`http://${rawDomain}`);
  if (parsedDomain.username || parsedDomain.password || parsedDomain.pathname !== "/" || parsedDomain.search || parsedDomain.hash) {
    throw new Error("preview base domain must not contain credentials, a path, query or fragment");
  }

  const protocol = options.protocol ?? (parsedDomain.hostname === "localhost" || parsedDomain.hostname.endsWith(".localhost")
    ? "http:"
    : "https:");
  if (protocol === "http:" && parsedDomain.hostname !== "localhost" && !parsedDomain.hostname.endsWith(".localhost")) {
    throw new Error("HTTP preview origins are allowed only for localhost development");
  }

  const origin = `${protocol}//${previewId}.${parsedDomain.host}`;
  if (new URL(options.hostOrigin).origin === origin) throw new Error("preview origin must be separate from the host application origin");
  return origin;
}

/** Construct the gateway URL on a resolved preview origin. */
export function createPreviewUrl(
  previewId: string,
  port: number,
  options: PreviewOriginOptions,
  pathAndSearch = "/",
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("preview port must be between 1 and 65535");
  if (!pathAndSearch.startsWith("/") || pathAndSearch.startsWith("//")) throw new Error("preview path must be an absolute path on the preview origin");
  const url = new URL(resolvePreviewOrigin(previewId, options));
  const target = new URL(pathAndSearch, "https://preview.invalid");
  if (target.origin !== "https://preview.invalid") throw new Error("preview path must stay on its origin");
  url.pathname = `/preview/${port}${target.pathname}`;
  url.search = target.search;
  url.hash = target.hash;
  return url.href;
}
