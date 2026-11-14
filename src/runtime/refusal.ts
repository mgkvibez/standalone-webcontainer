/**
 * Refusals the runtime makes on purpose (ADR-0014).
 *
 * A refusal is not a failure and not a bug: it is the runtime declining a capability it does not provide, with evidence
 * a fixture can assert on. The distinction only survives if the evidence is trustworthy, so a `Refusal` is frozen the
 * moment it is created. `readonly` would not be enough: it is erased at runtime, and one cast or one plain-JavaScript
 * consumer can rewrite the diagnostic between the report and the record on disk.
 */

/**
 * The closed set of capabilities refused on purpose. Adding a member is a design act, not a refactor.
 *
 * The set now spans two naming conventions, deliberately: `native-addon` predates the ruling and is byte-pinned by
 * tests/unit/harness.refusal-contract.test.ts, while `NATIVE_PROCESS_EXEC_REFUSED` is the name the owner chose for the second member.
 * Renaming the first to match would be a separate act with its own evidence, not a tidy-up to smuggle in with this one.
 */
export type RefusalCode = "native-addon" | "NATIVE_PROCESS_EXEC_REFUSED";

export interface Refusal {
  readonly code: RefusalCode;
  /** The capability in words a person reads, e.g. "native addon". */
  readonly capability: string;
  /** The diagnostic, verbatim as captured. Never trimmed, normalized or rewritten. */
  readonly message: string;
  /** What was refused, e.g. the path of the addon. */
  readonly subject: string;
}

/**
 * The only constructor. Copies then freezes, so neither the caller's input object nor the returned value can be edited
 * afterwards; a mutation attempt fails silently outside strict mode and throws inside it.
 */
export function createRefusal(input: Refusal): Refusal {
  return Object.freeze({
    code: input.code,
    capability: input.capability,
    message: input.message,
    subject: input.subject,
  });
}

/**
 * Thrown when the runtime refuses to load or run something. Catchable on purpose: a program is entitled to handle a
 * refusal and continue, and when it does, the run is an ordinary run with no refusal recorded.
 */
export class ProcessRefusal extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "ProcessRefusal";
    this.refusal = createRefusal(refusal);
  }
}

/**
 * The codes, as data, so a boundary can check a value it did not create.
 *
 * Derived from the type above at compile time by construction: the array is the type's own union spelled out, and `satisfies` makes a
 * member added to `RefusalCode` without a matching entry here a compile error rather than a refusal silently dropped at a boundary.
 */
const REFUSAL_CODES = ["native-addon", "NATIVE_PROCESS_EXEC_REFUSED"] as const satisfies readonly RefusalCode[];

/**
 * Narrow a value that crossed a thread boundary into a `Refusal`, or `undefined`.
 *
 * A refusal is data here, never an object: `postMessage` structured-clones it, so the prototype and the freeze do not survive the trip and
 * what arrives is an ordinary record a sender could have fabricated. Two things follow, and both are the reason this function exists rather
 * than a cast:
 *
 * 1. **It validates.** The code must be one of the closed set and every field a non-empty string, so junk from a future or a foreign
 *    thread becomes "no refusal" - an ordinary exit - instead of a by-design classification nobody can trace.
 * 2. **It re-freezes through the one constructor.** The value that reaches the container is the same frozen shape the runtime created, so
 *    `Object.isFrozen` is true on both sides of the boundary and the guarantee in the header of this file survives the trip.
 *
 * A refusal is NOT reconstructed from stderr or from an error message: the fields travel with the process's own exit, and a run with no
 * refusal on the wire has none.
 */
export function refusalFromWire(value: unknown): Refusal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { readonly code?: unknown; readonly capability?: unknown; readonly message?: unknown; readonly subject?: unknown };
  if (typeof candidate.code !== "string" || !REFUSAL_CODES.includes(candidate.code as RefusalCode)) return undefined;
  if (typeof candidate.capability !== "string" || candidate.capability === "") return undefined;
  if (typeof candidate.message !== "string" || candidate.message === "") return undefined;
  if (typeof candidate.subject !== "string") return undefined;
  return createRefusal({
    code: candidate.code as RefusalCode,
    capability: candidate.capability,
    message: candidate.message,
    subject: candidate.subject,
  });
}
