/**
 * The lockfile decision (ADR-0006 D-18) and the platform filter (D-19).
 *
 * Two things are being proved here, and they are different in kind:
 *
 * 1. **Round trip**: what the installer writes can be read back by us, and a lockfile written by real npm (with
 *    all the fields we ignore) still reads correctly.
 * 2. **Determinism**: installing from a lockfile pins versions and touches the registry for tarballs only, never
 *    for resolution. That is the whole reason to have a lockfile, so it is asserted by forbidding packument
 *    fetches rather than by inspecting the result and hoping.
 *
 * The golden end-to-end test (installing conflicting majors and requiring both) lives in
 * npm.runtime-integration.test.ts and is unchanged by this work.
 */

import { describe, expect, it } from "vitest";

import {
  installDependencies,
  loadLockfile,
  type InstallReport,
  type RegistryClient,
} from "../../src/npm/install.js";
import {
  lockfileKey,
  LockfileError,
  parseLockfile,
  serializeLockfile,
  type Lockfile,
} from "../../src/npm/lockfile.js";
import { createFakeRegistry, type FakeRegistry } from "../helpers/registry.js";
import { bootVfs, exists, text } from "../helpers/vfs.js";

/** A registry that serves tarballs but refuses to resolve, proving resolution came from the lockfile. */
function tarballsOnly(registry: FakeRegistry): RegistryClient {
  return {
    async packument(name: string) {
      throw new Error(`packument for ${name} must not be fetched when a lockfile is complete`);
    },
    tarball: (url: string) => registry.tarball(url),
  };
}

const basicPackages = {
  greeter: [{ version: "1.0.0", files: { "index.js": "module.exports = 'hi';" } }],
} as const;

describe("lockfile model", () => {
  it("serialises deterministically: sorted keys, root first, trailing newline", () => {
    const lockfile: Lockfile = {
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "node_modules/zeta": { version: "2.0.0", resolved: "https://r/z.tgz" },
        "": { name: "demo", version: "1.0.0", dependencies: { zeta: "^2.0.0", alpha: "^1.0.0" } },
        "node_modules/alpha": { version: "1.0.0", resolved: "https://r/a.tgz" },
      },
    };

    const first = serializeLockfile(lockfile);
    const second = serializeLockfile(lockfile);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(first) as { packages: Record<string, unknown> };
    expect(Object.keys(parsed.packages)).toEqual(["", "node_modules/alpha", "node_modules/zeta"]);
    // Dependency maps are sorted too, so an unchanged tree never produces a diff.
    expect(Object.keys((parsed.packages[""] as { dependencies: Record<string, string> }).dependencies)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("round-trips through parse and serialise without loss", () => {
    const original: Lockfile = {
      name: "demo",
      version: "0.1.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "demo", version: "0.1.0", dependencies: { a: "^1.0.0" } },
        "node_modules/a": {
          version: "1.2.3",
          resolved: "https://r/a.tgz",
          integrity: "sha512-abc",
          dependencies: { b: "~2.0.0" },
        },
        "node_modules/b": { version: "2.0.1", resolved: "https://r/b.tgz", optional: true },
      },
    };

    expect(parseLockfile(serializeLockfile(original))).toEqual(original);
  });

  it("reads a lockfile written by real npm, ignoring fields we do not model", () => {
    // Trimmed from an actual npm v3 lockfile: license, engines, bin, dev, peerDependencies and more.
    const npmWritten = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "demo", version: "1.0.0", license: "MIT", dependencies: { a: "^1.0.0" } },
        "node_modules/a": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
          integrity: "sha512-xyz",
          dev: false,
          license: "MIT",
          engines: { node: ">=14" },
          bin: { a: "cli.js" },
          dependencies: { b: "^2.0.0" },
          peerDependencies: { c: "^3.0.0" },
        },
      },
    });

    const parsed = parseLockfile(npmWritten);
    expect(parsed.packages["node_modules/a"]).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      integrity: "sha512-xyz",
      dependencies: { b: "^2.0.0" },
    });
  });

  it("refuses a lockfile version it cannot honestly read, naming what it found", () => {
    for (const version of [1, 2, 4]) {
      const text_ = JSON.stringify({ lockfileVersion: version, packages: {} });
      expect(() => parseLockfile(text_)).toThrow(new RegExp(`UNSUPPORTED_LOCKFILE_VERSION.*found lockfileVersion ${version}`));
    }
  });

  it("refuses structurally broken input with a specific reason", () => {
    expect(() => parseLockfile("{")).toThrow(/UNPARSEABLE_LOCKFILE/);
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 3 }))).toThrow(/packages is missing/);
    expect(() =>
      parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: 7 } } })),
    ).toThrow(/is not a string/);
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: [] }))).toThrow(/not an object/);
  });

  it("maps absolute paths to npm's relative key form", () => {
    expect(lockfileKey("/app", "/app")).toBe("");
    expect(lockfileKey("/app", "/app/node_modules/a")).toBe("node_modules/a");
    expect(lockfileKey("/app", "/app/node_modules/b/node_modules/shared")).toBe("node_modules/b/node_modules/shared");
    expect(lockfileKey("/app/", "/app/node_modules/a")).toBe("node_modules/a");
  });

  it("exposes LockfileError with a machine-readable reason", () => {
    try {
      parseLockfile("nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError);
      expect((error as LockfileError).reason).toBe("UNPARSEABLE_LOCKFILE");
    }
  });
});

