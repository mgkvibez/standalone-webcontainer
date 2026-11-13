import { describe, expect, test } from "vitest";
import { isSocketReply, resolveSocketTarget, toRuntimeSocketMessage } from "../../src/browser/socket-relay.js";

const options = { origin: "https://app.example", port: 5173 };

describe("resolving a previewed page's socket URL", () => {
  test("a URL carrying the preview prefix names its own port and loses the prefix", () => {
    expect(resolveSocketTarget("ws://app.example/preview/5173/src/main.ts?token=1", options)).toEqual({
      port: 5173,
      path: "/src/main.ts?token=1",
    });
  });

  test("Vite's shape is a host and the server's port, which is why the prefix cannot be the only source", () => {
    expect(resolveSocketTarget("ws://app.example:5173/", options)).toEqual({ port: 5173, path: "/" });
  });

  test("the page's own port is read as the gateway, because that is never a port inside the container", () => {
    // What Vite's HMR client actually asks for: it builds the socket URL from the page location, so the port it names is the gateway's.
    const behindGateway = { origin: "https://app.example:5199", port: 3000 };
    expect(resolveSocketTarget("wss://app.example:5199/?token=abc", behindGateway)).toEqual({ port: 3000, path: "/?token=abc" });
    // A DIFFERENT explicit port still names a container port: that is how a page reaches a second server it started.
    expect(resolveSocketTarget("wss://app.example:5173/hmr", behindGateway)).toEqual({ port: 5173, path: "/hmr" });
  });

  test("a bare path falls back to the preview's own port", () => {
    expect(resolveSocketTarget("ws://app.example/hmr", options)).toEqual({ port: 5173, path: "/hmr" });
  });

  test("wss is accepted: the bytes are already inside an encrypted origin", () => {
    expect(resolveSocketTarget("wss://app.example/preview/3000/socket", options)).toEqual({ port: 3000, path: "/socket" });
  });

  test("a bare path resolves against the origin, which makes it http and therefore refused", () => {
    // `new URL("/hmr", "https://app.example")` is an https URL, not a websocket one. The page client always sends an absolute ws/wss URL, so this
    // is the shape of a bug rather than a message, and it is refused with that as the reason.
    const result = resolveSocketTarget("/hmr?x=2", options);
    expect("refusal" in result && result.refusal).toContain("opens websockets, not https URLs");
  });

  test("another host is refused by name rather than attempted", () => {
    const result = resolveSocketTarget("ws://elsewhere.example/preview/5173/", options);
    expect(result).toEqual({ refusal: "A preview can only open a socket back to itself, not to elsewhere.example." });
  });

  test("http is refused as the wrong protocol", () => {
    const result = resolveSocketTarget("http://app.example/preview/5173/", options);
    expect("refusal" in result && result.refusal).toContain("opens websockets, not http URLs");
  });

  test("a URL that is not a URL at all is refused, not thrown", () => {
    const result = resolveSocketTarget("::::", options);
    expect("refusal" in result).toBe(true);
  });
});

describe("translating page messages into runtime messages", () => {
  test("an open becomes a port, a path and its protocols", () => {
    expect(
      toRuntimeSocketMessage({ type: "socket-open", id: 1, url: "ws://app.example/preview/5173/hmr", protocols: ["vite-hmr"] }, options),
    ).toEqual({ type: "socket-open", id: 1, port: 5173, path: "/hmr", protocols: ["vite-hmr"] });
  });

  test("a URL that cannot be opened comes back as a refusal, not a message", () => {
    const result = toRuntimeSocketMessage({ type: "socket-open", id: 1, url: "ws://other.example/x", protocols: [] }, options);
    expect("refusal" in result).toBe(true);
  });

  test("send carries exactly one of text and bytes", () => {
    expect(toRuntimeSocketMessage({ type: "socket-send", id: 2, text: "hello" }, options)).toEqual({
      type: "socket-send",
      id: 2,
      text: "hello",
    });
    const body = new Uint8Array([1, 2, 3]);
    expect(toRuntimeSocketMessage({ type: "socket-send", id: 2, body }, options)).toEqual({ type: "socket-send", id: 2, body });
    expect("refusal" in toRuntimeSocketMessage({ type: "socket-send", id: 2, text: "a", body }, options)).toBe(true);
    expect("refusal" in toRuntimeSocketMessage({ type: "socket-send", id: 2 }, options)).toBe(true);
  });

  test("close carries a legal code and a bounded reason", () => {
    expect(toRuntimeSocketMessage({ type: "socket-close", id: 3, code: 1000, reason: "done" }, options)).toEqual({
      type: "socket-close",
      id: 3,
      code: 1000,
      reason: "done",
    });
    expect(toRuntimeSocketMessage({ type: "socket-close", id: 3 }, options)).toEqual({ type: "socket-close", id: 3 });
    expect("refusal" in toRuntimeSocketMessage({ type: "socket-close", id: 3, code: 999 }, options)).toBe(true);
    expect("refusal" in toRuntimeSocketMessage({ type: "socket-close", id: 3, code: 1000, reason: "x".repeat(124) }, options)).toBe(true);
  });

  test("a message without an id, and a message that is not an object, are both refused", () => {
    expect("refusal" in toRuntimeSocketMessage({ type: "socket-send", text: "x" }, options)).toBe(true);
    expect("refusal" in toRuntimeSocketMessage("socket-send", options)).toBe(true);
    expect("refusal" in toRuntimeSocketMessage({ type: "nonsense", id: 1 }, options)).toBe(true);
  });
});

describe("telling socket replies from response replies", () => {
  test("the four socket types are recognised and nothing else is", () => {
    for (const type of ["socket-opened", "socket-data", "socket-closed", "socket-failed"]) {
      expect(isSocketReply({ type, id: 1 })).toBe(true);
    }
    expect(isSocketReply({ type: "chunk", id: "preview-1" })).toBe(false);
    expect(isSocketReply(null)).toBe(false);
    expect(isSocketReply("socket-data")).toBe(false);
  });
});
