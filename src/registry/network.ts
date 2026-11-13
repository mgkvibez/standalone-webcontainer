/**
 * The real npm registry, as the product sees it.
 *
 * Until now the browser workspace installed from the committed offline corpus: ten synthetic `@corpus/*` packages that prove the installer's
 * plumbing and nothing about a published package. This module is the other half of that decision - a `RegistryClient` over
 * `registry.npmjs.org` - and it is deliberately not the fixture runner's client copied across. The two have different jobs: a fixture run is a
 * measurement whose failure must be legible to an auditor, and a workspace install is a user-facing action whose failure must be legible to a
 * person who just typed `npm install react`. So the taxonomy here is a person's taxonomy (not found, network, bad metadata, too big), every
 * request is bounded, and nothing is cached in a way that could install bytes nobody verified.
 *
 * Four decisions are load-bearing:
 *
 * 1. **The abbreviated document, not the full packument.** `Accept: application/vnd.npm.install-v1+json` asks npm for the corgi shape, which
 *    carries exactly what an installer needs (`versions`, `dist-tags`, `dependencies`, `peerDependencies`, `os`, `cpu`, `hasInstallScript`)
 *    and nothing else. Measured: `react`'s full packument is several megabytes of readmes and maintainers; the abbreviated one is a fraction
 *    of that, and it is the same document npm's own client fetches.
 * 2. **HTTPS is a precondition, not a preference.** A registry URL over `http:` is refused before a request is made, and a redirect whose final
 *    URL is not `https:` is refused after. Following redirects quietly is how a transport guarantee becomes a hope.
 * 3. **Every response is bounded while it is read.** A `content-length` is checked when present, and the body is counted as it streams so a
 *    server that lies (or sends no length at all) still cannot hand the tab a huge document.
 * 4. **Metadata expires; bytes are verified instead.** A packument is cached for a short TTL because `latest` must be allowed to move. A tarball
 *    is immutable at its URL, so it is cached without a TTL - and the installer verifies every byte it receives against `dist.integrity` on
 *    every install, which is what makes a cache that cannot poison a tree rather than one that merely tries not to.
 */

import type { Packument, PackumentVersion, RegistryClient } from "../npm/install.js";
import { createMemoryByteCache, type ByteCache } from "./byte-cache.js";

/**
 * Why a registry call failed, in the terms a user or a caller can act on.
 *
 * Kept separate from `InstallError` on purpose: an `InstallError` describes the installer's decision about a tree, and a `RegistryError`
 * describes something the network or a publisher did. Collapsing the two would make "this package does not exist" and "your connection dropped"
 * arrive as the same sentence, which is the failure mode the milestone's error-reporting requirement exists to prevent.
 */
export type RegistryErrorCode =
  | "INSECURE_TRANSPORT"
  | "NETWORK_FAILURE"
  | "PACKAGE_NOT_FOUND"
  | "INVALID_PACKAGE_METADATA"
  | "TARBALL_DOWNLOAD_FAILED"
  | "RESOURCE_LIMIT";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  /** The HTTP status when there was one, so a caller can tell 404 from 503 without parsing the message. */
  readonly status: number | undefined;

  constructor(code: RegistryErrorCode, message: string, status?: number) {
    super(`${code}: ${message}`);
    this.name = "RegistryError";
    this.code = code;
    this.status = status;
  }
}

/** What one install actually did to the network, so an install log can say it rather than imply it. */
export interface RegistryStats {
  /** Requests to the registry for metadata, including misses and retries. */
  metadataRequests: number;
  /** Metadata answered from the cache without a request. */
  metadataCacheHits: number;
  /** Tarball requests that reached the network. */
  tarballRequests: number;
  /** Tarballs answered from the cache without a request. */
  tarballCacheHits: number;
  /** Bytes pulled over the network in total, metadata and tarballs together. */
  bytesDownloaded: number;
}

export interface NetworkRegistryOptions {
  /** Defaults to `https://registry.npmjs.org`. A mirror is allowed as long as it speaks the same API over HTTPS. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Whole-request budget, applied to each metadata and tarball request independently. */
  readonly timeoutMs?: number;
  /** Ceiling for one abbreviated packument. `react`'s is well under this; a document past it is not a packument we can trust. */
  readonly maxMetadataBytes?: number;
  /** Ceiling for one package tarball. The largest package in a typical Vite tree is esbuild-wasm at roughly 11 MB. */
  readonly maxTarballBytes?: number;
  /** How long a resolved packument may satisfy a range without being re-fetched. */
  readonly metadataTtlMs?: number;
  /** How long "this package does not exist" is remembered. Short, because packages are published continuously. */
  readonly metadataMissTtlMs?: number;
  /** Ceiling for the tarball cache when no cache is supplied. */
  readonly cacheBytes?: number;
  readonly cache?: ByteCache;
  readonly now?: () => number;
}

