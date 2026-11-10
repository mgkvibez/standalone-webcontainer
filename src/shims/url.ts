/**
 * `url`, mostly in its legacy form because that is what servers call.
 *
 * `parseurl` and `serve-static` call `url.parse(req.url)` on a **relative** path, so `parse` here answers for relative input rather
 * than only for absolute URLs. The platform `URL` needs a base, so a relative input is parsed against a sentinel base and the
 * authority fields are then blanked, which is what Node reports: `parse("/a?b=1")` has a pathname, a search and nothing else.
 */

import { parse as parseQuery } from "./querystring.js";

export interface LegacyUrl {
  href: string;
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | null | Record<string, string | string[]>;
  pathname: string | null;
  path: string | null;
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function parse(input: string, parseQueryString = false, _slashesDenoteHost = false): LegacyUrl {
  const text = String(input ?? "");
  const relative = !ABSOLUTE.test(text);
  let parsed: URL;
  try {
    parsed = new URL(relative ? `http://localhost${text.startsWith("/") ? "" : "/"}${text}` : text);
  } catch {
    return {
      href: text,
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: null,
      search: null,
      query: null,
      pathname: null,
      path: null,
    };
  }
  const search = parsed.search === "" ? null : parsed.search;
  const query = search === null ? null : parseQueryString ? parseQuery(search.slice(1)) : search.slice(1);
  const pathname = parsed.pathname;
  if (relative) {
    return {
      href: text,
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: parsed.hash === "" ? null : parsed.hash,
      search,
      query,
      pathname,
      path: search === null ? pathname : `${pathname}${search}`,
    };
  }
  const auth =
    parsed.username === "" && parsed.password === ""
      ? null
      : parsed.password === ""
        ? parsed.username
        : `${parsed.username}:${parsed.password}`;
  return {
    href: parsed.href,
    protocol: parsed.protocol,
    slashes: text.slice(parsed.protocol.length).startsWith("//") ? true : null,
    auth,
    host: parsed.host,
    port: parsed.port === "" ? null : parsed.port,
    hostname: parsed.hostname,
    hash: parsed.hash === "" ? null : parsed.hash,
    search,
    query,
    pathname,
    path: search === null ? pathname : `${pathname}${search}`,
  };
}

export function format(input: Partial<LegacyUrl> & { readonly auth?: string | null }): string {
  const protocol = input.protocol ?? "";
  const slashes = input.slashes === true || protocol !== "" ? "//" : "";
  const auth = input.auth === undefined || input.auth === null ? "" : `${input.auth}@`;
  const host = input.host ?? (input.hostname === undefined || input.hostname === null ? "" : `${input.hostname}${input.port === null || input.port === undefined ? "" : `:${input.port}`}`);
  const pathname = input.pathname ?? "";
  const search = input.search ?? (typeof input.query === "string" ? (input.query === "" ? "" : `?${input.query}`) : "");
  const hash = input.hash ?? "";
  const hashWithPrefix = hash === "" || hash.startsWith("#") ? hash : `#${hash}`;
  return `${protocol}${slashes}${auth}${host}${pathname}${search}${hashWithPrefix}`;
}

export function resolve(from: string, to: string): string {
  try {
    return new URL(to, ABSOLUTE.test(from) ? from : `http://localhost${from.startsWith("/") ? "" : "/"}${from}`).href;
  } catch {
    return to;
  }
}

export function pathToFileURL(path: string): URL {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return new URL(`file://${normalised.split("/").map((part) => encodeURIComponent(part)).join("/")}`);
}

export function fileURLToPath(url: string | URL): string {
  const text = typeof url === "string" ? url : url.href;
  if (!text.startsWith("file://")) throw new TypeError(`The URL must be of scheme file: ${text}`);
  return decodeURIComponent(new URL(text).pathname);
}

export function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return "";
  }
}

export function domainToUnicode(domain: string): string {
  return domainToASCII(domain);
}

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export default { parse, format, resolve, URL, URLSearchParams, pathToFileURL, fileURLToPath, domainToASCII, domainToUnicode };
