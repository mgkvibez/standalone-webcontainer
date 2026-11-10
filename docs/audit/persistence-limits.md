# Persistence: what localStorage actually does, measured

**Date:** 2026-11-10. **Instrument:** `tests/browser/persistence-limits.spec.ts` (3 Playwright tests, Chromium, the same build the
browser lane uses). **Scope:** measurement only. No persistence code was changed, and no option was chosen — that is ADR-0017's
decision, listed at the end.

## Why measure before migrating

Persistence is `localStorage`: synchronous, one versioned key (`swc.projects.v1`), the whole project map rewritten on every change.
That is cheap, it works, and it has three properties nobody had measured. Migration to IndexedDB or OPFS is a large change to
synchronous call sites, so it needs a number and a failure mode to justify it, not an instinct that localStorage is "the small one".

## Findings

### 1. The ceiling is about 4.94 M characters in a single key

A probe key was grown in 64 KB chunks until the browser refused:

```
4.94 M chars per key, refused at QuotaExceededError:
  Failed to execute 'setItem' on 'Storage': Setting the value of 'swc.quota-probe' exceeded the quota.
```

Measured, not asserted: the exact ceiling belongs to the browser and its accounting, and a test that pins 4.94 would fail the day
Chromium changes it. What is asserted is that refusal happens and is named.

**What that means for a project:** the stored value is JSON of every project's files. A single 5 MB key is enough for ordinary
tutorial-sized projects and is not enough for a project with a large vendored dependency tree, which is exactly the shape this
runtime makes easy to create by installing packages.

### 2. A save that exceeds the quota fails loudly, and the app survives

With storage filled to the brim (chunk sizes shrinking to 16 bytes, so the slack is smaller than a project), creating a project
shows:

```
#save-state becomes "could not save: ... exceeded the quota" with class="error"
```

and the editor still answers. This is the existing contract in `ProjectStore.persist` — a catch that records `lastError` — and it is
now measured through the UI rather than only read in the source. **Nothing is silently dropped.**

Worth stating plainly, because it is the more dangerous failure: `persist()` swallows the exception, so the in-memory project
continues to exist and behave normally after a failed save. A user can keep working in a project that will not survive a reload,
with only the small error flag to show for it.

### 3. Two tabs silently destroy each other's projects

Two pages in one browser context (sharing localStorage) — **not** `browser.newPage()`, which gives each page its own context and
made my first attempt at this measurement agree with itself by measuring nothing:

```
tab B offered tab A's project: false
names in storage after B saved: ["playground", "made in tab B"]
```

The sequence: both tabs boot and hold the map as it was. Tab A creates a project, which is saved. Tab B's picker never learns about
it, because the store reads storage only at boot and there is **no `storage` event listener anywhere in `src/`**. Tab B then creates
its own project and rewrites the whole map from its stale copy, so A's project is dropped from storage without a warning to either
tab. Tab A still shows the project in its own memory, so from A's side nothing appears to have happened.

This is the last-write-wins consequence of "the whole map is one key", not a bug in any single function.

## Outcome (same day): ADR-0017

The owner chose **one key per project plus a `storage` listener** (ADR-0017). The measurements above are kept as written, because a
decision record should show what it was decided against; this section states what changed and how each finding now reads.

| Finding | After ADR-0017 | Test |
|---|---|---|
| A save rewrote every project | A save rewrites the changed project and the small index only | unit: write counts per key |
| ~4.94 M chars capped the whole workspace | The ceiling is now per project: one large project no longer costs the others | measurement unchanged, blast radius narrowed |
| Two tabs silently deleted each other's projects | A change reaches the other tab, which adopts it and says `changed in another tab`; both projects survive concurrent saves | browser: two tabs converging |
| A failed save leaves memory ahead of storage | Unchanged, and still reported. A project larger than the ceiling still fails loudly | browser: quota fill test |

The browser spec now asserts the fixed behaviour (a project created in one tab appears in the other; a same-project edit is adopted
and announced) instead of printing a loss, and it also migrates a real v1 workspace and runs a program afterwards.

## What a fix has to address

Any of these must handle: per-project granularity (so a save is not a whole-map rewrite), a cross-tab channel, and the fact that
`persist()` is synchronous today while both IndexedDB and OPFS are asynchronous — which changes every call site that currently saves
fire-and-forget.

| Option | Granularity | Cross-tab | Cost |
|---|---|---|---|
| Keep one localStorage key, add `storage` events | whole map | last-write-wins with a conflict notice | small: one listener, merge on event |
| One localStorage key per project | per project | last-write-wins per project, far less lost | moderate: key scheme + migration from v1 |
| IndexedDB | per record | transactional, optimistic with a version check | larger: async call sites, migration, quota is still per origin |
| OPFS + Web Locks | per file | real locking | largest: only justified if files must be streamed, not read whole |

The measurement does not decide between them. It does establish that **the current combination of whole-map rewrites, no cross-tab
signal, and a silent in-memory/durable divergence is the dangerous part**, not the 4.94 M character ceiling: a project that exceeds
the ceiling reports an error, while a second tab loses work with no signal at all.

## Not decided here

Per the charter, an ambiguous design choice stops for the owner. ADR-0017 needs one decision — which row of the table above — and
the recommendation on the evidence is "one key per project plus a `storage` listener" first, because it removes both silent losses
for a fraction of the migration cost, and defers the async rewrite to when someone actually needs files larger than the ceiling.

## Limits of this evidence

- Chromium only. Quota accounting differs in Firefox and Safari, and the browser lane runs one engine.
- The quota probe writes and deletes its own key; it does not measure how much of the ceiling a real project consumes.
- The two-tab test uses one context deliberately; two browsers (e.g. Chrome and Firefox on one profile) cannot share storage at all
  and are out of scope.
