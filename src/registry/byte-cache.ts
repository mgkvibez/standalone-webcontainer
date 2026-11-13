/**
 * Where downloaded package bytes are kept between installs.
 *
 * A cache in this runtime has one non-negotiable property: it must never be able to install bytes nobody verified. The installer verifies every
 * tarball it receives against `dist.integrity` on *every* install, so a corrupted entry here is refused downstream rather than trusted here. That
 * is why this module is allowed to be purely an optimization: it never decides whether bytes are good, only whether they are already on hand.
 *
 * Two implementations, one contract:
 *
 * - **memory**: bounded by bytes, evicted oldest-first. Dies with the tab. Used by tests and by any environment without IndexedDB.
 * - **IndexedDB**: the same policy, persisted, so reopening a workspace restores a dependency tree from bytes already downloaded instead of
 *   pulling megabytes again. Entries carry a timestamp and expire, because "this URL is immutable" is npm's policy rather than a law of physics.
 *
 * Deliberately not `CacheStorage`: that API is named for HTTP responses and its eviction is the browser's decision, and an install that silently
 * re-downloads is fine while an install that silently half-evicts a tree is not something this layer should have to reason about.
 */

/** The storage contract the registry client holds. Every method may fail; a caller treats failure as a cache miss. */
export interface ByteCache {
  readonly kind: "memory" | "indexeddb";
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export interface MemoryByteCacheOptions {
  readonly maxBytes: number;
}

/**
 * A bounded least-recently-used map of byte arrays.
 *
 * `Map` preserves insertion order, so re-inserting a key on a hit makes iteration order recency order and eviction is "delete the first key".
 * A `Set` plus a `Map` would be the textbook shape; one map with a delete-then-set is the same guarantee with half the bookkeeping.
 */
export function createMemoryByteCache(options: MemoryByteCacheOptions): ByteCache {
  const maxBytes = Math.max(0, options.maxBytes);
  const entries = new Map<string, Uint8Array>();
  let held = 0;
  return {
    kind: "memory",
    async get(key: string): Promise<Uint8Array | null> {
      const found = entries.get(key);
      if (found === undefined) return null;
      entries.delete(key);
      entries.set(key, found);
      return found;
    },
    async set(key: string, bytes: Uint8Array): Promise<void> {
      const existing = entries.get(key);
      if (existing !== undefined) {
        held -= existing.byteLength;
        entries.delete(key);
      }
      if (bytes.byteLength > maxBytes) return;
      entries.set(key, bytes);
      held += bytes.byteLength;
      for (const oldest of entries.keys()) {
        if (held <= maxBytes) break;
        const removed = entries.get(oldest);
        entries.delete(oldest);
        if (removed !== undefined) held -= removed.byteLength;
      }
    },
    async clear(): Promise<void> {
      entries.clear();
      held = 0;
    },
  };
}

export interface IndexedDbByteCacheOptions {
  readonly maxBytes: number;
  /** How long a stored tarball may be reused before it is fetched again. */
  readonly maxAgeMs?: number;
  /** A single tarball larger than this is served but never stored, so one huge package cannot empty the cache. */
  readonly maxEntryBytes?: number;
  readonly now?: () => number;
  /** Overridden by tests; defaults to the global factory. */
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const STORE = "tarballs";

interface StoredBytes {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly storedAt: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexedDB request failed"));
  });
}

/**
 * The persisted cache, or null when this environment has no IndexedDB.
 *
 * Opening is lazy and the open promise is shared, so the first install pays for it and every later one does not. A failed open is remembered as a
 * failure rather than retried per call: a browser in a mode that refuses storage should cost one refusal, not one per package.
 */
export function createIndexedDbByteCache(options: IndexedDbByteCacheOptions): ByteCache | null {
  const factory = options.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  if (factory === undefined) return null;
  const maxBytes = Math.max(0, options.maxBytes);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const now = options.now ?? (() => Date.now());
  const databaseName = options.databaseName ?? "swc.registry.tarballs.v1";

  let opening: Promise<IDBDatabase | null> | null = null;

  const open = (): Promise<IDBDatabase | null> => {
    if (opening !== null) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      const done = (value: IDBDatabase | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let openRequest: IDBOpenDBRequest;
      try {
        openRequest = factory.open(databaseName, 1);
      } catch {
        done(null);
        return;
      }
      openRequest.onupgradeneeded = () => {
        const database = openRequest.result;
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "key" });
      };
      openRequest.onsuccess = () => done(openRequest.result);
      // A private-mode browser, a denied quota or a version conflict all land here. The cache is an optimization, so the answer is "no cache".
      openRequest.onerror = () => done(null);
      openRequest.onblocked = () => done(null);
    });
    return opening;
  };

  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T | null> => {
    const database = await open();
    if (database === null) return null;
    try {
      const transaction = database.transaction(STORE, mode);
      const result = await run(transaction.objectStore(STORE));
      return result;
    } catch {
      return null;
    }
  };

  return {
    kind: "indexeddb",
    async get(key: string): Promise<Uint8Array | null> {
      const record = await withStore("readonly", async (store) => request<StoredBytes | undefined>(store.get(key)));
      if (record === null || record === undefined) return null;
      if (now() - record.storedAt > maxAgeMs) {
        await withStore("readwrite", async (store) => request(store.delete(key)));
        return null;
      }
      return record.bytes;
    },
    async set(key: string, bytes: Uint8Array): Promise<void> {
      if (bytes.byteLength > maxEntryBytes || bytes.byteLength > maxBytes) return;
      const stored = await withStore("readwrite", async (store) => {
        await request(store.put({ key, bytes, storedAt: now() } satisfies StoredBytes));
        return true;
      });
      if (stored === null) return;
      // Eviction runs after the write rather than before, so the install that just happened is the one kept and the oldest entries pay for it.
      await withStore("readwrite", async (store) => {
        const all = await request<StoredBytes[]>(store.getAll());
        let held = all.reduce((total, entry) => total + entry.bytes.byteLength, 0);
        if (held <= maxBytes) return true;
        for (const entry of [...all].sort((left, right) => left.storedAt - right.storedAt)) {
          if (held <= maxBytes) break;
          await request(store.delete(entry.key));
          held -= entry.bytes.byteLength;
        }
        return true;
      });
    },
    async clear(): Promise<void> {
      await withStore("readwrite", async (store) => request(store.clear()));
    },
  };
}
