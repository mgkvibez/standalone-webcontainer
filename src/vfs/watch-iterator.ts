/**
 * The async-iterator face of a watcher, kept apart from any transport.
 *
 * `fs.promises.watch()` returns an async iterable, and `for await` over it must release the underlying watch when the loop is
 * abandoned. That logic is small but subtle enough to be worth one implementation shared by every watcher source, rather than
 * one per transport: an iterator that forgets to close leaks a kernel watch, and one that never ends hangs a program.
 */

export interface WatchSourcePort {
  watch(path: string, options?: { readonly recursive?: boolean }): WatchHandlePort;
}

export interface WatchHandlePort {
  /** `(eventType, filename)` for change events; `error` and `close` are lifecycle signals. */
  on(event: "change" | "rename" | "error" | "close", listener: (...args: never[]) => void): unknown;
  close(): void;
  readonly closed: boolean;
}

export interface WatchEvent {
  readonly eventType: "change" | "rename";
  readonly filename: string;
}

export interface WatchAsyncIterator extends AsyncIterable<WatchEvent> {
  next(): Promise<IteratorResult<WatchEvent>>;
  return(): Promise<IteratorResult<WatchEvent>>;
}

export const toWatchAsyncIterator = (handle: WatchHandlePort): WatchAsyncIterator => {
  const queue: WatchEvent[] = [];
  let waiting: undefined | ((result: IteratorResult<WatchEvent>) => void) = undefined;
  let done = false;

  const settle = (): void => {
    if (waiting === undefined) return;
    const next = queue.shift();
    if (next !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: next, done: false });
    } else if (done) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  };

  const remember = (eventType: "change" | "rename", filename: string): void => {
    if (done) return;
    queue.push({ eventType, filename });
    settle();
  };

  handle.on("change", remember as (...args: never[]) => void);
  handle.on("rename", remember as (...args: never[]) => void);
  // A watcher that closes (or dies) ends the iteration instead of leaving a `for await` parked forever.
  handle.on("close", () => {
    done = true;
    settle();
  });

  const iterator: AsyncIterator<WatchEvent> = {
    next: () => {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve({ value: next, done: false });
      if (done) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
        settle();
      });
    },
    return: () => {
      done = true;
      queue.length = 0;
      handle.close();
      settle();
      return Promise.resolve({ value: undefined as never, done: true });
    },
  };

  return Object.assign(iterator as unknown as WatchAsyncIterator, {
    [Symbol.asyncIterator]: () => iterator,
  });
};

/**
 * Count live watches, so a runtime can tell that a program is still waiting on the outside world.
 *
 * The count drops on an explicit `close()` AND on the handle's own `close` event, because a watcher can close itself when its
 * channel dies. Counting only explicit closes would leave the number stuck above zero and hold a finished program open until
 * the real-time guard ended it: a leak that presents as a hang.
 */
export const createCountedWatchSource = (
  inner: WatchSourcePort,
): { readonly source: WatchSourcePort; readonly open: () => number } => {
  let open = 0;
  const source: WatchSourcePort = {
    watch: (path, options) => {
      const handle = inner.watch(path, options);
      open += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        open -= 1;
      };
      handle.on("close", release as (...args: never[]) => void);
      return {
        on: (event, listener) => handle.on(event, listener),
        close: () => {
          release();
          handle.close();
        },
        get closed() {
          return handle.closed;
        },
      };
    },
  };
  return { source, open: () => open };
};
