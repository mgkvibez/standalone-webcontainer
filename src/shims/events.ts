/**
 * `events` shim: an EventEmitter, because almost every Node API is one.
 *
 * This is not incidental scaffolding. `http.Server` emits, request and response objects emit, streams
 * emit, and fixture 4 asserts EventEmitter behaviour directly. Getting the small semantics right here
 * prevents a whole category of subtle wrongness in everything built on top of it.
 *
 * Three behaviours are faithful to Node rather than simplified, because quietly simplifying any of
 * them changes how application code behaves:
 *
 * 1. **`emit("error")` with no listener throws.** Node throws the error rather than swallowing it, and
 *    application code relies on that to surface failures. An emitter that swallowed errors would turn
 *    a crashed server into a silent one.
 * 2. **Listeners are called in registration order, and `once` removes itself before invoking.** If
 *    removal happened after, a listener that re-emits would fire twice.
 * 3. **A listener added during `emit` is not called for that emit.** Node iterates a snapshot, so a
 *    handler that subscribes to a later event does not receive the one currently in flight.
 *
 * Deliberately absent, and named here so the audit sees the boundary rather than discovering it:
 * `prependListener`, `setMaxListeners` enforcement (we do not warn at 11 listeners), promise-based
 * `events.once()`, and `captureRejections`. None are needed by the APIs we shim, and implementing them
 * half-heartedly would be worse than not having them.
 *
 * What the MODULE is, as opposed to the class, is decided at the bottom of this file: in Node
 * `require("events")` IS the EventEmitter constructor, with the class attached to itself, and a package
 * that writes `class X extends require("events")` depends on that rather than on a namespace object.
 */

type Listener = (...args: unknown[]) => void;

interface Registration {
  readonly listener: Listener;
  readonly once: boolean;
}

/**
 * Listener storage lives outside the instance, keyed by whatever object is calling.
 *
 * This is not an optimisation. `EventEmitter.prototype` is routinely **mixed into a plain object** (`express` does exactly that with
 * `merge-descriptors`, then calls `app.on(...)`), and Node's emitter supports it because its state is an ordinary property. A `#private`
 * field cannot be read from an object that is not an instance of this class, so those calls threw "Cannot read private member
 * #listeners from an object whose class did not declare it". A WeakMap keyed by `this` gives every object its own registry and keeps
 * the state out of sight, which is what the private field was for.
 */
const registries = new WeakMap<object, Map<string, Registration[]>>();

function listenersOf(target: object): Map<string, Registration[]> {
  let registry = registries.get(target);
  if (registry === undefined) {
    registry = new Map<string, Registration[]>();
    registries.set(target, registry);
  }
  return registry;
}

function peek(target: object): Map<string, Registration[]> | undefined {
  return registries.get(target);
}

export class EventEmitter {

  on(event: string, listener: Listener): this {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const existing = listenersOf(this).get(event);
    if (existing === undefined) listenersOf(this).set(event, [{ listener, once: false }]);
    else existing.push({ listener, once: false });
    return this;
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: Listener): this {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const existing = listenersOf(this).get(event);
    if (existing === undefined) listenersOf(this).set(event, [{ listener, once: true }]);
    else existing.push({ listener, once: true });
    return this;
  }