describe("writing a lockfile", () => {
  it("writes package-lock.json into the project root", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages });
    const { vfs, root } = bootVfs();

    await installDependencies({ name: "demo", version: "1.0.0", dependencies: { greeter: "^1.0.0" } }, { registry, vfs, root });

    const written = JSON.parse(text(vfs, "/app/package-lock.json")) as {
      name: string;
      version: string;
      lockfileVersion: number;
      packages: Record<string, Record<string, unknown>>;
    };

    expect(written.lockfileVersion).toBe(3);
    expect(written.name).toBe("demo");
    expect(written.packages[""]).toMatchObject({ name: "demo", version: "1.0.0", dependencies: { greeter: "^1.0.0" } });
    expect(written.packages["node_modules/greeter"]).toMatchObject({
      version: "1.0.0",
      resolved: "https://registry.test/greeter/-/greeter-1.0.0.tgz",
      integrity: expect.stringMatching(/^sha512-/) as unknown as string,
    });
  });

  it("records only the documented subset, not npm's whole field set", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages });
    const { vfs, root } = bootVfs();

    await installDependencies({ dependencies: { greeter: "^1.0.0" } }, { registry, vfs, root });
    const entry = (JSON.parse(text(vfs, "/app/package-lock.json")) as { packages: Record<string, unknown> })
      .packages["node_modules/greeter"] as Record<string, unknown>;

    expect(Object.keys(entry).sort()).toEqual(["integrity", "resolved", "version"]);
  });

  it("computes an integrity value even when the registry publishes none", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages, withIntegrity: false });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, { registry, vfs, root });
    const entry = report.lockfile.packages["node_modules/greeter"];

    // Without this, the next install from this lockfile could verify nothing at all.
    expect(entry?.integrity).toMatch(/^sha512-/);
    expect(report.warnings.join(" ")).toMatch(/no integrity field published/);
  });

  it("writes the same bytes for the same inputs, twice", async () => {
    const first = bootVfs();
    const second = bootVfs();
    // Two separate registry instances, so caching inside one cannot be what makes the results agree.
    await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: await createFakeRegistry({ packages: basicPackages }),
      vfs: first.vfs,
      root: first.root,
    });
    await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: await createFakeRegistry({ packages: basicPackages }),
      vfs: second.vfs,
      root: second.root,
    });

    expect(text(first.vfs, "/app/package-lock.json")).toBe(text(second.vfs, "/app/package-lock.json"));
  });

  it("can be told not to write one", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, { registry, vfs, root, writeLockfile: false });
    expect(exists(vfs, "/app/package-lock.json")).toBe(false);
    // The report still describes the tree, so a caller can persist it elsewhere.
    expect(report.lockfile.packages["node_modules/greeter"]?.version).toBe("1.0.0");
  });
});

