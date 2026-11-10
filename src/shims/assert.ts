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

export { fail };

const strict = { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual: deepEqualAssert, deepStrictEqual: deepEqualAssert, notDeepEqual, throws, doesNotThrow, match, ifError, fail, AssertionError };

export default Object.assign(ok, { ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual: deepEqualAssert, deepStrictEqual: deepEqualAssert, notDeepEqual, throws, doesNotThrow, match, ifError, fail, AssertionError, strict });
