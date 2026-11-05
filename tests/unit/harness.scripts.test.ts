/**
 * Script lookup and bin resolution, tested against the filesystem shape npm produces rather than a mock of it.
 *
 * The cases that matter are the ones a real project hits: a bin named differently from its package (`tsc` from
 * `typescript`), a scoped package, a manifest npm would have written but that is unreadable now, and two packages
 * fighting over one name. Each has a different correct answer, and only one of them is "pick something".
 */

import { describe, expect, it } from "vitest";

import { listInstalledPackages, ProjectError, readPackageScripts, resolveBin, type ProjectView } from "../../src/harness/scripts.js";

/** A view over a literal file map, so each test states the tree it is talking about. */
function view(files: Record<string, string>, dirs: Record<string, readonly string[]> = {}): ProjectView {
  return {
    readFileText: (path) => files[path] ?? null,
    readDirNames: (path) => dirs[path] ?? [],
  };
}

describe("readPackageScripts", () => {
  it("reads the scripts map", () => {
    const scripts = readPackageScripts(view({ "/app/package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }) }), "/app");
    expect(scripts).toEqual({ dev: "vite", build: "vite build" });
  });

  it("treats a project with no scripts as having none, rather than as an error", () => {
    expect(readPackageScripts(view({ "/app/package.json": JSON.stringify({ name: "app" }) }), "/app")).toEqual({});
  });

  it("reports a missing or malformed manifest as a project error, distinct from a missing script", () => {
    expect(() => readPackageScripts(view({}), "/app")).toThrow(ProjectError);
    expect(() => readPackageScripts(view({ "/app/package.json": "{" }), "/app")).toThrow(/not valid JSON/);
    expect(() => readPackageScripts(view({ "/app/package.json": "[]" }), "/app")).toThrow(/JSON object/);
  });

  it("refuses a non-string script instead of skipping it", () => {
    // "build": 5 means the file is wrong. Skipping it would turn a broken project into a runtime failure later.
    expect(() =>
      readPackageScripts(view({ "/app/package.json": JSON.stringify({ scripts: { build: 5 } }) }), "/app"),
    ).toThrow(/scripts\.build must be a string/);
  });
});

describe("listInstalledPackages", () => {
  it("includes scoped packages and skips dot directories", () => {
    const tree = view(
      {},
      {
        "/app/node_modules": ["vite", "@types", ".bin", ".package-lock.json"],
        "/app/node_modules/@types": ["node", ".cache"],
      },
    );
    expect(listInstalledPackages(tree, "/app")).toEqual(["@types/node", "vite"]);
  });
});

describe("resolveBin", () => {
  const tree = () =>
    view(
      {
        "/app/node_modules/vite/package.json": JSON.stringify({ name: "vite", bin: { vite: "bin/vite.js" } }),
        "/app/node_modules/typescript/package.json": JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }),
        "/app/node_modules/@acme/cli/package.json": JSON.stringify({ name: "@acme/cli", bin: "./index.js" }),
        "/app/node_modules/broken/package.json": "not json at all",
        "/app/node_modules/nobin/package.json": JSON.stringify({ name: "nobin" }),
      },
      {
        "/app/node_modules": ["vite", "typescript", "@acme", "broken", "nobin"],
        "/app/node_modules/@acme": ["cli"],
      },
    );

  it("resolves a bin whose name matches its package", () => {
    expect(resolveBin(tree(), "/app", "vite")).toEqual({
      packageName: "vite",
      entryPath: "/app/node_modules/vite/bin/vite.js",
      name: "vite",
    });
  });

  it("resolves a bin named differently from its package, which is why scanning is required", () => {
    // `tsc` lives inside `typescript`. A lookup that assumed bin name == package name would miss it entirely.
    expect(resolveBin(tree(), "/app", "tsc")).toEqual({
      packageName: "typescript",
      entryPath: "/app/node_modules/typescript/bin/tsc",
      name: "tsc",
    });
  });

  it("resolves a scoped package whose bin is a bare string, named after the package", () => {
    expect(resolveBin(tree(), "/app", "cli")).toEqual({
      packageName: "@acme/cli",
      entryPath: "/app/node_modules/@acme/cli/index.js",
      name: "cli",
    });
  });

  it("returns null for a command nothing provides", () => {
    expect(resolveBin(tree(), "/app", "webpack")).toBeNull();
  });

  it("does not let one unreadable manifest hide every working command", () => {
    // A broken transitive dependency is normal; failing resolution outright would make the project unrunnable.
    expect(resolveBin(tree(), "/app", "vite")?.packageName).toBe("vite");
  });

  it("is deterministic when two packages claim the same name", () => {
    const contested = view(
      {
        "/app/node_modules/zeta/package.json": JSON.stringify({ name: "zeta", bin: { tool: "z.js" } }),
        "/app/node_modules/alpha/package.json": JSON.stringify({ name: "alpha", bin: { tool: "a.js" } }),
      },
      { "/app/node_modules": ["zeta", "alpha"] },
    );
    // Sorted by package name, so two runs of the same tree agree. npm's answer depends on install order.
    expect(resolveBin(contested, "/app", "tool")?.packageName).toBe("alpha");
  });
});
