import { describe, expect, it } from "vitest";

import { normalizeText } from "../../src/harness/normalize.js";

describe("normalizeText", () => {
  it("replaces the temp directory prefix, with or without a trailing slash", () => {
    const input = "/tmp/run-abc/a.txt\n/tmp/run-abc";
    expect(normalizeText(input, { tempDir: "/tmp/run-abc/", sortLines: false })).toBe(
      "<TMP>/a.txt\n<TMP>",
    );
  });

  it("does not treat the temp directory as a regex", () => {
    // Real temp dirs can contain dots and brackets; an unescaped prefix would either throw or match
    // the wrong text.
    const input = "/tmp/run.a+b(c)/file.txt";
    expect(normalizeText(input, { tempDir: "/tmp/run.a+b(c)" })).toBe("<TMP>/file.txt");
  });

  it("turns CRLF into LF so Windows runners compare with Linux", () => {
    expect(normalizeText("a\r\nb", { sortLines: false })).toBe("a\nb");
  });

  it("strips sourcemap cache-busters and sourceMappingURL comments", () => {
    const input = "loaded app.js?v=9f8e7d6c5b4a\n//# sourceMappingURL=app.js.map";
    expect(normalizeText(input, { sortLines: false })).toBe("loaded app.js?v=<HASH>\n");
  });

  it("replaces ISO timestamps that lockfiles emit", () => {
    expect(normalizeText('"time": "2026-11-03T11:29:41.512Z"', { sortLines: false })).toBe(
      '"time": "<TIMESTAMP>"',
    );
  });

  it("sorts lines so insertion order does not matter", () => {
    expect(normalizeText("z\na\nm")).toBe("a\nm\nz");
  });

  it("drops trailing blank lines so output does not depend on final newline", () => {
    expect(normalizeText("a\n\n\n")).toBe("a");
  });

  it("is idempotent", () => {
    const once = normalizeText("/tmp/x/b\n/tmp/x/a", { tempDir: "/tmp/x" });
    expect(normalizeText(once, { tempDir: "/tmp/x" })).toBe(once);
  });
});
