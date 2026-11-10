/**
 * A deliberate limitation of the harness, stated as policy (ADR-0010 amendment 2).
 *
 * Three outcomes look alike and must never be confused:
 *
 * - a **runtime refusal** (`unsupported`): the engine will not do this on purpose, and a fixture can exist to prove the
 *   refusal cleanly (ADR-0014);
 * - a **harness fault**: our own gap, a command we have not implemented yet. Reported as HARNESS_BUG so it is fixed
 *   rather than scored;
 * - a **restriction**: a boundary we chose, such as disabling registry fetches for a milestone. It is neither a defect to
 *   fix nor a runtime property to measure, so filing it as HARNESS_BUG would put our deliberate scope on someone's bug
 *   list, and filing it as a runtime refusal would credit the engine with a decision it never made.
 *
 * A restriction carries its policy, the operation it blocked, the reason and the supported alternative, so a reader can
 * act on it without reading our source.
 */
export interface Restriction {
  /** Stable policy identifier, e.g. `offline-registry`. Lowercase kebab-case. */
  readonly policy: string;
  /** The operation that was blocked, in the words the fixture used. */
  readonly operation: string;
  /** Why the policy exists. A sentence a fixture author can read. */
  readonly reason: string;
  /** What to do instead, when there is something to do. */
  readonly alternative?: string;
  /**
   * The approved wording, used verbatim when present.
   *
   * Some restrictions have a message fixed by a contract rather than assembled from the fields above (the pnpm profile's D-4
   * table is one). Those messages still carry a policy, an operation, a reason and an alternative; this field exists so the
   * rendered sentence is the approved one instead of a paraphrase that drifts from what fixtures were told to expect.
   */
  readonly message?: string;
}

const POLICY_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Freezes and validates a restriction.
 *
 * Validation is not ceremony: `decideVerdict` trusts a restriction to explain a non-PASS outcome, so an empty field would
 * produce a verdict a human cannot act on. Throwing here puts the failure at the point of construction, with the reason.
 */
export function createRestriction(input: Restriction): Readonly<Restriction> {
  if (!POLICY_PATTERN.test(input.policy)) {
    throw new TypeError(`restriction policy must be lowercase kebab-case, got ${JSON.stringify(input.policy)}`);
  }
  if (input.message !== undefined && input.message.trim() === "") {
    throw new TypeError("restriction message must not be blank when provided");
  }
  for (const field of ["operation", "reason"] as const) {
    if (input[field].trim() === "") throw new TypeError(`restriction ${input.policy}: ${field} must not be empty`);
  }
  if (input.alternative !== undefined && input.alternative.trim() === "") {
    throw new TypeError(`restriction ${input.policy}: alternative must be absent or non-empty`);
  }
  return Object.freeze({ ...input });
}

/** One line, in the order a reader needs it: what policy, what it blocked, why, and what to do instead. */
export function describeRestriction(restriction: Restriction): string {
  if (restriction.message !== undefined) return restriction.message;
  const base = `${restriction.policy} policy blocked ${restriction.operation}: ${restriction.reason}`;
  return restriction.alternative === undefined ? base : `${base} (instead: ${restriction.alternative})`;
}
