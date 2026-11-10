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
