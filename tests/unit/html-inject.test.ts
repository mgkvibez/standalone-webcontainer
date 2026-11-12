import { describe, expect, test } from "vitest";
import { createHtmlInjector, isHtmlDocument, INJECTED_CLIENT_MARKER } from "../../src/browser/html-inject.js";

// Written with the marker already on it, because that is what the shell injects: the injector only adds the marker to a tag that lacks one.
const TAG = '<script data-swc-preview-client src="/__swc/ws-client.js"></script>';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (chunks: readonly Uint8Array[]): string =>
  chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

function inject(chunks: readonly string[]): { output: string; injected: boolean } {
  const injector = createHtmlInjector(TAG);
  const out: Uint8Array[] = [];
  for (const chunk of chunks) out.push(...injector.push(encode(chunk)));
  out.push(...injector.end());
  return { output: decode(out), injected: injector.injected };
}

describe("html injection", () => {
  test("the tag lands immediately before the closing head", () => {
    const { output, injected } = inject(["<!doctype html><html><head><title>t</title></head><body>hi</body></html>"]);
    expect(injected).toBe(true);
    expect(output).toBe(`<!doctype html><html><head><title>t</title>${TAG}</head><body>hi</body></html>`);
    expect(output.indexOf(TAG)).toBeLessThan(output.indexOf("</head>"));
  });

  test("a closing head split across chunks still gets the tag", () => {
    const { output } = inject(["<html><head><title>t</title></he", "ad><body>hi</body></html>"]);
    expect(output).toContain(`${TAG}</head>`);
    expect(output).toBe(`<html><head><title>t</title>${TAG}</head><body>hi</body></html>`);
  });

  test("content before the head is emitted while the document is still arriving", () => {
    const injector = createHtmlInjector(TAG);
    const head = `<html><head>${"x".repeat(5_000)}`;
    const first = injector.push(encode(head));
    // Streaming is the point: most of the document came out before the head ended.
    expect(decode(first).length).toBeGreaterThan(4_000);
    expect(injector.injected).toBe(false);
    const second = injector.push(encode("</head><body>hi</body></html>"));
    const tail = [...second, ...injector.end()];
    expect(decode(first) + decode(tail)).toBe(`<html><head>${"x".repeat(5_000)}${TAG}</head><body>hi</body></html>`);
  });

  test("a document with no closing head gets the tag at the end", () => {
    const { output } = inject(["<div>fragment</div>"]);
    expect(output).toBe(`<div>fragment</div>${TAG}`);
  });

  test("chunks after the injection are passed through untouched", () => {
    const injector = createHtmlInjector(TAG);
    injector.push(encode("<html><head></head>"));
    // A binary body must not be buffered behind the injector once there is nothing left to inject.
    const binary = new Uint8Array([0, 1, 2, 255]);
    expect(injector.push(binary)).toEqual([binary]);
    expect(injector.end()).toEqual([]);
  });

  test("the marker makes a second injection detectable rather than silent", () => {
    const { output } = inject(["<html><head></head>"]);
    expect(output).toContain(INJECTED_CLIENT_MARKER);
    // A page that already carries the client is served as it is by the caller, which looks for the marker; the injector itself must never add
    // the tag twice to one document.
    expect(output.split("<script").length - 1).toBe(1);
  });

  test("closing head is matched case-insensitively", () => {
    const { output } = inject(["<HTML><HEAD></HEAD><BODY>x</BODY></HTML>"]);
    expect(output).toContain(`${TAG}</HEAD>`);
  });

  test("an empty document still carries the client", () => {
    const { output } = inject([]);
    expect(output).toBe(TAG);
  });
});

describe("isHtmlDocument", () => {
  test("documents are html, everything else is not", () => {
    expect(isHtmlDocument("text/html")).toBe(true);
    expect(isHtmlDocument("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlDocument("TEXT/HTML")).toBe(true);
    expect(isHtmlDocument("application/xhtml+xml")).toBe(true);
    expect(isHtmlDocument("text/plain")).toBe(false);
    expect(isHtmlDocument("application/javascript")).toBe(false);
    expect(isHtmlDocument(undefined)).toBe(false);
  });
});