describe("installing from a lockfile", () => {
  it("needs no resolution at all when the lockfile is complete", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages });
    const first = bootVfs();
    const report = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry,
      vfs: first.vfs,
      root: first.root,
    });

    const second = bootVfs();
    const pinned = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: tarballsOnly(registry),
      vfs: second.vfs,
      root: second.root,
      lockfile: report.lockfile,
    });

    expect(pinned.packages).toEqual([{ name: "greeter", version: "1.0.0", path: "/app/node_modules/greeter" }]);
    expect(text(second.vfs, "/app/node_modules/greeter/index.js")).toBe("module.exports = 'hi';");
  });

  it("keeps a pinned version even when the registry has published a newer one", async () => {
    const original = await createFakeRegistry({
      packages: { greeter: [{ version: "1.0.0" }, { version: "2.0.0" }] },
    });
    const first = bootVfs();
    const report = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: original,
      vfs: first.vfs,
      root: first.root,
    });
    expect(report.packages[0]?.version).toBe("1.0.0");

    // The publisher ships 2.0.0, and a manifest range that would allow it is not relevant: the lockfile wins.
    const later = await createFakeRegistry({ packages: { greeter: [{ version: "1.0.0" }, { version: "2.0.0" }] } });
    const second = bootVfs();
    const pinned = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: tarballsOnly(later),
      vfs: second.vfs,
      root: second.root,
      lockfile: report.lockfile,
    });

    expect(pinned.packages[0]?.version).toBe("1.0.0");
  });

  it("keeps a dist-tag manifest pinned, because the lockfile is the record of what the tag meant", async () => {
    const registry = await createFakeRegistry({
      packages: { greeter: [{ version: "1.0.0" }, { version: "1.5.0" }, { version: "2.0.0" }] },
      latest: { greeter: "1.5.0" },
    });
    const first = bootVfs();
    const report = await installDependencies({ dependencies: { greeter: "latest" } }, {
      registry,
      vfs: first.vfs,
      root: first.root,
    });
    expect(report.packages[0]?.version).toBe("1.5.0");

    const second = bootVfs();
    const pinned = await installDependencies({ dependencies: { greeter: "latest" } }, {
      registry: tarballsOnly(registry),
      vfs: second.vfs,
      root: second.root,
      lockfile: report.lockfile,
    });
    expect(pinned.packages[0]?.version).toBe("1.5.0");
  });

  it("re-resolves and warns when the lockfile no longer satisfies the manifest", async () => {
    const stale: Lockfile = {
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: { greeter: "^2.0.0" } },
        "node_modules/greeter": { version: "1.0.0", resolved: "https://registry.test/greeter/-/greeter-1.0.0.tgz" },
      },
    };
    const registry = await createFakeRegistry({ packages: { greeter: [{ version: "1.0.0" }, { version: "2.1.0" }] } });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { greeter: "^2.0.0" } }, {
      registry,
      vfs,
      root,
      lockfile: stale,
    });

    expect(report.packages[0]?.version).toBe("2.1.0");
    expect(report.warnings.join(" ")).toMatch(/lockfile pins 1\.0\.0, which does not satisfy "\^2\.0\.0"; re-resolved/);
  });

  it("reads an entry with no dependencies as a package with none, without asking the registry", async () => {
    // This is npm's meaning: `dependencies` is present exactly when the package declares any. Treating absence as
    // "unknown" would send every leaf package back to the registry and make offline reinstall impossible.
    const sparse: Lockfile = {
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: { outer: "^1.0.0" } },
        "node_modules/outer": { version: "1.0.0", resolved: "https://registry.test/outer/-/outer-1.0.0.tgz" },
      },
    };
    const registry = await createFakeRegistry({
      packages: {
        outer: [{ version: "1.0.0", dependencies: { inner: "^1.0.0" } }, { version: "2.0.0" }],
        inner: [{ version: "1.0.0" }],
      },
    });
    // The entry below deliberately has no `dependencies` key.
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { outer: "^1.0.0" } }, { registry, vfs, root, lockfile: sparse });

    expect(report.packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual(["outer@1.0.0"]);
    expect(registry.fetched).toEqual([]);
  });

  it("honours the nested placement recorded in a lockfile", async () => {
    const registry = await createFakeRegistry({
      packages: {
        one: [{ version: "1.0.0", dependencies: { shared: "^1.0.0" } }],
        two: [{ version: "1.0.0", dependencies: { shared: "^2.0.0" } }],
        shared: [
          { version: "1.0.0", files: { "index.js": "module.exports = 'v1';" } },
          { version: "2.0.0", files: { "index.js": "module.exports = 'v2';" } },
        ],
      },
    });
    const first = bootVfs();
    const report = await installDependencies({ dependencies: { one: "^1.0.0", two: "^1.0.0" } }, {
      registry,
      vfs: first.vfs,
      root: first.root,
    });
    // The lockfile records where the duplicate lives, which is what makes a reinstall identical.
    expect(Object.keys(report.lockfile.packages).sort()).toEqual([
      "",
      "node_modules/one",
      "node_modules/shared",
      "node_modules/two",
      "node_modules/two/node_modules/shared",
    ]);

    const second = bootVfs();
    const pinned = await installDependencies({ dependencies: { one: "^1.0.0", two: "^1.0.0" } }, {
      registry: tarballsOnly(registry),
      vfs: second.vfs,
      root: second.root,
      lockfile: report.lockfile,
    });

    expect(pinned.packages.map((entry) => entry.path).sort()).toEqual([
      "/app/node_modules/one",
      "/app/node_modules/shared",
      "/app/node_modules/two",
      "/app/node_modules/two/node_modules/shared",
    ]);
    expect(text(second.vfs, "/app/node_modules/two/node_modules/shared/index.js")).toBe("module.exports = 'v2';");
  });
});

