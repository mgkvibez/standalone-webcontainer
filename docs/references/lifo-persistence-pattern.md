# Lifo — Persistence Pattern (Clean Room Abstract)

**Source:** lifo-sh/lifo (TypeScript). **License:** none — fully restricted; concepts only.
**Studied:** kernel persistence layer (manager, backends, serializer), node-compat layer structure, README layering.
**Informs:** our Phase 2 persistence (ADR-0002 #3: OPFS contents + IndexedDB metadata) and shim layering (ADR-0002 #7). No decisions made here — candidate concepts for the expert's ADR-0003.

## Layering concept (why the compat layer sits where it does)

Lifo's stack, top to bottom: terminal UI → shell → command registry →
**Node.js compatibility layer** → **VFS** → kernel API → browser APIs.
The compat layer is a set of *thin wrappers over OS/VFS APIs* — one
module per Node builtin (`fs`, `path`, `process`, `buffer`, `events`,
`stream`, `http`, `os`, `tty`, `vm`, `zlib`, ...), each delegating to
kernel services, with one test file per module. The dependency arrow is
inverted from Node's: shims do not own state; they translate calls into
VFS/kernel operations. This matches our ADR-0002 #1/#7 direction
(shims on top of a VFS they do not own).

## Persistence concepts

1. **Pluggable backend interface.** Persistence is an interface with
   four operations (open, load-whole-tree, save-whole-tree, close).
   IndexedDB and in-memory are interchangeable behind it. The VFS core
   knows nothing about IndexedDB.

2. **Debounced whole-tree snapshots.** Mutations schedule a save with a
   ~1 second trailing debounce: bursts of writes coalesce into one
   snapshot. The snapshot is *the entire tree, serialized, into a single
   IndexedDB record* — one key, one object store, no per-file records.

3. **What gets persisted is a policy, not an accident.**
   - Virtual providers (`proc`, `dev`, mounts) are never persisted —
     they are regenerable state.
   - `node_modules` is *never* persisted at any depth. Their rationale,
     quoted as concept: a single `npm install` can add tens of
     thousands of files; serializing that tree (and re-reading it at
     boot) froze their main thread for seconds. Reinstall after reload,
     or opt into an explicit snapshot.

4. **Serialized tree format.**
   - Compact records (short field keys, timestamps, POSIX mode).
   - Small files: contents inlined, base64-encoded. Encoding is done
     in ~32 KB batches because byte-at-a-time encoding is pathologically
     slow.
   - Large/chunked files: the tree stores only a *chunk manifest* —
     chunk list of (content-hash, size) plus a blob-store reference.
     File data lives in a separate content-addressed blob store, so the
     tree record stays small, identical chunks deduplicate, and
     re-saving a tree does not re-copy unchanged bytes.

5. **Failure philosophy: availability over durability.**
   - IndexedDB unavailable → fall back to in-memory backend, persistence
     silently disabled.
   - Load fails or tree fails to deserialize → return null → boot fresh
     rather than mount a corrupt tree.
   - Save fails → ignored; the OS keeps running.
   - Corrupt trees never enter memory; errors never crash the runtime.

## Candidate mapping to our Phase 2 (for ADR-0003 — expert decides)

- A `PersistenceBackend` interface keeps ADR-0002 #3's "OPFS contents +
  IndexedDB metadata" swappable and testable (in-memory backend in unit
  tests, no IndexedDB mocking).
- Debounced snapshot writes fit our single-owner worker: the worker
  serializes on its own thread, the main thread is never involved.
- The `node_modules` exclusion directly addresses our npm-flow hazards:
  our Phase 3 `npm install` will produce trees far too large to
  serialize; persistence policy must exclude them (or snapshot
  explicitly), or boot times explode.
- Content-addressed chunk manifests compose with our existing chunked
  `FileNode` storage (ADR-0002 #4): a chunk's hash is already a natural
  persistence key.
- Snapshot-vs-per-path is a real tradeoff to decide in ADR-0003:
  lifo chose whole-tree snapshots (simple, atomic, but heavy with many
  files); wanix chose per-path records (incremental, indexable — see
  the wanix abstract). Our `node_modules`-excluded trees may be small
  enough for snapshots; the expert calls it.
