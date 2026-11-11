/**
 * `assert`, enough for the packages that import it to validate their own arguments.
 *
 * `assert` is unusual among the builtins because its failures are part of its API: `AssertionError` carries `actual`, `expected` and
 * `operator`, and test frameworks read those fields rather than the message. So they are populated, not just the text.
 */

export interface AssertionErrorOptions {
  readonly message?: string | undefined;
  readonly actual?: unknown;
  readonly expected?: unknown;
  readonly operator?: string | undefined;
  readonly stackStartFn?: Function | undefined;
}

export class AssertionError extends Error {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;
  readonly code = "ERR_ASSERTION";

  constructor(options: AssertionErrorOptions = {}) {
    const generated = options.message === undefined;
    const message =
      options.message ??
      `${String(options.actual)} ${options.operator ?? "=="} ${String(options.expected)}`;
    super(message);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? "==";
    this.generatedMessage = generated;
    // `captureStackTrace` is V8-only and missing from the DOM lib's ErrorConstructor, so it is looked up structurally: in a browser
    // without it, the stack simply starts at the constructor, which is still a usable stack.
    const capture = (Error as unknown as { captureStackTrace?: (target: object, start?: Function) => void }).captureStackTrace;
    if (options.stackStartFn !== undefined) capture?.(this, options.stackStartFn);
  }
}

const inspectValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const fail = (message?: string | Error, actual?: unknown, expected?: unknown, operator?: string): never => {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator });
};

export function ok(value: unknown, message?: string): asserts value {
  if (!value) fail(message ?? "The expression evaluated to a falsy value", value, true, "==");
}

export function equal(actual: unknown, expected: unknown, message?: string): void {
  // Loose on purpose, as `assert.equal` is: it is `==`, including string-vs-number coercion.
  // eslint-disable-next-line eqeqeq -- the loose comparison is the documented behaviour.
  if (actual != expected) fail(message, actual, expected, "==");
}

export function notEqual(actual: unknown, expected: unknown, message?: string): void {
  // eslint-disable-next-line eqeqeq -- see `equal`.
  if (actual == expected) fail(message, actual, expected, "!=");
}

export function strictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) fail(message ?? `${inspectValue(actual)} !== ${inspectValue(expected)}`, actual, expected, "strictEqual");
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (Object.is(actual, expected)) fail(message, actual, expected, "notStrictEqual");
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

export function deepEqualAssert(actual: unknown, expected: unknown, message?: string, operator = "deepEqual"): void {
  if (!deepEqual(actual, expected)) fail(message ?? "deep comparison failed", actual, expected, operator);
}

export { deepEqualAssert as deepStrictEqual, deepEqualAssert as deepEqual };
export { deepEqualAssert as notDeepEqualUnsupported };

export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  if (deepEqual(actual, expected)) fail(message, actual, expected, "notDeepEqual");
}

export function throws(fn: () => unknown, expected?: unknown, message?: string): Error {
  const expectedName = (expected as { name?: string } | undefined)?.name;
  const expectedConstructor = typeof expected === "function" ? (expected as new () => Error) : undefined;
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && expectedConstructor !== undefined && !(error instanceof expectedConstructor)) {
      const actualName = (error as Error).name;
      fail(message ?? `expected ${String(expectedName)}, got ${actualName}`, error, expected, "throws");
    }
    if (error instanceof Error && expected instanceof RegExp && !expected.test(error.message)) {
      fail(message ?? `expected message to match ${String(expected)}, got ${error.message}`, error.message, expected, "throws");
    }
    return error instanceof Error ? error : new Error(String(error));
  }
  return fail(message ?? "Missing expected exception", undefined, expected, "throws");
}

export function doesNotThrow(fn: () => unknown, message?: string): void {
  try {
    fn();
  } catch (error) {
    fail(message ?? `Got unwanted exception: ${error instanceof Error ? error.message : String(error)}`, error, undefined, "doesNotThrow");
  }
}

export function match(value: string, pattern: RegExp, message?: string): void {
  if (!pattern.test(value)) fail(message ?? `${inspectValue(value)} did not match ${String(pattern)}`, value, pattern, "match");
}

export function ifError(value: unknown): void {
  if (value !== null && value !== undefined && value !== false) {
    throw value instanceof Error ? value : new AssertionError({ message: `ifError got unwanted exception: ${String(value)}`, actual: value, expected: null, operator: "ifError" });
  }
}

/**
 * Whether a rejection matches Node's `expected` argument.
 *
 * Node accepts a few shapes here and they are not interchangeable: a RegExp tests the message, a string compares it exactly, a class checks
 * `instanceof`, a plain object compares named fields, and a function called with the error is treated as a validator. Only the shapes this
 * shim can honour are honoured, and an object with no known field returns false rather than true, because a matcher that silently accepts
 * everything turns `rejects` into a test that cannot fail.
 */
