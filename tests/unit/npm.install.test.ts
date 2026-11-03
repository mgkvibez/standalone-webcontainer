/**
 * The installer against a fake registry and the real VFS.
 *
 * No network, no mocks of the code under test: the registry client is injected, so these exercise the real
 * resolver, the real tarball reader and the real filesystem, and assert on where files actually land.
 *
 * Where a test asserts a *path*, that path is the contract: Node's resolution walks up from a dependent, so a
 * nested copy at `node_modules/c/node_modules/b` is what makes a version conflict work.
 */

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  createHttpRegistryClient,
  installDependencies,
  InstallError,
  type Packument,
  type RegistryClient,
} from "../../src/npm/install.js";
import { FileSystem } from "../../src/vfs/index.js";
import { makePackageTarball, makeTar, packument, type FakeVersion } from "../helpers/tarball.js";

const decoder = new TextDecoder();

interface FakeRegistryOptions {
  readonly packages: Readonly<Record<string, readonly FakeVersion[]>>;
  /** Optional latest tag overrides, per package. */
  readonly latest?: Readonly<Record<string, string>>;
  readonly withIntegrity?: boolean;
}

function tarballFor(entry: FakeVersion): Uint8Array {
  return (
    entry.rawTarball ??
    makePackageTarball(entry.files ?? { "index.js": `module.exports = ${JSON.stringify(entry.name)};` }, {
      name: entry.name,
      version: entry.version,
      dependencies: entry.dependencies ?? {},
    })
  );
}

async function sha512Integrity(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-512", owned);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha512-${btoa(binary)}`;
}

async function fakeRegistry(options: FakeRegistryOptions): Promise<RegistryClient & { fetched: string[] }> {
  const fetched: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const packuments = new Map<string, Packument>();

  for (const [name, versions] of Object.entries(options.packages)) {
    const withDist: FakeVersion[] = [];
    for (const entry of versions) {
      const bytes = tarballFor(entry);
      tarballs.set(`https://registry.test/${name}/-/${name}-${entry.version}.tgz`, bytes);
      const integrity = options.withIntegrity === false ? undefined : (entry.integrity ?? (await sha512Integrity(bytes)));
      withDist.push(integrity === undefined ? { ...entry } : { ...entry, integrity });
    }
    packuments.set(name, packument(name, withDist, options.latest?.[name]) as unknown as Packument);
  }

  return {
    fetched,
    async packument(name: string): Promise<Packument> {
      fetched.push(name);
      const found = packuments.get(name);
      if (found === undefined) throw new InstallError("REGISTRY_ERROR", `404 for ${name}`);
      return found;
    },
    async tarball(url: string): Promise<Uint8Array> {
      const found = tarballs.get(url);
      if (found === undefined) throw new InstallError("REGISTRY_ERROR", `404 for ${url}`);
      return found;
    },
  };
}