describe("reading a lockfile from the project directory", () => {
  it("returns null when the project has no lockfile", () => {
    const { vfs, root } = bootVfs();
    expect(loadLockfile(vfs, root)).toBeNull();
  });

  it("reads the file the installer wrote, and installs from it offline", async () => {
    const registry = await createFakeRegistry({ packages: basicPackages });
    const first = bootVfs();
    await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry,
      vfs: first.vfs,
      root: first.root,
    });

    // This is the whole round trip: write, read back off the file system, reinstall with no resolution at all.
    const onDisk = loadLockfile(first.vfs, first.root);
    expect(onDisk?.packages["node_modules/greeter"]?.version).toBe("1.0.0");

    const second = bootVfs();
    second.vfs.writeFileSync("/app/package-lock.json", text(first.vfs, "/app/package-lock.json"));
    const pinned = await installDependencies({ dependencies: { greeter: "^1.0.0" } }, {
      registry: tarballsOnly(registry),
      vfs: second.vfs,
      root: second.root,
      lockfile: loadLockfile(second.vfs, second.root),
    });

    expect(pinned.packages.map((entry) => entry.version)).toEqual(["1.0.0"]);
  });

  it("refuses to pretend a corrupt lockfile is absent", () => {
    const { vfs, root } = bootVfs();
    vfs.writeFileSync("/app/package-lock.json", "{ this is not json");
    // Falling back to a registry resolve here would make a broken lockfile invisible until the versions drifted.
    expect(() => loadLockfile(vfs, root)).toThrow(/UNPARSEABLE_LOCKFILE/);
  });
});

