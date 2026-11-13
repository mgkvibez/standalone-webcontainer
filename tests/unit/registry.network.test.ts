/**
 * The registry client the product installs from, tested without a network.
 *
 * Every case here is a failure a person can actually meet: a typo'd package name, a dropped connection, a proxy that answers with HTML, a
 * mirror that redirects to plaintext, a publisher whose tarball is enormous. The client's whole job is to make those arrive as different,
 * actionable sentences rather than as one "install failed", so that is what each test asserts - the code, not just that something threw.
 *
 * The cache cases exist because a cache is the one component whose bug is invisible: every install still succeeds, just from stale or twice-fetched
 * bytes. So they count requests rather than trusting a hit to feel fast.
 */

import { describe, expect, it } from "vitest";

import { createNetworkRegistry, RegistryError, describeVersion } from "../../src/registry/network.js";
import { createMemoryByteCache } from "../../src/registry/byte-cache.js";

const packumentFor = (name: string, versions: Record<string, { dependencies?: Record<string, string> }> = {}): string =>
  JSON.stringify({
    name,
    "dist-tags": { latest: Object.keys(versions).at(-1) ?? "1.0.0" },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, entry]) => [
        version,
        { name, version, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` }, ...entry },
      ]),
    ),
  });

interface Call {
  readonly url: string;
  readonly accept: string | null;
}

/** A fetch that answers from a table and records what was asked for. */
function recorder(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, accept: headers.get("accept") });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const isRegistryError = (code: string) => (error: unknown): boolean =>
  error instanceof RegistryError && error.code === code;

describe("the network registry", () => {
  it("asks for the abbreviated install document, and escapes a scoped name's slash", async () => {
    const { fetchImpl, calls } = recorder(() => new Response(packumentFor("@scope/pkg", { "1.0.0": {} }), { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl });
    const packument = await registry.packument("@scope/pkg");
    expect(packument.name).toBe("@scope/pkg");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/@scope%2Fpkg");
    // Without this header npm answers with the full document, which for `react` is megabytes of readmes the installer never reads.
    expect(calls[0]?.accept).toBe("application/vnd.npm.install-v1+json");
    expect(registry.origin).toBe("registry.npmjs.org");
  });

  it("reports a missing package as PACKAGE_NOT_FOUND, carrying the status", async () => {
    const { fetchImpl } = recorder(() => new Response("not found", { status: 404 }));
    const registry = createNetworkRegistry({ fetchImpl });
    await expect(registry.packument("no-such-package")).rejects.toSatisfy(isRegistryError("PACKAGE_NOT_FOUND"));
    await registry.packument("no-such-package").catch((error: unknown) => {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).status).toBe(404);
    });
  });

  it("reports a server error as NETWORK_FAILURE rather than as a missing package", async () => {
    const { fetchImpl } = recorder(() => new Response("upstream is down", { status: 503 }));
    const registry = createNetworkRegistry({ fetchImpl });
    await expect(registry.packument("react")).rejects.toSatisfy(isRegistryError("NETWORK_FAILURE"));
  });

  it("reports a document that is not JSON, and one that is JSON but not a packument", async () => {
    const html = recorder(() => new Response("<!doctype html><title>proxy</title>", { status: 200 }));
    await expect(createNetworkRegistry({ fetchImpl: html.fetchImpl }).packument("react")).rejects.toSatisfy(
      isRegistryError("INVALID_PACKAGE_METADATA"),
    );

    const noVersions = recorder(() => new Response(JSON.stringify({ name: "react" }), { status: 200 }));
    await expect(createNetworkRegistry({ fetchImpl: noVersions.fetchImpl }).packument("react")).rejects.toSatisfy(
      isRegistryError("INVALID_PACKAGE_METADATA"),
    );
  });

  it("rejects a version entry with no tarball, naming the version", async () => {
    const broken = JSON.stringify({ name: "x", versions: { "1.0.0": { name: "x", version: "1.0.0", dist: {} } } });
    const { fetchImpl } = recorder(() => new Response(broken, { status: 200 }));
    await expect(createNetworkRegistry({ fetchImpl }).packument("x")).rejects.toThrow(/x@1\.0\.0: dist\.tarball is missing/);
  });

  it("refuses a plaintext registry at construction, before any request can be made", () => {
    const { fetchImpl, calls } = recorder(() => new Response("{}", { status: 200 }));
    // Refused eagerly rather than on first use: a client that already knows its transport is wrong should not exist to be handed to an installer.
    expect(() => createNetworkRegistry({ baseUrl: "http://registry.npmjs.org", fetchImpl })).toThrow(/must be served over https/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a tarball URL that is not HTTPS", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl });
    await expect(registry.tarball("http://registry.npmjs.org/react/-/react-18.0.0.tgz")).rejects.toSatisfy(
      isRegistryError("INSECURE_TRANSPORT"),
    );
  });

  it("refuses a redirect whose final URL is plaintext", async () => {
    const response = new Response(packumentFor("react", { "18.0.0": {} }), { status: 200 });
    Object.defineProperty(response, "url", { value: "http://registry.npmjs.org/react" });
    const { fetchImpl } = recorder(() => response);
    await expect(createNetworkRegistry({ fetchImpl }).packument("react")).rejects.toSatisfy(
      isRegistryError("INSECURE_TRANSPORT"),
    );
  });

  it("serves a repeat resolution from the cache inside the TTL, and re-fetches after it", async () => {
    let clock = 0;
    const { fetchImpl, calls } = recorder(() => new Response(packumentFor("react", { "18.3.1": {} }), { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl, metadataTtlMs: 1_000, now: () => clock });
    await registry.packument("react");
    await registry.packument("react");
    expect(calls).toHaveLength(1);
    expect(registry.stats().metadataCacheHits).toBe(1);
    clock = 1_001;
    await registry.packument("react");
    expect(calls).toHaveLength(2);
  });

  it("dedupes two dependents asking for the same package at once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = recorder(async () => {
      await gate;
      return new Response(packumentFor("react", { "18.3.1": {} }), { status: 200 });
    });
    const registry = createNetworkRegistry({ fetchImpl });
    const first = registry.packument("react");
    const second = registry.packument("react");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("remembers a missing package briefly, and forgets it once the miss TTL passes", async () => {
    let clock = 0;
    let published = false;
    const { fetchImpl, calls } = recorder(() =>
      published
        ? new Response(packumentFor("later", { "1.0.0": {} }), { status: 200 })
        : new Response("no", { status: 404 }),
    );
    const registry = createNetworkRegistry({ fetchImpl, metadataMissTtlMs: 500, now: () => clock });
    await expect(registry.packument("later")).rejects.toSatisfy(isRegistryError("PACKAGE_NOT_FOUND"));
    published = true;
    await expect(registry.packument("later")).rejects.toSatisfy(isRegistryError("PACKAGE_NOT_FOUND"));
    expect(calls).toHaveLength(1);
    clock = 501;
    const packument = await registry.packument("later");
    expect(packument.name).toBe("later");
    expect(calls).toHaveLength(2);
  });

  it("does not cache a network failure, because the next attempt may succeed", async () => {
    let fail = true;
    const { fetchImpl, calls } = recorder(() =>
      fail ? new Response("down", { status: 502 }) : new Response(packumentFor("react", { "18.3.1": {} }), { status: 200 }),
    );
    const registry = createNetworkRegistry({ fetchImpl });
    await expect(registry.packument("react")).rejects.toSatisfy(isRegistryError("NETWORK_FAILURE"));
    fail = false;
    await expect(registry.packument("react")).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("refuses a metadata document that declares more bytes than the ceiling", async () => {
    const { fetchImpl } = recorder(
      () => new Response("{}", { status: 200, headers: { "content-length": "999999999" } }),
    );
    await expect(createNetworkRegistry({ fetchImpl, maxMetadataBytes: 1024 }).packument("react")).rejects.toSatisfy(
      isRegistryError("RESOURCE_LIMIT"),
    );
  });

  it("counts a streamed body against the ceiling even with no content-length", async () => {
    // Eight 1 KiB chunks, no declared length: only counting while reading catches this.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index += 1) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const { fetchImpl } = recorder(() => new Response(stream, { status: 200 }));
    await expect(createNetworkRegistry({ fetchImpl, maxMetadataBytes: 4096 }).packument("react")).rejects.toSatisfy(
      isRegistryError("RESOURCE_LIMIT"),
    );
  });

  it("gives up on a request that never answers, and says how long it waited", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const registry = createNetworkRegistry({ fetchImpl, timeoutMs: 20 });
    await expect(registry.packument("react")).rejects.toThrow(/did not answer within 20 ms/);
  });

  it("downloads a tarball once and serves the second install from the cache", async () => {
    const bytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
    const { fetchImpl, calls } = recorder(() => new Response(bytes, { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl });
    const url = "https://registry.npmjs.org/react/-/react-18.3.1.tgz";
    const first = await registry.tarball(url);
    const second = await registry.tarball(url);
    expect([...first]).toEqual([...bytes]);
    expect([...second]).toEqual([...bytes]);
    expect(calls).toHaveLength(1);
    expect(registry.stats().tarballRequests).toBe(1);
    expect(registry.stats().tarballCacheHits).toBe(1);
    expect(registry.stats().bytesDownloaded).toBe(bytes.byteLength);
  });

  it("refuses a tarball over its ceiling and caches nothing partial", async () => {
    const cache = createMemoryByteCache({ maxBytes: 1024 * 1024 });
    const { fetchImpl } = recorder(() => new Response(new Uint8Array(4096), { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl, maxTarballBytes: 1024, cache });
    const url = "https://registry.npmjs.org/big/-/big-1.0.0.tgz";
    await expect(registry.tarball(url)).rejects.toSatisfy(isRegistryError("RESOURCE_LIMIT"));
    expect(await cache.get(url)).toBeNull();
  });

  it("reports a tarball 404 as TARBALL_DOWNLOAD_FAILED, not as a missing package", async () => {
    const { fetchImpl } = recorder(() => new Response("gone", { status: 404 }));
    const registry = createNetworkRegistry({ fetchImpl });
    await expect(registry.tarball("https://registry.npmjs.org/x/-/x-1.0.0.tgz")).rejects.toSatisfy(
      isRegistryError("TARBALL_DOWNLOAD_FAILED"),
    );
  });

  it("forgets everything on reset, so a fresh resolution really is fresh", async () => {
    const { fetchImpl, calls } = recorder(() => new Response(packumentFor("react", { "18.3.1": {} }), { status: 200 }));
    const registry = createNetworkRegistry({ fetchImpl });
    await registry.packument("react");
    registry.reset();
    expect(registry.stats().metadataRequests).toBe(0);
    await registry.packument("react");
    expect(calls).toHaveLength(2);
  });

  it("describes a package in one line", () => {
    expect(
      describeVersion({ name: "react", version: "18.3.1", dist: { tarball: "https://x/y.tgz" }, dependencies: { a: "1" } }),
    ).toBe("react@18.3.1 (1 dependency)");
  });
});

describe("the memory byte cache", () => {
  it("evicts the least recently used entry when the budget is exceeded", async () => {
    const cache = createMemoryByteCache({ maxBytes: 8 });
    await cache.set("a", new Uint8Array(4));
    await cache.set("b", new Uint8Array(4));
    expect(await cache.get("a")).not.toBeNull();
    // "b" is now the least recently used, so adding "c" must evict it rather than "a".
    await cache.set("c", new Uint8Array(4));
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  it("never stores an entry larger than the whole cache", async () => {
    const cache = createMemoryByteCache({ maxBytes: 4 });
    await cache.set("big", new Uint8Array(16));
    expect(await cache.get("big")).toBeNull();
  });
});
