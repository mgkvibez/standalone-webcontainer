/**
 * The seam between the package manager and the module loader.
 *
 * The installer and the loader were built separately, so the interesting question is not whether each works
 * but whether the tree the installer writes is the tree the loader knows how to resolve: `node_modules`, a
 * `package.json` with `main`, and a directory index as a fallback.
 *
 * This installs through the real installer, against a fake registry, into the real VFS, and then runs user code
 * that requires the result. Nothing is stubbed except the network.
 */

import { describe, expect, it } from "vitest";

import { installDependencies, type RegistryClient } from "../../src/npm/install.js";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { FileSystem } from "../../src/vfs/index.js";
import { makePackageTarball, packument } from "../helpers/tarball.js";

async function sha512(rows: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(rows.byteLength);
  new Uint8Array(owned).set(rows);
  const digest = await crypto.subtle.digest("SHA-512", owned);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha512-${btoa(binary)}`;
}

interface FakePackage {
  readonly version: string;
  readonly files: Record<string, string>;
  readonly main?: string;
  readonly dependencies?: Record<string, string>;
}

/** A registry serving the given packages, so the loader's resolution rules are what is under test. */
async function registryWith(
  entries: Readonly<Record<string, readonly FakePackage[]>>,
): Promise<RegistryClient> {
  const tarballs = new Map<string, Uint8Array>();
  const packuments = new Map<string, unknown>();

  for (const [name, versions] of Object.entries(entries)) {
    const published = [];
    for (const entry of versions) {
      const bytes = makePackageTarball(entry.files, {
        name,
        version: entry.version,
        ...(entry.main === undefined ? {} : { main: entry.main }),
        dependencies: entry.dependencies ?? {},
      });
      const url = `https://registry.test/${name}/-/${name}-${entry.version}.tgz`;
      tarballs.set(url, bytes);
      published.push({
        name,
        version: entry.version,
        ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
        integrity: await sha512(bytes),
      });
    }
    packuments.set(name, packument(name, published));
  }

  return {
    async packument(name: string) {
      const found = packuments.get(name);
      if (found === undefined) throw new Error(`no such package ${name}`);
      return found as never;
    },
    async tarball(url: string) {
      const found = tarballs.get(url);
      if (found === undefined) throw new Error(`no such tarball ${url}`);
      return found;
    },
  };
}

describe("installing, then requiring", () => {
  it("runs user code against a package the installer placed", async () => {
    const registry = await registryWith({
      greeter: [
        {
          version: "1.2.0",
          main: "lib/greet.js",
          files: { "lib/greet.js": "module.exports = (name) => 'hello ' + name;" },
        },
      ],
    });

    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    await installDependencies({ dependencies: { greeter: "^1.0.0" } }, { registry, vfs, root: "/app" });

    vfs.writeFileSync(
      "/app/main.js",
      ['const greet = require("greeter");', 'console.log(greet("world"));'].join("\n"),
    );

    const result = await new InProcessRuntime(vfs).run("/app/main.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world\n");
  });

  it("resolves a directory index when package.json has no main", async () => {
    const registry = await registryWith({
      plain: [{ version: "1.0.0", files: { "index.js": "module.exports = 'plain-index';" } }],
    });

    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    await installDependencies({ dependencies: { plain: "^1.0.0" } }, { registry, vfs, root: "/app" });
    vfs.writeFileSync("/app/main.js", 'console.log(require("plain"));');

    const result = await new InProcessRuntime(vfs).run("/app/main.js");
    expect(result.stdout).toBe("plain-index\n");
  });

  it("resolves a transitive dependency from inside the package that requires it", async () => {
    const registry = await registryWith({
      outer: [
        {
          version: "1.0.0",
          main: "index.js",
          dependencies: { inner: "^2.0.0" },
          files: { "index.js": 'module.exports = require("inner") + "-via-outer";' },
        },
      ],
      inner: [{ version: "2.1.0", main: "index.js", files: { "index.js": "module.exports = 'inner-2.1.0';" } }],
    });

    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    await installDependencies({ dependencies: { outer: "^1.0.0" } }, { registry, vfs, root: "/app" });
    vfs.writeFileSync("/app/main.js", 'console.log(require("outer"));');

    const result = await new InProcessRuntime(vfs).run("/app/main.js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("inner-2.1.0-via-outer\n");
  });

  it("runs each copy of a nested conflicting dependency, not the wrong one", async () => {
    const registry = await registryWith({
      wantsOne: [
        {
          version: "1.0.0",
          main: "index.js",
          dependencies: { shared: "^1.0.0" },
          files: { "index.js": 'module.exports = "one+" + require("shared");' },
        },
      ],
      wantsTwo: [
        {
          version: "1.0.0",
          main: "index.js",
          dependencies: { shared: "^2.0.0" },
          files: { "index.js": 'module.exports = "two+" + require("shared");' },
        },
      ],
      shared: [
        { version: "1.0.0", main: "index.js", files: { "index.js": "module.exports = 'v1';" } },
        { version: "2.0.0", main: "index.js", files: { "index.js": "module.exports = 'v2';" } },
      ],
    });

    const vfs = new FileSystem();
    vfs.mkdirSync("/app", { recursive: true });
    await installDependencies({ dependencies: { wantsOne: "^1.0.0", wantsTwo: "^1.0.0" } }, { registry, vfs, root: "/app" });
    vfs.writeFileSync("/app/main.js", 'console.log(require("wantsOne")); console.log(require("wantsTwo"));');

    const result = await new InProcessRuntime(vfs).run("/app/main.js");
    expect(result.exitCode).toBe(0);
    // Each dependent must see its own major, which is the whole point of nesting the conflicting copy.
    expect(result.stdout).toBe("one+v1\ntwo+v2\n");
  });
});