/** The VFS reports existence by throwing from statSync, so tests get a predicate rather than try/catch each time. */
function exists(vfs: FileSystem, path: string): boolean {
  try {
    vfs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a file as text whether the VFS handed back a string or bytes. */
function text(vfs: FileSystem, path: string): string {
  const contents = vfs.readFileSync(path);
  return typeof contents === "string" ? contents : decoder.decode(contents);
}

function boot(): { vfs: FileSystem; root: string } {
  const vfs = new FileSystem();
  vfs.mkdirSync("/app", { recursive: true });
  return { vfs, root: "/app" };
}

describe("installDependencies", () => {
  it("installs a single dependency and writes its files", async () => {
    const registry = await fakeRegistry({
      packages: { a: [{ name: "a", version: "1.0.0", files: { "index.js": "exports.a = 1;" } }] },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });

    expect(report.packages).toEqual([{ name: "a", version: "1.0.0", path: "/app/node_modules/a" }]);
    expect(text(vfs, "/app/node_modules/a/index.js")).toBe("exports.a = 1;");
    // The package.json inside the tarball is real, and its wrapper directory was stripped.
    expect(JSON.parse(text(vfs, "/app/node_modules/a/package.json"))).toMatchObject({
      name: "a",
      version: "1.0.0",
    });
  });

  it("picks the highest version that satisfies the range, not the newest published", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [
          { name: "a", version: "1.0.0" },
          { name: "a", version: "1.1.0" },
          { name: "a", version: "2.0.0" },
        ],
      },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages[0]?.version).toBe("1.1.0");
  });

  it("walks transitive dependencies", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { b: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0" }],
      },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(exists(vfs, "/app/node_modules/b/index.js")).toBe(true);
  });

  it("installs one copy for a shared dependency", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { c: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0", dependencies: { c: "^1.0.0" } }],
        c: [{ name: "c", version: "1.0.0" }],
      },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0", b: "^1.0.0" } }, { registry, vfs, root });
    const copies = report.packages.filter((entry) => entry.name === "c");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.path).toBe("/app/node_modules/c");
  });

  it("nests a conflicting version under the dependent that needs it", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { shared: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0", dependencies: { shared: "^2.0.0" } }],
        shared: [
          { name: "shared", version: "1.0.0", files: { "index.js": "exports.v = 1;" } },
          { name: "shared", version: "2.0.0", files: { "index.js": "exports.v = 2;" } },
        ],
      },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0", b: "^1.0.0" } }, { registry, vfs, root });
    const shared = report.packages.filter((entry) => entry.name === "shared").map((entry) => entry.path).sort();

    // One copy at the root, one nested where a dependent that cannot use it lives.
    expect(shared).toEqual(["/app/node_modules/b/node_modules/shared", "/app/node_modules/shared"]);
    expect(text(vfs, "/app/node_modules/shared/index.js")).toBe("exports.v = 1;");
    expect(text(vfs, "/app/node_modules/b/node_modules/shared/index.js")).toBe("exports.v = 2;");
  });

  it("resolves a dist-tag range such as latest", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [
          { name: "a", version: "1.0.0" },
          { name: "a", version: "1.5.0" },
          { name: "a", version: "2.0.0" },
        ],
      },
      latest: { a: "1.5.0" },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "latest" } }, { registry, vfs, root });
    expect(report.packages[0]?.version).toBe("1.5.0");
  });

  it("terminates on a dependency cycle", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { b: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0", dependencies: { a: "^1.0.0" } }],
      },
    });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages.map((entry) => entry.name).sort()).toEqual(["a", "b"]);
  });

  it("installs a scoped package at its scoped path", async () => {
    const registry = await fakeRegistry({ packages: { "@scope/pkg": [{ name: "@scope/pkg", version: "1.0.0" }] } });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { "@scope/pkg": "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages[0]?.path).toBe("/app/node_modules/@scope/pkg");
    expect(exists(vfs, "/app/node_modules/@scope/pkg/index.js")).toBe(true);
  });

  it("adds devDependencies only when asked", async () => {
    const registry = await fakeRegistry({ packages: { dev: [{ name: "dev", version: "1.0.0" }] } });

    const withoutDev = boot();
    await installDependencies({ devDependencies: { dev: "^1.0.0" } }, { registry, vfs: withoutDev.vfs, root: withoutDev.root });
    expect(exists(withoutDev.vfs, "/app/node_modules/dev")).toBe(false);

    const withDev = boot();
    const report = await installDependencies(
      { devDependencies: { dev: "^1.0.0" } },
      { registry, vfs: withDev.vfs, root: withDev.root, includeDev: true },
    );
    expect(report.packages.map((entry) => entry.name)).toEqual(["dev"]);
  });

  it("refuses a tarball whose bytes do not match the published integrity", async () => {
    const registry = await fakeRegistry({
      packages: { a: [{ name: "a", version: "1.0.0", integrity: await sha512Integrity(new TextEncoder().encode("something else")) }] },
    });
    const { vfs, root } = boot();

    await expect(installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root })).rejects.toThrow(
      /INTEGRITY_MISMATCH/,
    );
    // Nothing from an unverified tarball may reach the file system.
    expect(exists(vfs, "/app/node_modules/a/index.js")).toBe(false);
  });

  it("warns instead of failing when no integrity was published", async () => {
    const registry = await fakeRegistry({ packages: { a: [{ name: "a", version: "1.0.0" }] }, withIntegrity: false });
    const { vfs, root } = boot();

    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.warnings.join(" ")).toMatch(/no integrity field published/);
    expect(exists(vfs, "/app/node_modules/a/index.js")).toBe(true);
  });

  it("reports an unsatisfiable range with the newest published version named", async () => {
    const registry = await fakeRegistry({ packages: { a: [{ name: "a", version: "1.0.0" }] } });
    const { vfs, root } = boot();

    await expect(installDependencies({ dependencies: { a: "^9.0.0" } }, { registry, vfs, root })).rejects.toThrow(
      /no version of a satisfies "\^9\.0\.0" \(newest is 1\.0\.0\)/,
    );
  });

  it("stops at the package limit rather than filling the tab", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { b: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0", dependencies: { c: "^1.0.0" } }],
        c: [{ name: "c", version: "1.0.0" }],
      },
    });
    const { vfs, root } = boot();

    await expect(
      installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root, maxPackages: 2 }),
    ).rejects.toThrow(/TOO_MANY_PACKAGES/);
  });

  it("refuses a tarball that tries to escape the package directory", async () => {
    // Two files: one legitimate, one climbing out of node_modules.
    const escape = new Uint8Array(
      gzipSync(
        makeTar([
          { path: "package/index.js", data: "ok" },
          { path: "package/../../../escaped.js", data: "pwned" },
        ]),
      ),
    );
    const registry = await fakeRegistry({
      packages: { a: [{ name: "a", version: "1.0.0", rawTarball: escape }] },
    });
    const { vfs, root } = boot();

    await expect(installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root })).rejects.toThrow(
      /path traversal/,
    );
    expect(exists(vfs, "/escaped.js")).toBe(false);
  });

  it("does not refetch a packument for a repeated package", async () => {
    const registry = await fakeRegistry({
      packages: {
        a: [{ name: "a", version: "1.0.0", dependencies: { c: "^1.0.0" } }],
        b: [{ name: "b", version: "1.0.0", dependencies: { c: "^1.0.0" } }],
        c: [{ name: "c", version: "1.0.0" }],
      },
    });
    const { vfs, root } = boot();

    await installDependencies({ dependencies: { a: "^1.0.0", b: "^1.0.0" } }, { registry, vfs, root });
    expect(registry.fetched.filter((name) => name === "c")).toHaveLength(1);
  });
});

describe("createHttpRegistryClient", () => {
  it("escapes a scoped name onto the registry path", async () => {
    const seen: string[] = [];
    const client = createHttpRegistryClient({
      baseUrl: "https://registry.test/",
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ name: "@scope/pkg", versions: {} }), { status: 200 });
      },
    });

    await client.packument("@scope/pkg");
    expect(seen[0]).toBe("https://registry.test/@scope%2Fpkg");
  });

  it("turns a non-OK response into a clear registry error", async () => {
    const client = createHttpRegistryClient({
      baseUrl: "https://registry.test",
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });

    await expect(client.packument("missing")).rejects.toThrow(/GET missing returned 404/);
  });

  it("returns tarball bytes untouched", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = createHttpRegistryClient({
      baseUrl: "https://registry.test",
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    });

    expect([...(await client.tarball("https://registry.test/a.tgz"))]).toEqual([1, 2, 3]);
  });
});
