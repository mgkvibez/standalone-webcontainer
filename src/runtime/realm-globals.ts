/**
 * The realm-level constructors a browser's global object has, by name.
 *
 * Measured need, not guesswork: `esbuild-wasm`'s in-thread service builds the scope the Go runtime runs in by copying `self`'s properties into a
 * fresh object, and the Go side then reaches for `Object` through it. With a `self` that carried only timers, `Object` was undefined and the Go
 * runtime died at its first allocation with `panic: syscall/js: call of Value.Invoke on undefined`. A global object that is missing `Object` is
 * not a smaller global object, it is a broken one.
 *
 * This is a curated list rather than everything on the host's global because the runtime's surface must be a described thing: what is here is
 * what a program may see, and adding a name is a decision with evidence behind it. Node-only globals are deliberately absent, which is the whole
 * point of the list existing.
 */

import { countedWebAssembly } from "./async-work.js";

/** Names taken from the host realm when the host has them. */
const REALM_NAMES: readonly string[] = [
  // The intrinsics a global object is expected to expose. `Object` first, because that is the one whose absence was measured.
  "Object",
  "Function",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Reflect",
  "Proxy",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  // The error constructors, including the two a program can actually catch from us.
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  // Binary data. A wasm host and every binary protocol need these.
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // Web platform primitives the runtime already relies on elsewhere.
  "WebAssembly",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "structuredClone",
  "queueMicrotask",
];

/**
 * The subset of those names the host actually provides.
 *
 * Absence is tolerated rather than fatal (a browser without `SharedArrayBuffer` is a real browser), so a program sees a smaller surface where the
 * host is smaller, and every name here is still one this runtime is willing to lend.
 */

export function createRealmGlobals(): Record<string, unknown> {
  const host = globalThis as unknown as Record<string, unknown>;
  const globals: Record<string, unknown> = {};
  for (const name of REALM_NAMES) {
    const value = host[name];
    if (value !== undefined) globals[name] = value;
  }
  // A wasm instantiation is real work that settles outside the timer queue, so the copy a program gets counts it. See async-work.ts: without the
  // count the scheduler declared a program awaiting one finished after a single turn, and reported exit 0 for a build that produced nothing.
  if (typeof globals["WebAssembly"] === "object" && globals["WebAssembly"] !== null) {
    globals["WebAssembly"] = countedWebAssembly(globals["WebAssembly"] as object);
  }
  return globals;
}
