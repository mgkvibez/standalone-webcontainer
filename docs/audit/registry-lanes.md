# The three registry lanes, and what each one is allowed to decide

**Decided by the owner on 2026-11-10**, and implemented in this order because the first lane made the third possible.

| Lane | What it serves | What it may decide |
|---|---|---|
| **network** (`--registry=network`) | `registry.npmjs.org`, live | the product verdict: does this runtime run the package as published today |
| **snapshot** (`--registry=snapshot:<dir>`) | real `.tgz` bytes frozen on disk, pinned by sha512 | the gate's compatibility verdict: the same, minus the registry's mood |
| **corpus** (default) | 10 synthetic `@corpus/*` packages | unit tests only. Never a compatibility verdict, because a synthetic `vite` proves nothing about `vite` |

## Why the snapshot lane is not a mirror

A snapshot holds **the exact resolutions one install produced**, captured by driving the real installer rather than by a
hand-written dependency walk (`tools/npm/build-snapshot.ts`). That choice is what keeps the frozen lane honest: whatever the product
lane resolves is what the snapshot records, so the two cannot drift apart in what they mean.

It is deliberately narrow. Asking for a package it does not hold is `SNAPSHOT_MISSING`, never a fallback to the network, because a
fallback would make "hermetic" a claim nobody can check. `latest` resolves to the newest version **inside the snapshot**, so a
verdict cannot change because a publisher shipped this morning.

## Measured today

- `npm run snapshot:build -- --slug express --out fixtures/snapshots/express express` captured **68 packages, 731 KB of tarballs,
  express 5.3.0**, in 2.5 s against the real registry.
- `npm run fixtures:run -- --id 8 --registry=snapshot:fixtures/snapshots/express` → **fixture-08 PASS, 3/3**, express serving a body
  on port 3200 through the preview gateway, with no network access at run time.
- The install path is proven not to reach the network by a test that replaces `globalThis.fetch` with a function that throws and then
  installs a two-package tree from a snapshot: the tree resolves, the files land, and `fetch` is never called.

## Integrity is checked twice, on purpose

At capture time the installer verifies each tarball against `dist.integrity` before the bytes enter the VFS. At **serve** time the
snapshot client recomputes sha512 over the committed file and compares it with the manifest, so a corrupted checkout fails as
`SNAPSHOT_INTEGRITY` instead of installing wrong bytes. A test tampers with one byte and asserts the refusal.

## What this does not solve

- **A new package needs a new capture.** That is the point of freezing, but it means adding a fixture that uses `ws` requires
  `snapshot:build` and a reviewable diff of pinned bytes, not a version bump.
- **The snapshot is not deduplicated across snapshots.** Two snapshots that share a dependency hold two copies. With one snapshot at
  731 KB that is not worth solving.
- **Republishing a version upstream does not touch a snapshot**, which is the property we want, but it also means a snapshot cannot
  detect that the publisher broke a version in place. The version and integrity are what we pinned.
