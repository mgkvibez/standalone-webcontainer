/**
 * Installing through the runtime facade, which is the shape user code actually sees.
 *
 * The installer's own tests call `installDependencies` with a VFS they made themselves. These call
 * `runtime.install`, where the VFS belongs to the runtime, so they are the tests that catch the mistake the facade
 * exists to prevent: packages installed into one VFS and `require`d against another.
 */

import { describe, expect, it } from "vitest";

import { InstallError } from "../../src/npm/install.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { createFakeRegistry, type FakeRegistry } from "../helpers/registry.js";
import { bootVfs, exists, text } from "../helpers/vfs.js";

const packages: Parameters<typeof createFakeRegistry>[0]["packages"] = {
  greeting: [
    {
      version: "1.0.0",
      files: { "index.js": "module.exports = function (who) { return 'hello ' + who; };" },
    },
    {
      version: "2.0.0",
      files: { "index.js": "module.exports = function (who) { return 'hello again ' + who; };" },
    },
  ],
  shouty: [
    {
      version: "1.0.0",
      dependencies: { greeting: "^1.0.0" },
      files: { "index.js": "module.exports = require('greeting')('shouty').toUpperCase();" },
    },
  ],
};

/** A registry that serves tarballs and refuses to resolve anything, to prove a lockfile was used. */
function tarballsOnly(registry: FakeRegistry): FakeRegistry {
  return {
    ...registry,
    packument: async (name: string): Promise<never> => {
      throw new Error(`packument for ${name} was requested, so the lockfile was not used`);
    },
  };
}

function writeManifest(vfs: FileSystem, manifest: unknown, path = "/app/package.json"): void {
  vfs.writeFileSync(path, JSON.stringify(manifest, null, 2));
}

describe("runtime.install", () => {
  it("installs from package.json on disk, then runs code that requires the result", async () => {
    const { vfs } = bootVfs();
    writeManifest(vfs, { name: "demo", version: "1.0.0", dependencies: { greeting: "^1.0.0", shouty: "^1.0.0" } });
    vfs.writeFileSync("/app/main.js", 'console.log(require("shouty"));');
    const registry = await createFakeRegistry({ packages });

    const runtime = new InProcessRuntime(vfs);
    const report = await runtime.install({ registry });

    expect(report.packages.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual([
      "greeting@1.0.0",
      "shouty@1.0.0",
    ]);
    // The lockfile is written where npm would put it, next to the manifest.
    expect(exists(vfs, "/app/package-lock.json")).toBe(true);

    const result = await runtime.run("/app/main.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HELLO SHOUTY\n");
  });

  it("reads the lockfile it wrote, so a second install resolves nothing", async () => {
    const { vfs } = bootVfs();
    writeManifest(vfs, { dependencies: { greeting: "^1.0.0" } });
    const registry = await createFakeRegistry({ packages });
    const runtime = new InProcessRuntime(vfs);

    await runtime.install({ registry });
    const before = text(vfs, "/app/package-lock.json");

    // Same project, a registry that would fail loudly if consulted for versions.
    const again = await runtime.install({ registry: tarballsOnly(registry) });

    expect(again.packages.map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(text(vfs, "/app/package-lock.json")).toBe(before);
  });

  it("uses a manifest handed to it instead of the file", async () => {
    const { vfs } = bootVfs();
    const registry = await createFakeRegistry({ packages });
    const runtime = new InProcessRuntime(vfs);

    // No package.json on disk at all: the explicit manifest is the project definition.
    const report = await runtime.install({ registry, manifest: { dependencies: { greeting: "^2.0.0" } } });

    expect(report.packages.map((entry) => entry.version)).toEqual(["2.0.0"]);
    expect(exists(vfs, "/app/package.json")).toBe(false);
  });

  it("installs devDependencies by default, and omits them when asked, as npm does", async () => {
    const manifest = {
      name: "demo",
      dependencies: { greeting: "^1.0.0" },
      devDependencies: { shouty: "^1.0.0" },
    };
    const registry = await createFakeRegistry({ packages });

    const withDev = bootVfs();
    writeManifest(withDev.vfs, manifest);
    const both = await new InProcessRuntime(withDev.vfs).install({ registry });
    expect(both.packages.map((entry) => entry.name).sort()).toEqual(["greeting", "shouty"]);

    const production = bootVfs();
    writeManifest(production.vfs, manifest);
    const prod = await new InProcessRuntime(production.vfs).install({ registry, includeDev: false });
    expect(prod.packages.map((entry) => entry.name)).toEqual(["greeting"]);
    expect(exists(production.vfs, "/app/node_modules/shouty")).toBe(false);
  });

  it("installs into a non-default root", async () => {
    const { vfs } = bootVfs();
    vfs.mkdirSync("/workspace/project", { recursive: true });
    writeManifest(vfs, { dependencies: { greeting: "^1.0.0" } }, "/workspace/project/package.json");
    vfs.writeFileSync("/workspace/project/main.js", 'console.log(require("greeting")("root"));');
    const registry = await createFakeRegistry({ packages });
    const runtime = new InProcessRuntime(vfs);

    await runtime.install({ registry, root: "/workspace/project" });

    expect(exists(vfs, "/workspace/project/node_modules/greeting/index.js")).toBe(true);
    expect(exists(vfs, "/app/node_modules")).toBe(false);
    const result = await runtime.run("/workspace/project/main.js");
    expect(result.stdout).toBe("hello root\n");
  });

  it("says which problem it found in package.json", async () => {
    const registry = await createFakeRegistry({ packages });

    const missing = bootVfs();
    const noManifest = await new InProcessRuntime(missing.vfs)
      .install({ registry })
      .then(() => null, (error: unknown) => error);
    expect(noManifest).toBeInstanceOf(InstallError);
    expect((noManifest as InstallError).code).toBe("MISSING_PACKAGE_JSON");
    expect((noManifest as Error).message).toMatch(/\/app\/package\.json/);

    const broken = bootVfs();
    broken.vfs.writeFileSync("/app/package.json", "{ not json");
    const unparseable = await new InProcessRuntime(broken.vfs)
      .install({ registry })
      .then(() => null, (error: unknown) => error);
    expect((unparseable as InstallError).code).toBe("INVALID_PACKAGE_JSON");

    const wrongType = bootVfs();
    writeManifest(wrongType.vfs, { dependencies: { greeting: 1 } });
    const badValue = await new InProcessRuntime(wrongType.vfs)
      .install({ registry })
      .then(() => null, (error: unknown) => error);
    expect((badValue as InstallError).code).toBe("INVALID_PACKAGE_JSON");
    expect((badValue as Error).message).toMatch(/dependencies\.greeting must be a string, got number/);
  });
});