export interface NetworkRegistry extends RegistryClient {
  readonly origin: string;
  stats(): RegistryStats;
  /** Drop every cache. Used when a user asks for a fresh resolution, and by tests between cases. */
  reset(): void;
}

const DEFAULT_BASE_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_METADATA_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const DEFAULT_METADATA_TTL_MS = 5 * 60_000;
const DEFAULT_METADATA_MISS_TTL_MS = 30_000;
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

/** The media type npm's own client sends for an install. It is what makes a packument a resolvable document rather than a web page. */
const INSTALL_ACCEPT = "application/vnd.npm.install-v1+json";

/**
 * Refuse anything that is not HTTPS.
 *
 * `http://localhost` is not an exception, because the registry is never local: a caller pointing at a plaintext mirror has decided the bytes do
 * not need transport protection, and this runtime will not make that decision for its users.
 */
function assertSecure(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegistryError("INSECURE_TRANSPORT", `${what} is not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new RegistryError(
      "INSECURE_TRANSPORT",
      `${what} must be served over https, and ${url} is ${parsed.protocol.replace(":", "")}`,
    );
  }
  return parsed;
}

/** Concatenate the chunks of a streamed body without an intermediate string, which would corrupt binary tarballs. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a response body with a hard ceiling, counting as it arrives.
 *
 * The `content-length` check exists so an obviously oversized document fails before a byte of it is buffered. The counter exists because that
 * header is optional and a server may send it wrong; only counting while reading turns "we asked for at most N bytes" into a property of the
 * bytes we actually hold.
 */
async function readBounded(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RegistryError("RESOURCE_LIMIT", `${what} declares ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  const body = response.body;
  if (body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new RegistryError("RESOURCE_LIMIT", `${what} is ${buffer.byteLength} bytes, over the ${maxBytes}-byte limit`);
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("RESOURCE_LIMIT", `${what} passed the ${maxBytes}-byte limit while downloading`);
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

/**
 * Reject a packument that is not shaped like one.
 *
 * npm's corgi document is machine-generated and has been stable for years, so a document that does not match means the request did not go where
 * the caller thought: a captive portal, a proxy error page served with 200, a mirror that returns HTML. Naming that is much more useful than
 * letting an `undefined` reach the resolver and be reported as "no version satisfies".
 *
 * Every version is checked, not just the chosen one, because the resolver chooses later: a malformed entry that is never selected today becomes a
 * crash the first time a dependent asks for it.
 */
function assertPackument(value: unknown, name: string): Packument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryError("INVALID_PACKAGE_METADATA", `${name}: the registry answered with a document that is not an object`);
  }
  const record = value as Record<string, unknown>;
  const versions = record["versions"];
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    throw new RegistryError("INVALID_PACKAGE_METADATA", `${name}: the registry document has no versions object`);
  }
  for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RegistryError("INVALID_PACKAGE_METADATA", `${name}@${version}: version entry is not an object`);
    }
    const dist = (entry as Record<string, unknown>)["dist"];
    if (typeof dist !== "object" || dist === null) {
      throw new RegistryError("INVALID_PACKAGE_METADATA", `${name}@${version}: version entry has no dist object`);
    }
    const tarball = (dist as Record<string, unknown>)["tarball"];
    if (typeof tarball !== "string" || tarball === "") {
      throw new RegistryError("INVALID_PACKAGE_METADATA", `${name}@${version}: dist.tarball is missing`);
    }
  }
  return value as Packument;
}

/**
 * The registry client the browser product installs from.
 *
 * The shape is the installer's own `RegistryClient`; everything else here is about how the bytes are obtained, bounded and remembered.
 */
