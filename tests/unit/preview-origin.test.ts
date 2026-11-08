import { describe, expect, it } from "vitest";
import { createPreviewUrl, resolvePreviewOrigin } from "../../src/browser/preview-origin.js";

const previewId = "0123456789abcdef0123456789abcdef";

describe("origin-separated preview addressing", () => {
  it("uses a project-specific localhost origin for development", () => {
    expect(resolvePreviewOrigin(previewId, {
      baseDomain: "preview.localhost:5199",
      hostOrigin: "http://127.0.0.1:5199",
    })).toBe(`http://${previewId}.preview.localhost:5199`);
  });

  it("uses HTTPS for configured production preview domains", () => {
    expect(resolvePreviewOrigin(previewId, {
      baseDomain: "preview.example.com",
      hostOrigin: "https://app.example.com",
    })).toBe(`https://${previewId}.preview.example.com`);
  });

  it("builds a port URL while keeping the route on the preview origin", () => {
    expect(createPreviewUrl(previewId, 3210, {
      baseDomain: "preview.localhost",
      hostOrigin: "http://localhost:5199",
    }, "/hello?from=preview")).toBe(`http://${previewId}.preview.localhost/preview/3210/hello?from=preview`);
  });

  it("rejects malformed IDs, untrusted host input, invalid ports and non-local HTTP", () => {
    const options = { baseDomain: "preview.example.com", hostOrigin: "https://app.example.com" };
    expect(() => resolvePreviewOrigin("friendly project name", options)).toThrow(/preview ID/);
    expect(() => resolvePreviewOrigin(previewId, { ...options, baseDomain: "preview.example.com/path" })).toThrow(/hostname/);
    expect(() => resolvePreviewOrigin(previewId, { ...options, protocol: "http:" })).toThrow(/localhost/);
    expect(() => createPreviewUrl(previewId, 70000, { ...options, baseDomain: "preview.localhost" })).toThrow(/port/);
    expect(() => createPreviewUrl(previewId, 3210, { ...options, baseDomain: "preview.localhost" }, "//app.example.com/"))
      .toThrow(/absolute path/);
  });
});
