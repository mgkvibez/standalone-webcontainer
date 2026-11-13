/**
 * The three policies the milestone made explicit: peers, lifecycle scripts, and integrity.
 *
 * Each one is a place where "it installed" and "it works" came apart. A peer that nobody installed produces a tree that loads and fails on a
 * `require` the user never wrote. A skipped postinstall produces a package whose files exist and whose binary does not. An unverified tarball
 * produces whatever the network handed over. So each test asserts the *reported* outcome, not just a file landing: the report is the thing a
 * person acts on.
 */

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { installDependencies, InstallError } from "../../src/npm/install.js";
import { parseLockfile, serializeLockfile } from "../../src/npm/lockfile.js";
import { createFakeRegistry, type FakeRegistry, type FakeVersion } from "../helpers/registry.js";
import { makeTar } from "../helpers/tarball.js";
import { bootVfs, exists, text } from "../helpers/vfs.js";

const fakeRegistry = async (options: {
  readonly packages: Readonly<Record<string, readonly FakeVersion[]>>;
  readonly withIntegrity?: boolean;
}): Promise<FakeRegistry> => createFakeRegistry(options);

describe("peer dependencies", () => {
  it("installs a required peer and reports which version satisfies it", async () => {
    const registry = await fakeRegistry({
      packages: {
        plugin: [{ version: "1.0.0", peerDependencies: { react: "^18.0.0" } }],
        react: [{ version: "18.3.1" }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { plugin: "^1.0.0" } }, { registry, vfs, root });

    // npm 7 and later install a required peer; ignoring it was the behaviour this milestone replaced.
    expect(report.packages.map((entry) => entry.name).sort()).toEqual(["plugin", "react"]);
    expect(report.peers).toEqual([
      { name: "react", range: "^18.0.0", requiredBy: "plugin@1.0.0", version: "18.3.1" },
    ]);
  });

  it("reuses a copy of the peer the project already asked for, rather than installing a second one", async () => {
    const registry = await fakeRegistry({
      packages: {
        plugin: [{ version: "1.0.0", peerDependencies: { react: "^18.0.0" } }],
        react: [{ version: "18.3.1" }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies(
      { dependencies: { plugin: "^1.0.0", react: "^18.0.0" } },
      { registry, vfs, root },
    );

    expect(report.packages.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual(["plugin@1.0.0", "react@18.3.1"]);
    expect(report.peers[0]?.version).toBe("18.3.1");
  });

  it("refuses the install when a required peer cannot be satisfied, naming the package that asked for it", async () => {
    const registry = await fakeRegistry({
      packages: {
        plugin: [{ version: "1.0.0", peerDependencies: { react: "^19.0.0" } }],
        react: [{ version: "18.3.1" }],
      },
    });
    const { vfs, root } = bootVfs();

    await expect(
      installDependencies({ dependencies: { plugin: "^1.0.0" } }, { registry, vfs, root }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InstallError &&
        error.code === "PEER_DEPENDENCY_CONFLICT" &&
        /react@"\^19\.0\.0"/.test(error.message) &&
        /plugin@1\.0\.0/.test(error.message),
    );
  });

  it("warns rather than fails for a peer npm marked optional", async () => {
    const registry = await fakeRegistry({
      packages: {
        plugin: [
          {
            version: "1.0.0",
            peerDependencies: { "react-dom": "^18.0.0" },
            peerDependenciesMeta: { "react-dom": { optional: true } },
          },
        ],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies({ dependencies: { plugin: "^1.0.0" } }, { registry, vfs, root });

    expect(report.packages.map((entry) => entry.name)).toEqual(["plugin"]);
    expect(report.warnings.join(" ")).toMatch(/optional peer react-dom@"\^18\.0\.0" is not installed/);
  });

  it("gives two dependents their own peer version when the two ranges cannot share one", async () => {
    const registry = await fakeRegistry({
      packages: {
        old: [{ version: "1.0.0", peerDependencies: { react: "^17.0.0" } }],
        modern: [{ version: "1.0.0", peerDependencies: { react: "^18.0.0" } }],
        react: [{ version: "17.0.2" }, { version: "18.3.1" }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies(
      { dependencies: { old: "^1.0.0", modern: "^1.0.0" } },
      { registry, vfs, root },
    );

    const versions = report.peers.map((peer) => `${peer.requiredBy}:${peer.version}`).sort();
    expect(versions).toEqual(["modern@1.0.0:18.3.1", "old@1.0.0:17.0.2"]);
    // Which dependent gets the root copy follows the order the peers were first asked for: `old` is listed first, so react 17 lands at the root
    // and react 18 nests under `modern`, where Node's walk-up finds it. The assertion is on the paths, because "both versions installed" is only
    // correct if each is visible from the dependent that needs it.
    expect(text(vfs, `${root}/node_modules/react/package.json`)).toMatch(/"version": "17\.0\.2"/);
    expect(text(vfs, `${root}/node_modules/modern/node_modules/react/package.json`)).toMatch(/"version": "18\.3\.1"/);
  });

  it("keeps the peer contract in the lockfile, and re-checks it on an install that fetches no packuments", async () => {
    const registry = await fakeRegistry({
      packages: {
        plugin: [{ version: "1.0.0", peerDependencies: { react: "^18.0.0" } }],
        react: [{ version: "18.3.1" }],
      },
    });
    const { vfs, root } = bootVfs();

    const first = await installDependencies({ dependencies: { plugin: "^1.0.0" } }, { registry, vfs, root });
    const lockfile = parseLockfile(text(vfs, `${root}/package-lock.json`));
    expect(lockfile.packages["node_modules/plugin"]?.peerDependencies).toEqual({ react: "^18.0.0" });

    const pinned = await fakeRegistry({
      packages: {
        plugin: [{ version: "1.0.0", peerDependencies: { react: "^18.0.0" } }],
        react: [{ version: "18.3.1" }],
      },
    });
    const second = await installDependencies({ dependencies: { plugin: "^1.0.0" } }, { registry: pinned, vfs, root, lockfile: first.lockfile });
    expect(pinned.fetched).toEqual([]);
    expect(second.peers).toEqual([{ name: "react", range: "^18.0.0", requiredBy: "plugin@1.0.0", version: "18.3.1" }]);
  });
});

describe("lifecycle scripts", () => {
  it("never runs one, and names every package whose script was skipped", async () => {
    const registry = await fakeRegistry({
      packages: {
        native: [{ version: "1.0.0", hasInstallScript: true }],
        plain: [{ version: "1.0.0" }],
      },
    });
    const { vfs, root } = bootVfs();

    const report = await installDependencies(
      { dependencies: { native: "^1.0.0", plain: "^1.0.0" } },
      { registry, vfs, root },
    );

    expect(report.lifecycle).toEqual([{ name: "native", version: "1.0.0" }]);
    // Reported twice on purpose: as data for a caller, and as a warning so the terminal line exists for a user who only reads output.
    expect(report.warnings.join(" ")).toMatch(/1 package\(s\) declare install scripts.*native@1\.0\.0/);
  });

  it("carries the flag through the lockfile, so a reinstall reports the same skipped scripts", async () => {
    const registry = await fakeRegistry({ packages: { native: [{ version: "1.0.0", hasInstallScript: true }] } });
    const { vfs, root } = bootVfs();
    const first = await installDependencies({ dependencies: { native: "^1.0.0" } }, { registry, vfs, root });
    expect(parseLockfile(text(vfs, `${root}/package-lock.json`)).packages["node_modules/native"]?.hasInstallScript).toBe(true);

    const offline = await fakeRegistry({ packages: { native: [{ version: "1.0.0", hasInstallScript: true }] } });
    const second = await installDependencies(
      { dependencies: { native: "^1.0.0" } },
      { registry: offline, vfs, root, lockfile: first.lockfile },
    );
    expect(second.lifecycle).toEqual([{ name: "native", version: "1.0.0" }]);
  });
});

describe("integrity policy", () => {
  const tarball = (): Uint8Array =>
    new Uint8Array(gzipSync(makeTar([
      { path: "package/", type: "directory" },
      { path: "package/package.json", data: JSON.stringify({ name: "a", version: "1.0.0" }) },
      { path: "package/index.js", data: "module.exports = 1;" },
    ])));

  it("verifies sha512, and refuses a tarball whose bytes do not match", async () => {
    const registry = await fakeRegistry({ packages: { a: [{ version: "1.0.0", integrity: "sha512-not-the-real-digest" }] } });
    const { vfs, root } = bootVfs();
    await expect(installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root })).rejects.toSatisfy(
      (error: unknown) => error instanceof InstallError && error.code === "INTEGRITY_MISMATCH",
    );
  });

  it("verifies sha256 when that is what the publisher listed", async () => {
    const bytes = tarball();
    const owned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(owned).set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", owned);
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    const integrity = `sha256-${btoa(binary)}`;

    const registry = await fakeRegistry({ packages: { a: [{ version: "1.0.0", rawTarball: bytes, integrity }] } });
    const { vfs, root } = bootVfs();
    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.packages.map((entry) => entry.name)).toEqual(["a"]);
    expect(report.warnings.join(" ")).not.toMatch(/integrity/i);
  });

  it("refuses bytes whose only advertised algorithm it cannot compute, instead of installing them unverified", async () => {
    const registry = await fakeRegistry({ packages: { a: [{ version: "1.0.0", integrity: "sha3-512-abcdef" }] } });
    const { vfs, root } = bootVfs();
    await expect(installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root })).rejects.toSatisfy(
      (error: unknown) => error instanceof InstallError && error.code === "UNSUPPORTED_INTEGRITY",
    );
  });

  it("falls back to dist.shasum when a package publishes no integrity, and says so", async () => {
    const bytes = tarball();
    const owned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(owned).set(bytes);
    const digest = await crypto.subtle.digest("SHA-1", owned);
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    // 40 hex characters, which is the form npm publishes in `dist.shasum`.
    const shasum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(shasum).toHaveLength(40);
    expect(btoa(binary)).not.toBe("");

    // `withIntegrity: false` is the package that predates SRI: no dist.integrity at all, and a sha1 shasum as the only published digest.
    const registry = await fakeRegistry({
      packages: { a: [{ version: "1.0.0", rawTarball: bytes, shasum }] },
      withIntegrity: false,
    });
    const { vfs, root } = bootVfs();
    const report = await installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root });
    expect(report.warnings.join(" ")).toMatch(/verified against dist\.shasum \(sha1\) only/);
  });

  it("refuses a shasum that does not match, rather than trusting the weaker algorithm less strictly", async () => {
    const registry = await fakeRegistry({
      packages: { a: [{ version: "1.0.0", shasum: "0".repeat(40) }] },
      withIntegrity: false,
    });
    const { vfs, root } = bootVfs();
    await expect(installDependencies({ dependencies: { a: "^1.0.0" } }, { registry, vfs, root })).rejects.toSatisfy(
      (error: unknown) => error instanceof InstallError && error.code === "INTEGRITY_MISMATCH",
    );
  });

  it("install nothing at all when verification fails, so a refusal cannot leave a half-tree", async () => {
    const registry = await fakeRegistry({
      packages: {
        good: [{ version: "1.0.0" }],
        bad: [{ version: "1.0.0", integrity: "sha512-wrong" }],
      },
    });
    const { vfs, root } = bootVfs();
    await expect(
      installDependencies({ dependencies: { good: "^1.0.0", bad: "^1.0.0" } }, { registry, vfs, root }),
    ).rejects.toThrow(/INTEGRITY_MISMATCH/);
    // The installer stages nothing on a refusal, and no lockfile is written: the project is exactly as it was.
    expect(exists(vfs, `${root}/package-lock.json`)).toBe(false);
    expect(exists(vfs, `${root}/node_modules/bad/index.js`)).toBe(false);
  });
});

describe("the lockfile round trip", () => {
  it("serialises peer fields in a fixed order, so two identical trees serialise identically", () => {
    const lockfile = parseLockfile(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { a: "^1.0.0" } },
          "node_modules/a": {
            version: "1.0.0",
            resolved: "https://registry.test/a/-/a-1.0.0.tgz",
            integrity: "sha512-x",
            peerDependencies: { z: "^1.0.0", b: "^1.0.0" },
            peerDependenciesMeta: { z: { optional: true } },
            hasInstallScript: true,
          },
        },
      }),
    );
    const serialised = serializeLockfile(lockfile);
    expect(serialised).toBe(serializeLockfile(parseLockfile(serialised)));
    expect(serialised).toMatch(/"peerDependencies": \{\n\s+"b": "\^1\.0\.0",\n\s+"z": "\^1\.0\.0"\n\s+\}/);
    expect(serialised).toMatch(/"hasInstallScript": true/);
  });
});

describe("npm alias specs", () => {
  /**
   * A real Vite tree contains `"wrap-ansi": "npm:wrap-ansi@^7.0.0"` inside wrap-ansi-cjs. Before this, the resolver refused the whole install for
   * a spec the registry publishes, which is how the first acceptance run of the milestone failed.
   */
  it("installs the alias target under the alias name, nested where the dependent can see it", async () => {
    const registry = await fakeRegistry({
      packages: {
        cjs: [{ version: "1.0.0", dependencies: { "wrap-ansi": "npm:wrap-ansi@^7.0.0" } }],
        "wrap-ansi": [{ version: "7.2.0", files: { "index.js": "module.exports = 'seven';" } }, { version: "10.0.0" }],
      },
    });
    const { vfs, root } = bootVfs();

    await installDependencies(
      { dependencies: { cjs: "^1.0.0", "wrap-ansi": "^10.0.0" } },
      { registry, vfs, root },
    );

    // The project's own request keeps the root copy at 10, and the dependent's alias gets its own copy at 7.
    expect(text(vfs, `${root}/node_modules/wrap-ansi/package.json`)).toMatch(/"version": "10\.0\.0"/);
    expect(text(vfs, `${root}/node_modules/cjs/node_modules/wrap-ansi/package.json`)).toMatch(/"version": "7\.2\.0"/);
    expect(text(vfs, `${root}/node_modules/cjs/node_modules/wrap-ansi/index.js`)).toBe("module.exports = 'seven';");
    // The directory is the alias name, the bytes are the target's: that is npm's meaning, and it is why `require("wrap-ansi")` inside `cjs` works.
    const lockfile = parseLockfile(text(vfs, `${root}/package-lock.json`));
    expect(lockfile.packages["node_modules/cjs/node_modules/wrap-ansi"]?.resolved).toBe(
      "https://registry.test/wrap-ansi/-/wrap-ansi-7.2.0.tgz",
    );
  });

  it("installs a differently named package under the alias name", async () => {
    const registry = await fakeRegistry({
      packages: {
        other: [{ version: "2.1.0", files: { "index.js": "module.exports = 'other';" } }],
      },
    });
    const { vfs, root } = bootVfs();

    await installDependencies({ dependencies: { "my-lib": "npm:other@^2.0.0" } }, { registry, vfs, root });

    expect(text(vfs, `${root}/node_modules/my-lib/index.js`)).toBe("module.exports = 'other';");
    // The package's own manifest still says what it is, which is what a debugger and a licence scanner need.
    expect(text(vfs, `${root}/node_modules/my-lib/package.json`)).toMatch(/"name": "other"/);
    expect(exists(vfs, `${root}/node_modules/other`)).toBe(false);
  });

  it("reports a missing alias target as the target's absence, not as a bad alias name", async () => {
    const registry = await fakeRegistry({ packages: { present: [{ version: "1.0.0" }] } });
    const { vfs, root } = bootVfs();
    // The registry's own error reaches the user unchanged, and it names the TARGET: `absent` is what could not be found, so telling the user their
    // alias name `my-lib` is invalid would send them looking in the wrong place. Against the real registry this surfaces as PACKAGE_NOT_FOUND,
    // which is pinned in tests/unit/registry.network.test.ts.
    await expect(
      installDependencies({ dependencies: { "my-lib": "npm:absent@^2.0.0" } }, { registry, vfs, root }),
    ).rejects.toThrow(/absent/);
    expect(exists(vfs, `${root}/node_modules/my-lib`)).toBe(false);
  });

  it("resolves an alias from a lockfile without re-fetching, and keeps the nested path", async () => {
    const registry = await fakeRegistry({
      packages: {
        cjs: [{ version: "1.0.0", dependencies: { "wrap-ansi": "npm:wrap-ansi@^7.0.0" } }],
        "wrap-ansi": [{ version: "7.2.0" }, { version: "10.0.0" }],
      },
    });
    const { vfs, root } = bootVfs();
    const first = await installDependencies(
      { dependencies: { cjs: "^1.0.0", "wrap-ansi": "^10.0.0" } },
      { registry, vfs, root },
    );

    const offline = await fakeRegistry({
      packages: {
        cjs: [{ version: "1.0.0", dependencies: { "wrap-ansi": "npm:wrap-ansi@^7.0.0" } }],
        "wrap-ansi": [{ version: "7.2.0" }, { version: "10.0.0" }],
      },
    });
    const second = await installDependencies(
      { dependencies: { cjs: "^1.0.0", "wrap-ansi": "^10.0.0" } },
      { registry: offline, vfs, root, lockfile: first.lockfile },
    );
    expect(offline.fetched).toEqual([]);
    expect(second.usedLockfile).toBe(true);
    expect(text(vfs, `${root}/node_modules/cjs/node_modules/wrap-ansi/package.json`)).toMatch(/"version": "7\.2\.0"/);
  });
});
