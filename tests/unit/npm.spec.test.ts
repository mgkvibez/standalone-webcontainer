import { describe, expect, it } from "vitest";

import { SpecError, parseInstallSpec, splitSpec } from "../../src/npm/spec.js";

describe("parseInstallSpec", () => {
  it("reads a bare name as `latest`, the way npm does", () => {
    expect(parseInstallSpec("express")).toEqual({ name: "express", range: "latest" });
    expect(parseInstallSpec("  express  ")).toEqual({ name: "express", range: "latest" });
  });

  it("splits a name from a range, a version or a dist-tag", () => {
    expect(parseInstallSpec("express@4.21.2")).toEqual({ name: "express", range: "4.21.2" });
    expect(parseInstallSpec("express@^4")).toEqual({ name: "express", range: "^4" });
    expect(parseInstallSpec("express@next")).toEqual({ name: "express", range: "next" });
    // A trailing separator with nothing after it is `latest`, not an empty range.
    expect(parseInstallSpec("express@")).toEqual({ name: "express", range: "latest" });
  });

  it("keeps a scope's @ out of the range", () => {
    expect(parseInstallSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", range: "latest" });
    expect(parseInstallSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", range: "1.2.3" });
    expect(splitSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", range: "latest" });
  });

  it("reads an alias spec, keeping the alias name and the target range", () => {
    // A real tree needs this: `wrap-ansi-cjs` declares `"wrap-ansi": "npm:wrap-ansi@^7"`, and a Vite install resolves it.
    expect(parseInstallSpec("pkg@npm:other@1")).toEqual({ name: "pkg", range: "npm:other@1" });
    expect(parseInstallSpec("pkg@npm:@scope/other@^2.0.0")).toEqual({ name: "pkg", range: "npm:@scope/other@^2.0.0" });
    // npm's shorthand with no alias name installs under the target's own name.
    expect(parseInstallSpec("npm:react@18")).toEqual({ name: "react", range: "npm:react@18" });
  });

  it("refuses a URL and a folder by naming the kind, not as a typo", () => {
    for (const spec of ["https://example.com/x.tgz", "git+ssh://git@host/x.git", "git@github.com:a/b.git"]) {
      expect(() => parseInstallSpec(spec)).toThrow(SpecError);
      expect(() => parseInstallSpec(spec)).toThrow(/URL or a git remote/);
    }
    for (const spec of ["file:./x.tgz", "./pkg", "../pkg", "/pkg"]) {
      expect(() => parseInstallSpec(spec)).toThrow(/folder or a local tarball/);
    }
    expect(() => parseInstallSpec("workspace:pkg")).toThrow(/workspaces are not supported/);
  });

  it("refuses something that is not a package name at all", () => {
    expect(() => parseInstallSpec("")).toThrow(/a package name is required/);
    expect(() => parseInstallSpec("Not A Name")).toThrow(/not a package name/);
    expect(() => parseInstallSpec("bad//name")).toThrow(/not a package name/);
  });
});