describe("platform-specific packages", () => {
  it("skips an OS-specific optional dependency and says so", async () => {
    const registry = await createFakeRegistry({
      packages: {
        watcher: [{ version: "1.0.0", optionalDependencies: { fsevents: "^2.0.0" } }],
        fsevents: [{ version: "2.3.3", os: ["darwin"], files: { "index.js": "// native" } }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { watcher: "^1.0.0" } }, { registry, vfs, root });

    expect(report.packages.map((entry) => entry.name)).toEqual(["watcher"]);
    expect(exists(vfs, "/app/node_modules/fsevents")).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/fsevents@2\.3\.3 skipped: platform-specific \(darwin, any cpu\)/);
  });

  it("skips an architecture-specific optional dependency, as native build tools publish them", async () => {
    const registry = await createFakeRegistry({
      packages: {
        // Deliberately not esbuild: esbuild now resolves to esbuild-wasm through the substitution table, and the wasm build publishes no
        // platform binaries at all, so a test named after esbuild would be exercising a path no real esbuild install takes any more.
        "swc-binary": [{ version: "0.20.0", optionalDependencies: { "@swc-binary/darwin-x64": "0.20.0" } }],
        "@swc-binary/darwin-x64": [{ version: "0.20.0", os: ["darwin"], cpu: ["x64"], files: { "bin": "binary" } }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { "swc-binary": "^0.20.0" } }, { registry, vfs, root });

    expect(report.packages.map((entry) => entry.name)).toEqual(["swc-binary"]);
    expect(report.warnings.join(" ")).toMatch(/darwin, x64/);
  });

  it("installs a portable optional dependency", async () => {
    const registry = await createFakeRegistry({
      packages: {
        watcher: [{ version: "1.0.0", optionalDependencies: { "tiny-warning": "^1.0.0" } }],
        "tiny-warning": [{ version: "1.0.3", files: { "index.js": "module.exports = () => {};" } }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { watcher: "^1.0.0" } }, { registry, vfs, root });

    expect(report.packages.map((entry) => entry.name).sort()).toEqual(["tiny-warning", "watcher"]);
    expect(report.lockfile.packages["node_modules/tiny-warning"]?.optional).toBe(true);
  });

  it("treats a negation-only os list as portable", async () => {
    const registry = await createFakeRegistry({
      packages: {
        portable: [{ version: "1.0.0", os: ["!win32"], files: { "index.js": "module.exports = 1;" } }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { portable: "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages.map((entry) => entry.name)).toEqual(["portable"]);
  });

  it("refuses a required dependency that cannot run in a browser, naming the platform", async () => {
    const registry = await createFakeRegistry({
      packages: { native: [{ version: "1.0.0", os: ["linux"], cpu: ["x64"] }] },
    });
    const { vfs, root } = bootVfs();

    await expect(installDependencies({ dependencies: { native: "^1.0.0" } }, { registry, vfs, root })).rejects.toThrow(
      /PLATFORM_UNSUPPORTED.*linux, x64.*cannot run in a browser/,
    );
  });

  it("skips a platform-specific entry that came from a locally generated lockfile", async () => {
    // Exactly what `npm install` writes on a Mac: every platform variant of esbuild, each marked optional with its
    // os and cpu. Without filtering these, the browser would fetch linux and darwin binaries it cannot execute.
    const fromLocalInstall: Lockfile = {
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "demo", version: "1.0.0", dependencies: { esbuild: "^0.21.0" } },
        "node_modules/esbuild": {
          version: "0.21.5",
          resolved: "https://registry.test/esbuild/-/esbuild-0.21.5.tgz",
          dependencies: { "@esbuild/darwin-x64": "0.21.5" },
        },
        "node_modules/@esbuild/darwin-x64": {
          version: "0.21.5",
          resolved: "https://registry.test/@esbuild/darwin-x64/-/darwin-x64-0.21.5.tgz",
          os: ["darwin"],
          cpu: ["x64"],
          optional: true,
        },
      },
    };
    const registry = await createFakeRegistry({
      packages: {
        esbuild: [{ version: "0.21.5", dependencies: { "@esbuild/darwin-x64": "0.21.5" } }],
        "@esbuild/darwin-x64": [{ version: "0.21.5", os: ["darwin"], cpu: ["x64"] }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { esbuild: "^0.21.0" } }, {
      registry,
      vfs,
      root,
      lockfile: fromLocalInstall,
    });

    expect(report.packages.map((entry) => entry.name)).toEqual(["esbuild"]);
    expect(report.warnings.join(" ")).toMatch(/@esbuild\/darwin-x64@0\.21\.5 skipped: platform-specific \(darwin, x64\)/);
    expect(exists(vfs, "/app/node_modules/@esbuild/darwin-x64")).toBe(false);
  });

  it("refuses a platform-specific lockfile entry that is not marked optional", async () => {
    // Optionality is read from the entry, so a required native package must still be a hard failure rather than a
    // tree that looks complete but cannot run.
    const required: Lockfile = {
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: { native: "^1.0.0" } },
        "node_modules/native": {
          version: "1.0.0",
          resolved: "https://registry.test/native/-/native-1.0.0.tgz",
          os: ["linux"],
          cpu: ["x64"],
        },
      },
    };
    const registry = await createFakeRegistry({ packages: { native: [{ version: "1.0.0", os: ["linux"], cpu: ["x64"] }] } });
    const { vfs, root } = bootVfs();

    await expect(
      installDependencies({ dependencies: { native: "^1.0.0" } }, { registry, vfs, root, lockfile: required }),
    ).rejects.toThrow(/PLATFORM_UNSUPPORTED.*linux, x64/);
  });

  it("warns instead of failing when an optional dependency is missing from the registry", async () => {
    const registry = await createFakeRegistry({
      packages: {
        watcher: [{ version: "1.0.0", optionalDependencies: { "not-published": "^1.0.0" } }],
      },
    });
    const { vfs, root } = bootVfs();

    const report: InstallReport = await installDependencies({ dependencies: { watcher: "^1.0.0" } }, { registry, vfs, root });

    expect(report.packages.map((entry) => entry.name)).toEqual(["watcher"]);
    expect(report.warnings.join(" ")).toMatch(/not-published skipped \(optional/);
  });
});
