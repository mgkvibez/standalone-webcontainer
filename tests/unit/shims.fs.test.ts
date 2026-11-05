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
