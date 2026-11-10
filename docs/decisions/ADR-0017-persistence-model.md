# ADR-0017: Persistence layout — one key per project, plus a reconciliation listener

**Status:** Accepted (owner decision, 2026-11-10). **Supersedes:** the single-key `swc.projects.v1` layout described in ADR-0003's
persistence note. **Depends on:** `docs/audit/persistence-limits.md` (the measurements that forced the decision).

## Context

Persistence was one `localStorage` key holding every project, rewritten in full on every save: a change to one file wrote every
project's files again. Two consequences were measured in Chromium (PR #40):

1. **A single key caps every project at ~4.94 M characters.** Because saves rewrote the whole map, a large project (a vendored
   dependency tree, say) pushed the others toward the quota. The quota belongs to the origin, not the project.
2. **Two tabs silently destroyed each other's projects.** Each tab held the whole map in memory, read storage only at boot, and had
   no `storage` listener. Tab B would rewrite the map from its stale copy, and tab A's newly created project disappeared from
   storage with no signal to either tab. A's own memory still showed the project, so A could not tell anything had happened.

A failed save was already loud (`#save-state` shows `could not save: …`), so the ceiling was the less dangerous half. The silent
cross-tab loss was the serious one, and it was a consequence of the layout rather than of any one function.

## Decision

**One key per project, a small index key, and a `storage` listener that reconciles.** Chosen by the owner over three alternatives
(single key + listener; IndexedDB now; OPFS + Web Locks), on the grounds that it removes both silent losses without turning every
synchronous save call site asynchronous.

Layout:

| Key | Contents |
|---|---|
| `swc.projects.v2.index` | `{ version: 2, activeId, order: string[] }` |
| `swc.projects.v2.project.<id>` | `{ version: 2, project }` |
| `swc.projects.v1` | legacy; read once to migrate, then removed, never written |

Rules that make it correct, each with the failure it prevents:

1. **The index is written last.** A reader can never see an index naming a project whose key is not on disk yet.
2. **Only changed projects are rewritten.** `persist()` compares each project's serialization against what it last wrote for that
   id. A save costs one project, which is the point of the split. Unchanged projects are not touched.
3. **The selection is per tab.** The index records the writer's `activeId`, but a tab does not adopt it: two tabs taking turns over
   the selection would fight. A tab changes selection only when its own project no longer exists.
4. **Last write wins, per project, and is announced.** A newer version from another tab replaces the local one and sets a notice
   (`<name> changed in another tab`). Merging file-level would be a different, larger feature; the failure being fixed is the
   *silence*, not the resolution order.
5. **Project numbers come from the ids present, not from a count.** With deletion (and other tabs creating projects), counting
   produced an id that already existed, whose key would overwrite another project's.
6. **One corrupt project costs one project.** Load parses each project under its own `try`; the first version wrapped the whole loop
   and a single unreadable record silently reseeded the entire workspace. Partial loads are reported (`some saved projects could not
   be read`).
7. **The legacy key is removed only after the v2 write succeeds.** If the migration write fails, the v1 key remains the only copy.

Migration is read-through: `load()` prefers the v2 index, falls back to the v1 key, writes v2, then deletes v1. No user action.

## Consequences

- A save now writes one project plus the index. The index is small (ids), so per-save cost is dominated by the edited project.
- Deleting a project frees its quota immediately, because the key is removed (when the storage object supports `removeItem`).
- The page re-renders on another tab's change, and says so where saves are reported. A change from another tab no longer looks like
  a successful save.
- The ~4.94 M character ceiling still applies **per project**. A project larger than that still fails to save, and still says so. The
  measurement in `docs/audit/persistence-limits.md` remains the honest statement of the limit; this ADR only stops one project's
  size from costing the others.
- **Known limit: simultaneous creation can still collide on an id.** Two tabs creating a project in the same instant both derive
  the next number from the ids they can see, so both may choose `project-4`. The later write wins and the earlier project is
  replaced by it, with the notice raised. This is rarer than the loss it replaces (a whole workspace versus one project created in
  the same instant as another), and fixing it properly needs a cross-tab lock, which is the Web Locks row of the option table and
  was deliberately deferred. Recorded here rather than discovered later.
- IndexedDB and OPFS stay deferred. If a project must exceed the ceiling, or files must be streamed rather than read whole, that
  milestone reopens the question with the asynchronous call-site cost measured rather than estimated.

## Evidence

| Claim | Test |
|---|---|
| One save rewrites one project, not all | `tests/unit/projects.test.ts` — write counts per key after a rename |
| A removed project's key is deleted, and the index stops naming it | same file |
| Reload restores projects and selection from v2 | same file |
| One corrupt project costs one project, and is reported | same file |
| A project created in another tab appears here, with a notice | same file |
| Another tab's newer version is adopted, with a notice | same file |
| A tab's own values are a no-op, not a notice | same file |
| A project deleted in another tab disappears, but never the last one | same file |
| Project ids stay unique after a deletion | same file |
| Two real tabs converge, and both projects survive | `tests/browser/persistence-limits.spec.ts` |
| A same-project edit in another tab is adopted and reported | same file |
| A v1 workspace migrates in a real browser and still runs | same file |

The pre-fix numbers (including the clobbered `["playground","made in tab B"]`) are kept in `docs/audit/persistence-limits.md`,
because a decision record should show what it was decided against.