export function createNetworkRegistry(options: NetworkRegistryOptions = {}): NetworkRegistry {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  const maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const metadataTtlMs = options.metadataTtlMs ?? DEFAULT_METADATA_TTL_MS;
  const metadataMissTtlMs = options.metadataMissTtlMs ?? DEFAULT_METADATA_MISS_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const origin = assertSecure(baseUrl, "the registry URL").host;
  const cache = options.cache ?? createMemoryByteCache({ maxBytes: options.cacheBytes ?? DEFAULT_CACHE_BYTES });

  interface MetadataEntry {
    readonly packument: Packument | null;
    readonly expiresAt: number;
  }

  const metadata = new Map<string, MetadataEntry>();
  /** A request already in flight for this name, so two dependents asking at once produce one fetch rather than two. */
  const inFlight = new Map<string, Promise<Packument>>();
  const counters: RegistryStats = {
    metadataRequests: 0,
    metadataCacheHits: 0,
    tarballRequests: 0,
    tarballCacheHits: 0,
    bytesDownloaded: 0,
  };

  const withTimeout = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const timedOut = controller.signal.aborted;
      throw new RegistryError(
        "NETWORK_FAILURE",
        timedOut ? `${what} did not answer within ${timeoutMs} ms` : `${what} could not be reached: ${detail}`,
      );
    } finally {
      clearTimeout(timer);
    }
    // A redirect that lands on plaintext has undone the guarantee the request started with, so the final URL is checked too.
    if (response.url !== "" && !response.url.startsWith("https://")) {
      throw new RegistryError("INSECURE_TRANSPORT", `${what} redirected to ${response.url}, which is not https`);
    }
    return response;
  };

  const fetchPackument = async (name: string): Promise<Packument> => {
    // A scoped name's slash is the only character the registry path needs escaped. `encodeURIComponent` would escape the scope marker too.
    const path = name.startsWith("@") ? name.replace("/", "%2F") : name;
    const url = `${baseUrl}/${path}`;
    counters.metadataRequests += 1;
    const response = await withTimeout(url, { headers: { accept: INSTALL_ACCEPT } }, `${name} metadata`);
    if (response.status === 404) {
      throw new RegistryError("PACKAGE_NOT_FOUND", `${name} is not published on ${origin}`, 404);
    }
    if (!response.ok) {
      throw new RegistryError("NETWORK_FAILURE", `${name} metadata returned ${response.status} from ${origin}`, response.status);
    }
    const bytes = await readBounded(response, maxMetadataBytes, `${name} metadata`);
    counters.bytesDownloaded += bytes.byteLength;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new RegistryError(
        "INVALID_PACKAGE_METADATA",
        `${name}: the registry answered with something that is not JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return assertPackument(parsed, name);
  };

  return {
    origin,
    stats: () => ({ ...counters }),

    reset(): void {
      metadata.clear();
      inFlight.clear();
      counters.metadataRequests = 0;
      counters.metadataCacheHits = 0;
      counters.tarballRequests = 0;
      counters.tarballCacheHits = 0;
      counters.bytesDownloaded = 0;
    },

    async packument(name: string): Promise<Packument> {
      const cached = metadata.get(name);
      if (cached !== undefined && cached.expiresAt > now()) {
        counters.metadataCacheHits += 1;
        if (cached.packument === null) {
          throw new RegistryError("PACKAGE_NOT_FOUND", `${name} is not published on ${origin}`, 404);
        }
        return cached.packument;
      }
      const pending = inFlight.get(name);
      if (pending !== undefined) return pending;
      const request = fetchPackument(name).then(
        (packument) => {
          metadata.set(name, { packument, expiresAt: now() + metadataTtlMs });
          inFlight.delete(name);
          return packument;
        },
        (error: unknown) => {
          // A missing package is remembered briefly: a dependency tree with a typo asks for the same unknown name several times, and a
          // 404 per dependent turns one mistake into a burst of requests. A *network* failure is not remembered, because the next attempt
          // may well succeed and caching an outage is how a transient problem becomes a persistent one.
          if (error instanceof RegistryError && error.code === "PACKAGE_NOT_FOUND") {
            metadata.set(name, { packument: null, expiresAt: now() + metadataMissTtlMs });
          }
          inFlight.delete(name);
          throw error;
        },
      );
      inFlight.set(name, request);
      return request;
    },

    async tarball(url: string): Promise<Uint8Array> {
      assertSecure(url, "a package tarball URL");
      const cached = await cache.get(url);
      if (cached !== null) {
        counters.tarballCacheHits += 1;
        return cached;
      }
      counters.tarballRequests += 1;
      const response = await withTimeout(url, {}, `tarball ${url}`);
      if (!response.ok) {
        throw new RegistryError("TARBALL_DOWNLOAD_FAILED", `${url} returned ${response.status}`, response.status);
      }
      const bytes = await readBounded(response, maxTarballBytes, `tarball ${url}`);
      counters.bytesDownloaded += bytes.byteLength;
      // Cached after the read, so a download that fails halfway leaves nothing behind that a later install could pick up as complete.
      await cache.set(url, bytes);
      return bytes;
    },
  };
}

/**
 * A one-line description of a package, so two installs can be compared without diffing trees.
 *
 * Used by tests and by an install log; kept here because it is knowledge about the packument rather than about the installer.
 */
export function describeVersion(entry: PackumentVersion): string {
  const dependencies = Object.keys(entry.dependencies ?? {}).length;
  return `${entry.name}@${entry.version} (${dependencies} dependenc${dependencies === 1 ? "y" : "ies"})`;
}
