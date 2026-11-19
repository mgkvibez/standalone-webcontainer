/**
 * W-42: report a Worker that closes itself, so the host can settle its process.
 *
 * THE DEFECT THIS ADDRESSES. `DedicatedWorkerGlobalScope.close()` stops the Worker without sending the host a trusted
 * `exit` or `failed` control message, and it fires no error event, so `ProcessHost` has nothing to react to. Measured in
 * Chromium: the process stays `running`, `settled()` stays pending, and the slot stays occupied until someone calls
 * `kill()` or the kernel is disposed. Wrapping the own `close` property with a reporter closes that path deterministically.
 *
 * WHAT THIS DOES NOT CLAIM. It is not detection of silent Worker termination. An OOM kill, a devtools termination, a crash
 * that never reaches `worker.onerror`, or a program that deletes `close` are all still unobserved. ADR-0036 states the
 * guarantee in exactly these terms.
 *
 * WHY THE INVOKER IS A PARAMETER. This wrapper runs after user code has started, so `Function.prototype.call` may have been
 * replaced by then. The caller passes an invocation intrinsic captured before user code (the runtime uses the `Reflect`
 * reference P3-0 already captured). The wrapper never reads a method off a prototype at call time.
 */

/** The shape this reads from: anything with a `close` own property. Structural so a test can pass a plain object. */
export interface CloseScope {
  readonly close?: unknown;
}

/** The trusted report channel. In production this is the worker's private control port. */
export type CloseReport = (message: { readonly type: "failed"; readonly reason: string }) => void;

/** A captured `Reflect.apply`-shaped invoker, so the call path cannot be patched through a prototype. */
export type CloseInvoke = (
  target: (this: unknown) => void,
  thisArg: unknown,
  argumentsList: readonly unknown[],
) => unknown;

/** What actually happened, so a caller can log a reason instead of pretending the instrumentation is always possible. */
export interface CloseInstrumentation {
  readonly installed: boolean;
  readonly reason?: string;
}

/**
 * Replace the scope's own `close` with a reporter that always terminates.
 *
 * The report is best effort and the termination is not: a reporter that throws is swallowed, and native `close` runs
 * either way. A native `close` that throws is NOT swallowed, because a failure to terminate is more important than a
 * failure to describe it.
 */
export function installCloseReport(
  scope: CloseScope,
  report: CloseReport,
  invoke: CloseInvoke,
): CloseInstrumentation {
  if (typeof invoke !== "function") return { installed: false, reason: "no-invoke" };
  const descriptor = Object.getOwnPropertyDescriptor(scope, "close");
  if (descriptor === undefined) return { installed: false, reason: "absent" };
  if (typeof descriptor.value !== "function") return { installed: false, reason: "not-a-function" };
  // Deleting or redefining a non-configurable property throws, and a property we cannot replace is one we cannot report
  // from. Say so rather than leaving a half-installed wrapper behind.
  if (descriptor.configurable !== true) return { installed: false, reason: "not-configurable" };

  const nativeClose = descriptor.value as (this: unknown) => void;
  // Set BEFORE the attempt: one try, not one success. A second `close()` must not send a second report, whether the first
  // one was delivered or not.
  let reported = false;

  function wrapped(this: unknown): void {
    if (!reported) {
      reported = true;
      try {
        report({ type: "failed", reason: "worker closed itself" });
      } catch {
        // Swallowed on purpose. A report that cannot be delivered must never prevent termination, and it is not retried.
        // Nothing is logged here: this runs after user code may have replaced `console`, and the one path that must not
        // throw is a poor place to add a second thing that can.
      }
    }
    // Deliberately outside the catch, and through the captured invoker rather than `nativeClose.call(...)`: if native close
    // itself fails, that failure belongs to the caller and must not be disguised as a swallowed bookkeeping error.
    invoke(nativeClose, scope, []);
  }

  // Feature detection reads `name` and `length`, so the wrapper answers the same as the native function it replaces.
  Object.defineProperty(wrapped, "name", { value: "close", configurable: true });
  Object.defineProperty(wrapped, "length", { value: 0, configurable: true });

  try {
    Object.defineProperty(scope, "close", {
      value: wrapped,
      // A data property always reports these; the coercion is for exactOptionalPropertyTypes, not for a runtime case.
      writable: descriptor.writable === true,
      enumerable: descriptor.enumerable === true,
      configurable: true,
    });
  } catch {
    return { installed: false, reason: "define-failed" };
  }
  return { installed: true };
}