  /** Removes one registration, preferring an exact match. Unknown events and listeners are no-ops. */
  off(event: string, listener: Listener): this {
    const existing = listenersOf(this).get(event);
    if (existing === undefined) return this;
    const index = existing.findIndex((registration) => registration.listener === listener);
    if (index >= 0) existing.splice(index, 1);
    if (existing.length === 0) listenersOf(this).delete(event);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  /** With no event name, removes everything: what teardown needs to stop all further delivery. */
  removeAllListeners(event?: string): this {
    if (event === undefined) listenersOf(this).clear();
    else listenersOf(this).delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const registrations = listenersOf(this).get(event);
    if (registrations === undefined || registrations.length === 0) {
      // Node's special case, preserved on purpose: an unhandled "error" is thrown, not dropped.
      if (event === "error") {
        const [cause] = args;
        if (cause instanceof Error) throw cause;
        throw new Error(`Unhandled error event: ${String(cause)}`);
      }
      return false;
    }

    // Snapshot: a listener added during this emit must not receive it.
    const snapshot = [...registrations];
    for (const registration of snapshot) {
      if (registration.once) this.off(event, registration.listener);
      registration.listener.apply(this, args);
    }
    return true;
  }

  listeners(event: string): readonly Listener[] {
    return (listenersOf(this).get(event) ?? []).map((registration) => registration.listener);
  }

  listenerCount(event: string): number {
    return (listenersOf(this).get(event) ?? []).length;
  }

  eventNames(): readonly string[] {
    return [...(peek(this)?.keys() ?? [])];
  }
}

export type { Listener as EventListener };

/**
 * Node's module object, which IS the class.
 *
 * `require("events")` returns the EventEmitter constructor itself, with the class hung off it as a property: in Node
 * `require("events") === require("events").EventEmitter` (measured, node v20.20.2). Packages rely on the module value being
 * usable as a base class, and vite's bundled chunk does exactly that (`import require$$0$7 from 'events'` then
 * `class WebSocket extends require$$0$7`), so a namespace object here is not a smaller version of the module: it is a different
 * thing, and it fails as `Class extends value #<Object> is not a constructor`.
 *
 * Two members are attached, both because they are VALUES rather than behaviour this runtime would have to fake:
 *
 * - `EventEmitter`, the self-reference above, so both call styles address the same class.
 * - `defaultMaxListeners`, with Node's own validation: a non-number is a `TypeError` with `ERR_INVALID_ARG_TYPE`, and a negative
 *   or NaN value is a `RangeError` with `ERR_OUT_OF_RANGE`, messages and codes measured against node v20.20.2 rather than
 *   recalled. Nothing WARNS at the limit, which is the boundary the header already describes: the number is readable and
 *   writable, and no listener count is checked against it.
 *
 * `once`, `on`, `listenerCount` and `getEventListeners` are now implemented (docs/audit/api-surface-p0.md): `events.once` is
 * everywhere in modern packages, and its absence failed at the call site rather than degrading. Still absent, and absent rather than
 * stubbed because presence would promise behaviour: `errorMonitor`, `captureRejectionSymbol`, `captureRejections` and
 * `EventEmitterAsyncResource`.
 */
let defaultMaxListeners = 10;

Object.defineProperties(EventEmitter, {
  EventEmitter: { value: EventEmitter, enumerable: true, writable: true, configurable: true },
  defaultMaxListeners: {
    enumerable: true,
    configurable: false,
    get: () => defaultMaxListeners,
    set: (value: unknown) => {
      if (typeof value !== "number") {
        // Node names the type it received, and quotes a string value: `Received type string ('x')`.
        const received = value === null ? "null" : typeof value === "string" ? `string ('${value}')` : typeof value;
        throw Object.assign(new TypeError(`The "defaultMaxListeners" argument must be of type number. Received type ${received}`), {
          code: "ERR_INVALID_ARG_TYPE",
        });
      }
      if (Number.isNaN(value) || value < 0) {
        throw Object.assign(new RangeError(`The value of "defaultMaxListeners" is out of range. It must be >= 0. Received ${String(value)}`), {
          code: "ERR_OUT_OF_RANGE",
        });
      }
      defaultMaxListeners = value;
    },
  },
});

/**
 * `events.once`, over the emitter's own public surface.
 *
 * Registered SYNCHRONOUSLY and before the promise is returned, because that is the contract a caller writes against:
 * `once(emitter, "x").then(..)` followed by `emitter.emit("x")` in the same turn must resolve. An `async function` would still do that (its
 * body runs to the first `await` immediately), but a promise built by hand cannot drift into a different registration order by accident.
 *
 * An `error` event while waiting for anything else REJECTS the wait, and `once(emitter, "error")` RESOLVES with it, which is Node's split and
 * the reason a listener on the wrong event is not enough.
 */
export function once(
  emitter: EventEmitter,
  name: string,
  options: { readonly signal?: { readonly aborted: boolean; addEventListener?: (type: string, listener: () => void) => void } } = {},
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const done = (): void => {
      emitter.removeListener(name, onEvent as never);
      if (name !== "error") emitter.removeListener("error", onError as never);
    };
    function onEvent(...args: unknown[]): void {
      done();
      resolve(args);
    }
    function onError(error: unknown): void {
      done();
      reject(error);
    }
    if (options.signal?.aborted === true) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
      return;
    }
    options.signal?.addEventListener?.("abort", () => {
      done();
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    });
    emitter.on(name, onEvent as never);
    if (name !== "error") emitter.on("error", onError as never);
  });
}

/**
 * `events.on`, the async iterator form.
 *
 * A queue rather than a stream, because the emitter is synchronous and the consumer is not: an emit that arrives between two `await`s must
 * be held rather than dropped, and `return()` must unhook the listener or a `break` in the caller's loop leaks it for the process's life.
 */
export function on(emitter: EventEmitter, name: string): AsyncIterableIterator<unknown[]> {
  const buffered: unknown[][] = [];
  let waiting: ((result: IteratorResult<unknown[]>) => void) | null = null;
  const push = (...args: unknown[]): void => {
    if (waiting !== null) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: args, done: false });
      return;
    }
    buffered.push(args);
  };
  emitter.on(name, push as never);
  const iterator: AsyncIterableIterator<unknown[]> = {
    next: () => {
      const queued = buffered.shift();
      if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
      return new Promise<IteratorResult<unknown[]>>((resolve) => {
        waiting = resolve;
      });
    },
    return: () => {
      emitter.removeListener(name, push as never);
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

/** Node's static form: the same count `emitter.listenerCount(name)` answers, so the two cannot disagree. */
export function listenerCount(emitter: EventEmitter, name: string): number {
  return emitter.listenerCount(name);
}

/** The listeners themselves, as a copy: Node returns an array a caller may sort without disturbing the emitter. */
export function getEventListeners(emitter: EventEmitter, name: string): unknown[] {
  return emitter.listeners(name) as unknown[];
}

/** What the loader serves for `events` and `node:events`: the class itself, with Node's module members attached. */
export type EventsModule = typeof EventEmitter & {
  readonly EventEmitter: typeof EventEmitter;
  defaultMaxListeners: number;
  readonly once: typeof once;
  readonly on: typeof on;
  readonly listenerCount: typeof listenerCount;
  readonly getEventListeners: typeof getEventListeners;
};

export const eventsModule = Object.assign(EventEmitter, { once, on, listenerCount, getEventListeners }) as EventsModule;
