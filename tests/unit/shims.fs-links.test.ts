/**
 * The link model (ADR-0026): a tree with no links, refused by name, plus the timestamp setters the same audit bullet asked for.
 *
 * Why these tests exist at all, for members that mostly throw: `fs.symlinkSync("t", "l")` used to fail as
 * `fs.symlinkSync is not a function`, which reads as a broken runtime and tells a dependency author nothing they can act on. So the
 * assertions here are about the MESSAGE and the CODE first, and about behaviour second: a refusal is a product decision and has to be
 * as legible as a success.
 */

import { describe, expect, it, vi } from "vitest";

import { createFsShim } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";

interface Coded {
  readonly code?: string;
  readonly message: string;
}

function thrown(run: () => unknown): Coded {
  try {
    run();
  } catch (error) {
    return error as Coded;
  }
  throw new Error("expected a throw, got a return value");
}

function shim(): ReturnType<typeof createFsShim> {
  const vfs = new FileSystem();
  vfs.writeFileSync("/app/main.js", "console.log(1);");
  vfs.mkdirSync("/app/lib", {});
  vfs.writeFileSync("/app/lib/real.js", "module.exports = 1;");
  return createFsShim(vfs, { cwd: "/app" });
}

describe("links are refused by name", () => {
  it("refuses symlinkSync with a code, the reason and the alternative", () => {
    const fs = shim();
    const error = thrown(() => fs.symlinkSync("lib/real.js", "lib/link.js"));
    expect(error.code).toBe("ERR_NOT_SUPPORTED");
    // The three facts the silent version omitted, including which ADR decided it.
    expect(error.message).toContain("tree");
    expect(error.message).toContain("copyFileSync");
    expect(error.message).toContain("ADR-0026");
  });

  it("refuses hard links for their own reason, which is a link count", () => {
    const fs = shim();
    const error = thrown(() => fs.linkSync("lib/real.js", "lib/hard.js"));
    expect(error.code).toBe("ERR_NOT_SUPPORTED");
    expect(error.message).toContain("linkSync");
  });

  it("refuses readlinkSync: there is no stored target to read", () => {
    const fs = shim();
    expect(thrown(() => fs.readlinkSync("lib/link.js")).code).toBe("ERR_NOT_SUPPORTED");
  });

  it("reports the callback forms through the callback, as Node does, rather than throwing at the call site", async () => {
    const fs = shim();
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      fs.symlink("lib/real.js", "lib/link.js", (error: unknown) => {
        seen.push(error);
        resolve();
      });
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Coded).code).toBe("ERR_NOT_SUPPORTED");
  });

  it("rejects the promise forms", async () => {
    const fs = shim();
    await expect(fs.promises.symlink("lib/real.js", "lib/link.js")).rejects.toMatchObject({ code: "ERR_NOT_SUPPORTED" });
    await expect(fs.promises.link("lib/real.js", "lib/hard.js")).rejects.toMatchObject({ code: "ERR_NOT_SUPPORTED" });
    await expect(fs.promises.readlink("lib/link.js")).rejects.toMatchObject({ code: "ERR_NOT_SUPPORTED" });
  });

  it("keeps the aliases answering, and agreeing, because no path is a link", () => {
    const fs = shim();
    expect(fs.lstatSync("lib/real.js").isFile()).toBe(true);
    expect(fs.statSync("lib/real.js").size).toBe(fs.lstatSync("lib/real.js").size);
    expect(fs.lstatSync("lib/real.js").isSymbolicLink()).toBe(false);
    // Nothing to resolve, so realpath is normalisation rather than a chain walk.
    expect(fs.realpathSync("lib/../lib/real.js")).toBe("/app/lib/real.js");
  });
});

describe("utimes sets modification time", () => {
  it("takes SECONDS, not milliseconds, and reports them back in milliseconds", () => {
    const fs = shim();
    // 1700000000 seconds is 2023-11-14; read as milliseconds it would be 1970-01-20, which is the mistake this pins.
    fs.utimesSync("lib/real.js", 1700000000, 1700000000);
    const stat = fs.statSync("lib/real.js");
    expect(stat.mtimeMs).toBe(1700000000000);
    expect(new Date(stat.mtimeMs).getUTCFullYear()).toBe(2023);
  });

  it("accepts a Date and a numeric string, as Node does", () => {
    const fs = shim();
    const when = new Date("2024-05-06T07:08:09.000Z");
    fs.utimesSync("lib/real.js", when, when);
    expect(fs.statSync("lib/real.js").mtimeMs).toBe(when.getTime());
    fs.utimesSync("lib/real.js", "1800000000", "1800000000");
    expect(fs.statSync("lib/real.js").mtimeMs).toBe(1800000000000);
  });

  it("leaves birth time alone, because POSIX utimes cannot change it", () => {
    const fs = shim();
    const before = fs.statSync("lib/real.js").birthtimeMs;
    fs.utimesSync("lib/real.js", 1700000000, 1700000000);
    expect(fs.statSync("lib/real.js").birthtimeMs).toBe(before);
  });

  it("works on a derived directory, and the time survives the next stat of it", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/a/b/file.js", "x");
    const derived = createFsShim(vfs, { cwd: "/a" });
    // `/a/b` has no entry of its own: it exists because a file lives below it.
    expect(derived.statSync("b").mtimeMs).toBe(0);
    derived.utimesSync("b", 1700000000, 1700000000);
    expect(derived.statSync("b").mtimeMs).toBe(1700000000000);
  });

  it("refuses the root with a reason, instead of succeeding without storing anything", () => {
    const fs = shim();
    const error = thrown(() => fs.utimesSync("/", 1700000000, 1700000000));
    expect(error.message).toContain("root");
  });

  it("refuses a bad time argument loudly rather than putting a file in 1970", () => {
    const fs = shim();
    expect(thrown(() => fs.utimesSync("lib/real.js", Number.NaN, 1700000000)).code).toBe("ERR_INVALID_ARG_TYPE");
  });

  it("agrees with lutimes, which is the same member with no link to follow", () => {
    const fs = shim();
    fs.lutimesSync("lib/real.js", 1700000000, 1700000000);
    expect(fs.statSync("lib/real.js").mtimeMs).toBe(1700000000000);
  });

  it("emits a change event, so a watcher sees the touch", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/f.js", "x");
    const seen = vi.fn();
    vfs.subscribe(seen);
    const fs = createFsShim(vfs, { cwd: "/" });
    fs.utimesSync("/f.js", 1700000000, 1700000000);
    expect(seen).toHaveBeenCalledWith({ kind: "change", path: "/f.js" });
  });
});
