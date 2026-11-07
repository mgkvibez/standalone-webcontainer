/**
 * Hard timeouts (charter §4.5): "Hanging processes produce TIMEOUT, not infinite waits."
 *
 * The wrapper returns TIMEOUT as a value rather than throwing, because a timeout is an outcome to be
 * classified and stored with evidence, not an exception to be caught somewhere up the stack.
 */

export interface TimeoutSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly elapsedMs: number;
}

export interface TimeoutFailure {
  readonly ok: false;
  readonly classification: "TIMEOUT";
  readonly elapsedMs: number;
}

export type TimeoutResult<T> = TimeoutSuccess<T> | TimeoutFailure;

export async function withTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<TimeoutResult<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, received ${timeoutMs}`);
  }

  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const running = Promise.resolve().then(work);
  // If the timeout wins, this promise may still reject later. The caller has already been told
  // TIMEOUT and has stopped caring; an unhandled rejection here would crash the run it just ended.
  void running.catch(() => undefined);

  const timeout = new Promise<TimeoutFailure>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, classification: "TIMEOUT", elapsedMs: now() - startedAt });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      running.then((value) => ({ ok: true as const, value, elapsedMs: now() - startedAt })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
