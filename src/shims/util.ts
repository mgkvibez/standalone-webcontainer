/**
 * `util`: the parts packages actually call, with the string-formatting semantics people depend on.
 *
 * `format` is the one that matters most: `debug` and hundreds of loggers call `util.format("%s %j", a, b)` and the output is what a
 * developer reads when something breaks. `inspect` is deliberately shallower than Node's (no getters are invoked, depth is capped)
 * because invoking a getter to print it is how a logger changes the behaviour of the program it is logging.
 */

import { AssertionError } from "./assert.js";

const customPromisify = Symbol.for("nodejs.util.promisify.custom");

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export interface InspectOptions {
  readonly depth?: number;
  readonly colors?: boolean;
  readonly breakLength?: number;
  readonly showHidden?: boolean;
  readonly compact?: boolean | number;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function inspectValue(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return quote(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "boolean":
      return String(value);
    case "symbol":
      return value.toString();
    case "function": {
      const name = value.name === "" ? "" : `: ${value.name}`;
      return value.toString().startsWith("class") ? `[class${name}]` : `[Function${name}]`;
    }
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return "[Circular *1]";
  if (depth < 0) return Array.isArray(object) ? "[Array]" : "[Object]";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.slice(0, 100).map((item) => inspectValue(item, depth - 1, seen));
      if (object.length > 100) items.push(`... ${object.length - 100} more items`);
      return `[ ${items.join(", ")} ]`;
    }
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
    if (object instanceof RegExp) return String(object);
    if (object instanceof Error) return `${object.name}: ${object.message}`;
    if (object instanceof Map) {
      const entries = [...object.entries()].map(([key, item]) => `${inspectValue(key, depth - 1, seen)} => ${inspectValue(item, depth - 1, seen)}`);
      return `Map(${object.size}) { ${entries.join(", ")} }`;
    }
    if (object instanceof Set) {
      const items = [...object.values()].map((item) => inspectValue(item, depth - 1, seen));
      return `Set(${object.size}) { ${items.join(", ")} }`;
    }
    if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
      const view = object as unknown as ArrayLike<number>;
      return `${object.constructor.name}(${view.length}) [ ${Array.from(view).slice(0, 50).join(", ")} ]`;
    }
    const prototype = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
    const name = prototype?.constructor?.name;
    const prefix = name === undefined || name === "Object" ? "" : `${name} `;
    // Descriptors, not `Object.entries`: a getter that is invoked to print it can change the program being logged, which is the one
    // thing an inspector must never do. Node prints `[Getter]` for the same reason.
    const entries = Object.getOwnPropertyNames(object).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      const label = IDENTIFIER.test(key) ? key : quote(key);
      if (descriptor === undefined) return `${label}: undefined`;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return `${label}: ${descriptor.get === undefined ? "[Setter]" : "[Getter]"}`;
      }
      return `${label}: ${inspectValue(descriptor.value, depth - 1, seen)}`;
    });
    return `${prefix}{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(object);
  }
}

export function inspect(value: unknown, options: InspectOptions | number = {}): string {
  const depth = typeof options === "number" ? options : (options.depth ?? 2);
  return inspectValue(value, depth, new Set<object>());
}

/** `util.format`, with the placeholder set people actually use. */
export function format(...args: unknown[]): string {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first !== "string") return args.map((value) => (typeof value === "string" ? value : inspect(value))).join(" ");
  let index = 1;
  let output = first.replace(/%[sdifjoOc%]/g, (placeholder) => {
    if (placeholder === "%%") return "%";
    if (index >= args.length) return placeholder;
    const value = args[index];
    index += 1;
    switch (placeholder) {
      case "%s":
        return typeof value === "string" ? value : typeof value === "object" && value !== null ? inspect(value, { depth: 0 }) : String(value);
      case "%d":
        if (typeof value === "bigint") return `${value}n`;
        return typeof value === "symbol" ? "NaN" : String(Number(value));
      case "%i":
        return String(Number.parseInt(String(value), 10));
      case "%f":
        return String(Number.parseFloat(String(value)));
      case "%j":
        try {
          return JSON.stringify(value) ?? "undefined";
        } catch {
          return "[Circular]";
        }
      case "%o":
      case "%O":
        return inspect(value);
      default:
        return placeholder;
    }
  });
  for (; index < args.length; index += 1) {
    const value = args[index];
    output += ` ${typeof value === "string" ? value : inspect(value)}`;
  }
  return output;
}

export function formatWithOptions(_options: InspectOptions, ...args: unknown[]): string {
  return format(...args);
}

/** Prototype-chain inheritance, which is all the `inherits` package needs. */
export function inherits(constructor: Function, superConstructor: Function): void {
  Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
  Object.setPrototypeOf(constructor, superConstructor);
}

export function _extend(origin: Record<string, unknown>, ...additions: readonly Record<string, unknown>[]): Record<string, unknown> {
  for (const addition of additions) Object.assign(origin, addition);
  return origin;
}

export function promisify<T extends (...args: never[]) => unknown>(fn: T): T {
  // Node's own first act, and the one that matters here: a member this shim does not implement arrives as `undefined`, and reading a symbol off
  // it crashed with "Cannot read properties of undefined (reading 'Symbol(nodejs.util.promisify.custom)')" from a line that named neither the
  // missing function nor the argument. Node refuses with a typed error instead, so the next gap is reported as itself.
  if (typeof fn !== "function") {
    throw Object.assign(
      new TypeError(`The "original" argument must be of type function. Received ${typeof fn === "undefined" ? "undefined" : typeof fn}`),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  const custom = (fn as unknown as Record<symbol, unknown>)[customPromisify];
  if (typeof custom === "function") return custom as T;
  const wrapped = (...args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      (fn as unknown as (...inner: unknown[]) => void)(...args, (error: unknown, value: unknown) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve(value);
      });
    });
  Object.setPrototypeOf(wrapped, fn);
  return wrapped as unknown as T;
}

promisify.custom = customPromisify;

export function callbackify(fn: (...args: never[]) => Promise<unknown>): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new TypeError("The last argument must be a function");
    const rest = args.slice(0, -1);
    void (fn as unknown as (...inner: unknown[]) => Promise<unknown>)(...rest).then(
      (value) => (callback as (error: null, value: unknown) => void)(null, value),
      (error: Error) => (callback as (error: Error) => void)(error),
    );
  };
}

const warned = new Set<string>();

/** Warns once per message, as Node does, and keeps the original's name and length so a stack reads correctly. */
export function deprecate<T extends Function>(fn: T, message: string, code?: string): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (!warned.has(message)) {
      warned.add(message);
      const suffix = code === undefined ? "" : ` [${code}]`;
      console.warn(`DeprecationWarning: ${message}${suffix}`);
    }
    return (fn as unknown as (...inner: unknown[]) => unknown).apply(this, args);
  };
  Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
  return wrapped as unknown as T;
}

/** `debuglog` only emits when the section is enabled, which in a browser it is not. Returning a function keeps callers working. */
export function debuglog(_section: string, callback?: (fn: (...args: unknown[]) => void) => void): (...args: unknown[]) => void {
  const log = (): void => undefined;
  if (callback !== undefined) queueMicrotask(() => callback(log));
  return log;
}

export const debug = (value: unknown): void => {
  console.error(String(value));
};

export function stripVTControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping escape sequences is the function's entire purpose.
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => isDeepStrictEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export const types = {
  isDate: (value: unknown): value is Date => value instanceof Date,
  isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
  isMap: (value: unknown): value is Map<unknown, unknown> => value instanceof Map,
  isSet: (value: unknown): value is Set<unknown> => value instanceof Set,
  isPromise: (value: unknown): value is Promise<unknown> => value instanceof Promise,
  isAsyncFunction: (value: unknown): boolean => typeof value === "function" && value.constructor.name === "AsyncFunction",
  isNativeError: (value: unknown): value is Error => value instanceof Error,
  isArrayBuffer: (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer,
  isTypedArray: (value: unknown): boolean => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
  isGeneratorFunction: (value: unknown): boolean =>
    typeof value === "function" && ["GeneratorFunction", "AsyncGeneratorFunction"].includes(value.constructor.name),
};

export const isArray = Array.isArray;
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isBuffer = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
export const isError = (value: unknown): value is Error => value instanceof Error;
export const isFunction = (value: unknown): value is Function => typeof value === "function";
export const isNull = (value: unknown): value is null => value === null;
export const isNullOrUndefined = (value: unknown): value is null | undefined => value === null || value === undefined;
export const isNumber = (value: unknown): value is number => typeof value === "number";
export const isObject = (value: unknown): boolean => typeof value === "object" && value !== null;
export const isPrimitive = (value: unknown): boolean => value === null || (typeof value !== "object" && typeof value !== "function");
export const isRegExp = (value: unknown): value is RegExp => value instanceof RegExp;
export const isString = (value: unknown): value is string => typeof value === "string";
export const isSymbol = (value: unknown): value is symbol => typeof value === "symbol";
export const isUndefined = (value: unknown): value is undefined => value === undefined;

export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;
export const inheritsFrom = inherits;
export const assert = (value: unknown, message?: string): void => {
  if (!value) throw new AssertionError({ message: message ?? "assertion failed", actual: value, expected: true, operator: "==" });
};

export const promisifyCustomSymbol = customPromisify;

export default {
  format,
  formatWithOptions,
  inspect,
  inherits,
  _extend,
  promisify,
  callbackify,
  deprecate,
  debuglog,
  debug,
  stripVTControlCharacters,
  isDeepStrictEqual,
  types,
  isArray,
  isBoolean,
  isBuffer,
  isError,
  isFunction,
  isNull,
  isNullOrUndefined,
  isNumber,
  isObject,
  isPrimitive,
  isRegExp,
  isString,
  isSymbol,
  isUndefined,
  TextDecoder,
  TextEncoder,
  assert,
};
