/**
 * Watching, for a runtime that owns its filesystem directly.
 *
 * The in-process runtime has the VFS in its own thread, so there is no channel to cross — but it still uses the same registry
 * and the same polling client as a real process, on purpose. A second, push-based watcher would be a second set of semantics
 * to keep in step: one would coalesce and the other would not, one would keep `rename` dominant and the other might not. The
 * only difference here is that the transport is a direct function call instead of a channel.
 */

import type { WatchTickScheduler } from "./remote-watch.js";
import { createRemoteWatcher, realTimerScheduler } from "./remote-watch.js";
import { createFsSyscallHandler } from "./fs-syscalls.js";
import { WatchRegistry } from "./watch-registry.js";
import type { WatchSourcePort } from "../vfs/port.js";

/** The slice of `FileSystem` this module needs, so it never imports the whole class for a type. */
export interface WatchableFileSystem {
  statSync(path: string): { readonly kind: "file" | "dir" };
  subscribe(listener: (change: { kind: "change" | "rename"; path: string; previousPath?: string }) => void): () => void;
}

export interface LocalWatchSource extends WatchSourcePort {
  /** Direct access for evidence and tests: the same registry the client polls. */
  readonly registry: WatchRegistry;
}

export interface LocalWatchOptions {
  readonly intervalMs?: number;
  readonly scheduler?: WatchTickScheduler;
}

export const createLocalWatchSource = (
  fs: WatchableFileSystem,
  options: LocalWatchOptions = {},
): LocalWatchSource => {
  const registry = new WatchRegistry({ statKind: (path) => fs.statSync(path).kind });
  fs.subscribe((change) => registry.notify(change));
  const handler = createFsSyscallHandler(fs as never, { watches: registry, owner: "local" });
  const scheduler = options.scheduler ?? realTimerScheduler;
  return {
    registry,
    watch: (path, watchOptions) =>
      createRemoteWatcher({
        transport: { call: (request) => handler(request) },
        path,
        scheduler,
        ...(watchOptions?.recursive === true ? { recursive: true } : {}),
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      }),
  };
};
