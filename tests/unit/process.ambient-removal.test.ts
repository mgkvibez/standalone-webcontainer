/**
 * P3-1: the removal mechanism, and the audit behind the list.
 *
 * The mechanism is tested against a fake scope because the interesting cases - own/configurable, own/frozen, inherited,
 * absent - cannot all be produced on a real global. What the real Worker actually loses is proved in the browser spec,
 * where the process Worker is the thing under test.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_AUDIT,
  REMOVED_CAPABILITIES,
  removeAmbientCapabilities,
} from "../../src/process/ambient-removal.js";

describe("P3-1 ambient capability removal", () => {
  it("deletes an own configurable property and confirms it is gone", () => {
    const scope: Record<string, unknown> = { XMLHttpRequest: function XHR() {} };
    const report = removeAmbientCapabilities(scope, ["XMLHttpRequest"]);
    expect(report.removed).toEqual(["XMLHttpRequest"]);
    expect(Object.getOwnPropertyDescriptor(scope, "XMLHttpRequest")).toBeUndefined();
    expect("XMLHttpRequest" in scope).toBe(false);
  });

  it("refuses to claim a non-configurable property was removed", () => {
    // The failure mode this guards: `delete` on a frozen property returns false and changes nothing, and a module that
    // reported "removed" anyway would let a test assert an absence that is not there.
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, "Worker", { value: function W() {}, configurable: false, writable: true });
    const report = removeAmbientCapabilities(scope, ["Worker"]);
    expect(report.refused).toEqual(["Worker"]);
    expect(report.removed).toEqual([]);
    expect("Worker" in scope).toBe(true);
  });

  it("reports an inherited property as inherited rather than removed", () => {
    // Deleting an own property cannot touch the prototype, and a capability reachable through the chain is not gone.
    const prototype = { postMessage: () => undefined };
    const scope = Object.create(prototype) as Record<string, unknown>;
    const report = removeAmbientCapabilities(scope, ["postMessage"]);
    expect(report.inherited).toEqual(["postMessage"]);
    expect(report.removed).toEqual([]);
    expect(typeof scope["postMessage"]).toBe("function");
  });

  it("reports a name the realm never had as absent", () => {
    const report = removeAmbientCapabilities({}, ["BroadcastChannel"]);
    expect(report.absent).toEqual(["BroadcastChannel"]);
    expect(report.removed).toEqual([]);
  });

  it("removes only what the audit approved, and every decision carries evidence", () => {
    // The list is a finding, not a wish: each entry names the consumer that decides it.
    expect(REMOVED_CAPABILITIES).toEqual(["XMLHttpRequest", "BroadcastChannel", "Worker", "MessageChannel"]);
    // WebSocket is preserved on measured evidence: the facade re-exposes the native constructor, so deleting the global
    // would be cosmetic.
    expect(REMOVED_CAPABILITIES).not.toContain("WebSocket");
    expect(CAPABILITY_AUDIT.find((e) => e.name === "WebSocket")?.reason).toContain("facade");
    for (const entry of CAPABILITY_AUDIT) expect(entry.reason.length).toBeGreaterThan(20);
    // Prototype-owned members are deliberately NOT in the removal list: deleting them is not the mechanism, and pretending
    // otherwise is exactly the confusion P3-1 was told to avoid.
    expect(REMOVED_CAPABILITIES).not.toContain("postMessage");
    expect(REMOVED_CAPABILITIES).not.toContain("onmessage");
    // P3-0 captured these so a later phase cannot break the runtime by removing them, and P3-1 does not remove them.
    for (const kept of ["WebAssembly", "crypto", "Atomics", "SharedArrayBuffer", "TextEncoder", "URL"]) {
      expect(REMOVED_CAPABILITIES).not.toContain(kept);
    }
  });
});