const matchesRejection = (error: unknown, expected: unknown): boolean => {
  // No matcher means "it must reject, with anything": that is the form most callers write, and treating an absent matcher as a matcher that
  // matches nothing turned every `assert.rejects(p)` into a failure.
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "string") return message === expected;
  if (typeof expected === "function") {
    // A class has a prototype with methods on it; a plain validator has an empty prototype. `instanceof` on a non-constructor throws,
    // so the two are separated before the check rather than inside a try/catch that would swallow a real failure.
    const prototype = (expected as { prototype?: object }).prototype;
    if (prototype !== undefined && Object.getOwnPropertyNames(prototype).length > 0) return error instanceof (expected as new () => unknown);
    return (expected as (value: unknown) => boolean)(error) === true;
  }
  if (typeof expected === "object" && expected !== null) {
    const fields = expected as Record<string, unknown>;
    const target = error as Record<string, unknown>;
    const named = Object.keys(fields);
    if (named.length === 0) return false;
    return named.every((key) => (key === "message" ? message === fields[key] : String(target[key]) === String(fields[key])));
  }
  return false;
};

/**
 * `assert.rejects`, which test suites call to prove an async path fails.
 *
 * The two ways to be wrong are both checked: a promise that FULFILS is a failure of the assertion, and a promise that rejects with something
 * other than what was expected is a failure too. A rejected FUNCTION (a sync throw before a promise exists) is not this member's job: Node
 * calls it an invalid return value, and so does this.
 */
export async function rejects(
  promiseOrFunction: Promise<unknown> | (() => Promise<unknown>),
  expected?: unknown,
  message?: string,
): Promise<void> {
  let promise: Promise<unknown>;
  try {
    promise = typeof promiseOrFunction === "function" ? promiseOrFunction() : promiseOrFunction;
  } catch (error) {
    return fail(message ?? `Missing expected rejection: the function threw synchronously with ${String(error)}`, error, undefined, "rejects");
  }
  if (typeof (promise as { then?: unknown }).then !== "function") {
    return fail(
      message ?? `The "promiseOrFunction" argument must be a promise or a function returning one. Received ${typeof promise}`,
      promise,
      Promise,
      "rejects",
    );
  }
  let rejected: unknown;
  let didReject = false;
  try {
    await promise;
  } catch (error) {
    rejected = error;
    didReject = true;
  }
  if (!didReject) return fail(message ?? "Missing expected rejection", undefined, expected, "rejects");
  if (!matchesRejection(rejected, expected)) {
    const described = rejected instanceof Error ? rejected.message : String(rejected);
    return fail(message ?? `The error message did not match the expected rejection: got '${described}'`, rejected, expected, "rejects");
  }
}

/** `assert.doesNotReject`: the inverse, for a path that must settle. */
export async function doesNotReject(
  promiseOrFunction: Promise<unknown> | (() => Promise<unknown>),
  expected?: unknown,
  message?: string,
): Promise<void> {
  let promise: Promise<unknown>;
  try {
    promise = typeof promiseOrFunction === "function" ? promiseOrFunction() : promiseOrFunction;
  } catch (error) {
    return fail(message ?? `Got unwanted exception: ${String(error)}`, error, undefined, "doesNotReject");
  }
  try {
    await promise;
  } catch (error) {
    // An expected rejection is still a rejection: `doesNotReject` with a matcher means "must not reject THIS way", which Node reports
    // as a pass only when the rejection does not match.
    if (expected !== undefined && !matchesRejection(error, expected)) return;
    return fail(message ?? `Got unwanted rejection: ${error instanceof Error ? error.message : String(error)}`, error, undefined, "doesNotReject");
  }
}

export { fail };

const strict = { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual: deepEqualAssert, deepStrictEqual: deepEqualAssert, notDeepEqual, throws, doesNotThrow, match, ifError, fail, AssertionError };

/**
 * The module object, with `strict` carrying the same async helpers.
 *
 * `assert.strict.rejects` is what a test file that imports the module's default and sets `.strict` reaches for, and a member that exists on
 * the namespace but not on `strict` fails at the call site with `undefined is not a function`, one line away from the name it asked for.
 */
export default Object.assign(ok, {
  ok,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual: deepEqualAssert,
  deepStrictEqual: deepEqualAssert,
  notDeepEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  match,
  ifError,
  fail,
  AssertionError,
  strict: Object.assign(strict, { rejects, doesNotReject }),
});
