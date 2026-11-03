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
 */

type Listener = (...args: unknown[]) => void;

interface Registration {
  readonly listener: Listener;
  readonly once: boolean;
}

export class EventEmitter {
  readonly #listeners = new Map<string, Registration[]>();

  on(event: string, listener: Listener): this {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const existing = this.#listeners.get(event);
    if (existing === undefined) this.#listeners.set(event, [{ listener, once: false }]);
    else existing.push({ listener, once: false });
    return this;
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: Listener): this {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const existing = this.#listeners.get(event);
    if (existing === undefined) this.#listeners.set(event, [{ listener, once: true }]);
    else existing.push({ listener, once: true });
    return this;
  }

  /** Removes one registration, preferring an exact match. Unknown events and listeners are no-ops. */
  off(event: string, listener: Listener): this {
    const existing = this.#listeners.get(event);
    if (existing === undefined) return this;
    const index = existing.findIndex((registration) => registration.listener === listener);
    if (index >= 0) existing.splice(index, 1);
    if (existing.length === 0) this.#listeners.delete(event);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  /** With no event name, removes everything: what teardown needs to stop all further delivery. */
  removeAllListeners(event?: string): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const registrations = this.#listeners.get(event);
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
    return (this.#listeners.get(event) ?? []).map((registration) => registration.listener);
  }

  listenerCount(event: string): number {
    return (this.#listeners.get(event) ?? []).length;
  }

  eventNames(): readonly string[] {
    return [...this.#listeners.keys()];
  }
}

export type { Listener as EventListener };
