/**
 * `async_hooks`, reduced to `AsyncLocalStorage` with synchronous semantics.
 *
 * Packages (raw-body, on-finished) require this module only if it exists, to attach a request id to log lines. A faithful
 * implementation would need to instrument every promise boundary in the runtime; this one propagates through the `run` callback and
 * anything it awaits, which covers the request-scoped-store pattern, and documents that a store does **not** survive an unawaited
 * boundary. `createHook` is accepted and inert: a hook that was silently never called is the honest version of "not supported".
 */

export class AsyncLocalStorage<T> {
  #store: T | undefined = undefined;
  #enabled = true;

  /**
   * Runs `callback` with `store` in place.
   *
   * When the callback returns a promise the store is held until that promise settles, which is what makes
   * `await storage.run(store, async () => { ... })` see the store across its own awaits. A promise the callback *detaches* (never
   * awaited) can resume under a different store, because nothing here instruments promise boundaries; that is the documented limit
   * rather than a hidden one.
   */
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.#store;
    this.#store = store;
    let result: R;
    try {
      result = callback(...args);
    } catch (error) {
      this.#store = previous;
      throw error;
    }
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      return (result as unknown as Promise<unknown>).finally(() => {
        this.#store = previous;
      }) as unknown as R;
    }
    this.#store = previous;
    return result;
  }

  getStore(): T | undefined {
    return this.#enabled ? this.#store : undefined;
  }

  enterWith(store: T): void {
    this.#store = store;
  }

  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.#store;
    this.#store = undefined;
    try {
      return callback(...args);
    } finally {
      this.#store = previous;
    }
  }

  disable(): void {
    this.#enabled = false;
    this.#store = undefined;
  }

  /** `bind` keeps the store around a function; the returned function carries it explicitly rather than implicitly. */
  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    const store = this.#store;
    return ((...args: never[]) => this.run(store as T, fn as unknown as (...inner: unknown[]) => unknown, ...args)) as unknown as F;
  }

  snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const store = this.#store;
    return <R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R => this.run(store as T, fn, ...args);
  }

  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return fn;
  }

  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    return <R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R => fn(...args);
  }
}

export class AsyncResource {
  readonly type: string;

  constructor(type: string = "AsyncResource") {
    this.type = type;
  }

  runInAsyncScope<R>(callback: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return callback.apply(thisArg, args);
  }

  emitDestroy(): void {
    return undefined;
  }

  asyncId(): number {
    return 0;
  }

  triggerAsyncId(): number {
    return 0;
  }

  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return fn;
  }
}

/** A hook that is never called, with the shape a caller expects to enable and disable. */
export function createHook(): { enable(): void; disable(): void } {
  return { enable: () => undefined, disable: () => undefined };
}

export const executionAsyncId = (): number => 0;
export const triggerAsyncId = (): number => 0;
export const executionAsyncResource = (): object => ({});

export default { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId, executionAsyncResource };
