/**
 * A refusal crossing a thread boundary.
 *
 * `postMessage` structured-clones a `Refusal`, which keeps the four fields and drops the prototype and the freeze. So the far side receives
 * data that could have been fabricated by anyone, and `refusalFromWire` is the only thing standing between that data and a by-design
 * classification the gate treats as legitimate. Two properties are load-bearing and both are asserted here:
 *
 * 1. **A malformed value is not a refusal.** Anything that is not a complete record from the closed code set becomes `undefined`, so it
 *    reaches a verdict as the ordinary failure it was, rather than filling the by-design bucket with junk.
 * 2. **The revived value is the same frozen shape the runtime made.** Not a copy that happens to look right: `createRefusal` is the one
 *    constructor, and the guarantee in `refusal.ts`'s header survives the trip.
 */

import { describe, expect, it } from "vitest";
import { createRefusal, refusalFromWire, type Refusal } from "../../src/runtime/refusal.js";

const nativeAddon: Refusal = createRefusal({
  code: "native-addon",
  capability: "native addon",
  message: "Cannot load native addon /addon.node: native addons are not supported in this runtime.",
  subject: "/addon.node",
});

const processExec: Refusal = createRefusal({
  code: "NATIVE_PROCESS_EXEC_REFUSED",
  capability: "native process execution",
  message: "child_process cannot start a native process in this runtime.",
  subject: "child_process.spawn",
});

/** What a sender can actually post: the fields, as a fresh plain object, with no prototype link to the class that made it. */
const wire = (refusal: Refusal): unknown => ({ ...refusal });

describe("refusalFromWire", () => {
  it("revives a refusal of each code with every field intact", () => {
    for (const refusal of [nativeAddon, processExec]) {
      expect(refusalFromWire(wire(refusal))).toEqual(refusal);
    }
  });

  it("re-freezes what it returns, so the runtime's own guarantee holds on both sides of the boundary", () => {
    const revived = refusalFromWire(wire(nativeAddon));

    expect(revived).toBeDefined();
    expect(Object.isFrozen(revived)).toBe(true);
    // A mutable copy that merely looked right would let a later reader rewrite the diagnostic between the report and the record on disk,
    // which is exactly what `createRefusal` exists to prevent.
    expect(() => {
      (revived as { message: string }).message = "rewritten";
    }).toThrow();
    expect((revived as Refusal).message).toBe(nativeAddon.message);
  });

  it("drops a code outside the closed set", () => {
    expect(refusalFromWire({ ...nativeAddon, code: "disk-full" })).toBeUndefined();
  });

  it("drops a record missing a field the classification needs", () => {
    for (const field of ["code", "capability", "message", "subject"] as const) {
      const partial: Record<string, unknown> = { ...nativeAddon };
      delete partial[field];
      expect(refusalFromWire(partial), field).toBeUndefined();
    }
  });

  it("drops an empty diagnostic rather than reporting a refusal with nothing in it", () => {
    expect(refusalFromWire({ ...nativeAddon, message: "" })).toBeUndefined();
    expect(refusalFromWire({ ...nativeAddon, capability: "" })).toBeUndefined();
    // A subject may legitimately be empty: it names what was refused, and not every code has a path to name. An empty MESSAGE cannot be
    // legitimate, because the message is the diagnostic a person reads.
    expect(refusalFromWire({ ...nativeAddon, subject: "" })).toEqual(createRefusal({ ...nativeAddon, subject: "" }));
  });

  it("drops a value that is not a record at all", () => {
    for (const junk of [undefined, null, "native-addon", 42, true, [], [{ ...nativeAddon }]]) {
      expect(refusalFromWire(junk), String(junk)).toBeUndefined();
    }
  });

  it("does not accept an Error that merely mentions a refusal", () => {
    // The shape a boundary reaches for when it decides to infer a refusal from a failure instead of carrying one.
    const error = Object.assign(new Error(nativeAddon.message), { refusal: nativeAddon });

    expect(refusalFromWire(error)).toBeUndefined();
  });
});
