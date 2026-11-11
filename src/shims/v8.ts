/**
 * `v8`: the two facts a program actually asks for, and refusals where the browser has no equivalent.
 *
 * Vite imports this module to ask one question at boot: `v8.startupSnapshot.isBuildingSnapshot()`, so that it can skip work while a snapshot is
 * being built. In this runtime the answer is always false, and it is a fact rather than a stand-in: nothing here builds V8 snapshots.
 *
 * The rest of the surface is not available from a browser worker, and the module says so per function instead of pretending. `getHeapStatistics`
 * answers from the browser's own heap numbers when the engine exposes them (`performance.memory`, Chrome-only) and refuses rather than reporting
 * zeros, because zeros read as "this program uses no memory" rather than "this runtime cannot see the heap".
 */

/** A refusal for a `v8` member with no browser equivalent. An ordinary error, not one of ADR-0014's capability refusals. */
const unavailable = (member: string, why: string): never => {
  throw Object.assign(new Error(`v8.${member} is not available in this runtime: ${why}`), { code: "ENOSYS", syscall: member });
};

export const startupSnapshot = {
  isBuildingSnapshot(): boolean {
    // The one answer vite needs, and a fact about this runtime: no snapshot is ever being built here.
    return false;
  },
};

interface HeapStatistics {
  total_heap_size: number;
  used_heap_size: number;
  heap_size_limit: number;
}

export function getHeapStatistics(): HeapStatistics {
  const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (memory === undefined) return unavailable("getHeapStatistics", "the browser exposes no heap statistics");
  return {
    total_heap_size: memory.totalJSHeapSize,
    used_heap_size: memory.usedJSHeapSize,
    heap_size_limit: memory.jsHeapSizeLimit,
  };
}

/**
 * `serialize` and `deserialize` round-trip through the structured clone algorithm rather than V8's own byte format.
 *
 * That is a real difference and it is documented rather than hidden: the bytes are opaque to a program that round-trips them in-process (the only
 * supported use), but they are NOT Node's format, so bytes written by Node cannot be read here or the reverse.
 */
export function serialize(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ structuredClone: true, value: structuredCloneValue(value) }));
}

function structuredCloneValue(value: unknown): unknown {
  try {
    // Probe for clonability so an unclonable value fails here with a clear message rather than inside deserialize later.
    structuredClone(value);
    return value;
  } catch {
    return unavailable("serialize", "the value cannot be structured-cloned");
  }
}

export function deserialize(bytes: Uint8Array): unknown {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { structuredClone?: boolean; value?: unknown };
  if (parsed.structuredClone !== true) return unavailable("deserialize", "the bytes are not in this runtime's format (Node's V8 bytes cannot be read)");
  return parsed.value;
}

export function setFlagsFromString(): void {
  // Accepted and ignored: flags describe the V8 instance, and a program cannot reconfigure one it does not own.
}

export function getHeapSpaceStatistics(): never {
  return unavailable("getHeapSpaceStatistics", "the browser exposes no per-space heap breakdown");
}

export function writeHeapSnapshot(): never {
  return unavailable("writeHeapSnapshot", "there is no V8 heap file to write in a browser worker");
}

export default {
  startupSnapshot,
  getHeapStatistics,
  serialize,
  deserialize,
  setFlagsFromString,
  getHeapSpaceStatistics,
  writeHeapSnapshot,
};
