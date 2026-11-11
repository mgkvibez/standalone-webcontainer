import { describe, expect, it } from "vitest";

import { createFsShim } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";

describe("filesystem quota errors", () => {
  it("maps protected-file capacity failures to Node ENOSPC", () => {
    const vfs = new FileSystem({ maxFileSize: 10, maxTotalBytes: 10 });
    vfs.writeFileSync("/project/source.js", "12345678");
    const fs = createFsShim(vfs);

    let caught: unknown;
    try {
      fs.writeFileSync("/project/next.js", "1234");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "ENOSPC", errno: -28, syscall: "open", path: "/project/next.js" });
    expect(vfs.readFileSync("/project/source.js", "utf8")).toBe("12345678");
  });

  it("maps the per-file cap to Node EFBIG", () => {
    const fs = createFsShim(new FileSystem({ maxFileSize: 5, maxTotalBytes: 10 }));

    let caught: unknown;
    try {
      fs.writeFileSync("/too-large.js", "123456");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "EFBIG", errno: -27, syscall: "open", path: "/too-large.js" });
  });
});

describe("PathLike", () => {
  it("reads a file named by a file URL, which is how vite opens its own manifest", () => {
    // The literal call that stopped vite's boot: `readFileSync(new URL("../../package.json", import.meta.url))`. Node accepts it everywhere it
    // accepts a path, and the failure it produced here (`path.startsWith is not a function`) pointed at the shim's own resolve line rather than at
    // the caller.
    const vfs = new FileSystem();
    vfs.writeFileSync("/node_modules/vite/package.json", '{"version":"5.4.21"}');
    const fs = createFsShim(vfs);

    const read = fs.readFileSync(new URL("file:///node_modules/vite/package.json"), "utf8");

    expect(read).toBe('{"version":"5.4.21"}');
    expect(fs.existsSync(new URL("file:///node_modules/vite/package.json"))).toBe(true);
    expect(fs.statSync(new URL("file:///node_modules/vite/package.json")).isFile()).toBe(true);
  });

  it("reports a missing file by its path, as Node does for a URL argument", () => {
    const fs = createFsShim(new FileSystem());

    let caught: unknown;
    try {
      fs.readFileSync(new URL("file:///absent.json"));
    } catch (error) {
      caught = error;
    }

    // Node validates the PathLike into a path before it stats anything, so the error carries the path rather than the URL. Checked against
    // Node rather than assumed: a stringified `[object URL]` here would be the kind of wrongness that only shows up in a program comparing paths.
    expect(caught).toMatchObject({ code: "ENOENT", syscall: "open", path: "/absent.json" });
  });
});
