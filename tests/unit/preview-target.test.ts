import { describe, expect, it } from "vitest";

import { NotPreviewable, previewRequestUrl } from "../../src/harness/preview-target.js";

describe("previewRequestUrl", () => {
  it("maps a fixture's localhost URL onto the gateway's mount path", () => {
    expect(previewRequestUrl("http://localhost:3000/")).toBe("/preview/3000/");
    expect(previewRequestUrl("http://127.0.0.1:5173/src/main.js?x=1")).toBe("/preview/5173/src/main.js?x=1");
    expect(previewRequestUrl("http://localhost:3000")).toBe("/preview/3000/");
  });

  it("refuses a remote host rather than routing it to a local port", () => {
    expect(() => previewRequestUrl("http://example.com/")).toThrow(NotPreviewable);
    expect(() => previewRequestUrl("http://example.com/")).toThrow(/not example.com/);
  });

  it("refuses a URL with no port, because there is nothing to route to", () => {
    expect(() => previewRequestUrl("http://localhost/")).toThrow(/explicit port/);
    expect(() => previewRequestUrl("not a url")).toThrow(NotPreviewable);
  });
});
