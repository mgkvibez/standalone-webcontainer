/**
 * Real asynchronous work the scheduler's timer queue cannot see.
 *
 * THE PROBLEM THIS SOLVES, MEASURED. `WebAssembly.instantiate` and `WebAssembly.compile` hand back a promise that settles on real work outside this
 * runtime's control: V8 compiles on another thread, and nothing in the timer queue is involved. The scheduler decides a suspended program body has
 * "nothing left to offer" when its queue is empty, so it gave up after a single real turn. A program awaiting a wasm instantiation therefore ended
 * with **exit 0 and no output**, which is indistinguishable from a program that finished. That is how `vite build` with a `vite.config.js` came to
 * report success while emitting nothing: vite loads the config by bundling it with esbuild, esbuild-wasm's service is a Go program on a
 * `WebAssembly.Module`, and the await never got the turns it needed.
 *
 * WHAT IS COUNTED, AND WHY ONLY THAT. In flight means started and not yet settled. Only operations this runtime cannot drive itself are counted:
 * the four WebAssembly promise-returning entry points. A timer, an `fs` callback and a promise continuation are all things the queue already knows
 * about, and counting them twice would make the loop wait for work it is about to run.
 *
 * WHY A COUNTER AND NOT A HANDLE. Node keeps a process alive because the operation holds a libuv handle. This runtime has no such handle to hold,
 * so the equivalent is an explicit count the scheduler polls. It is the same mechanism, spelled in the vocabulary this runtime owns.
 */

let inFlight = 0;

/** Marks one unit of outside asynchronous work as started. Returns the function that marks it finished (idempotent). */
export function beginAsyncWork(): () => void {
  inFlight += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    inFlight -= 1;
  };
}

/** How many outside asynchronous operations are in flight right now. Zero is the only value that lets a suspended body be declared finished. */
export function pendingAsyncWork(): number {
  return inFlight;
}

/** Test seam: the count is process-wide state, and a test that leaves it dirty would poison every later case. */
export function resetAsyncWork(): void {
  inFlight = 0;
}

/**
 * Wraps a promise so it counts as outside work for as long as it is unsettled.
 *
 * `finally` rather than `then`: a rejection has to release the count too, or one failed compilation would keep every later program alive forever.
 */
export function counted<T>(operation: Promise<T>): Promise<T> {
  const finish = beginAsyncWork();
  return operation.finally(finish);
}

/**
 * The realm's `WebAssembly`, with its asynchronous entry points counted.
 *
 * Everything else is passed through untouched, including the constructors: `new WebAssembly.Module(bytes)` is synchronous, so it is not work the
 * loop has to wait for, and a program that constructs one should not keep a process alive.
 */
export function countedWebAssembly<T extends object>(wasm: T): T {
  const countedNames = new Set(["compile", "instantiate", "compileStreaming", "instantiateStreaming"]);
  return new Proxy(wasm, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string" || !countedNames.has(property)) return value;
      return (...args: unknown[]) => counted((value as (...inner: unknown[]) => Promise<unknown>).apply(target, args));
    },
  }) as T;
}
