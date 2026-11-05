# P1c: offline dependency installs

Status: implemented on `feat/p1c-offline-npm`.

## User-visible behavior

The terminal accepts `npm install`, `npm i`, and `npm ci`, with `--omit=dev` / `--production`. Package arguments and
other flags are refused. Resolution and tarball reads go through the committed corpus only; the normal installable
namespace is `@corpus/*`. The reserved `.invalid` tarball origin is never fetched. Corpus identity and archive integrity
are verified at app startup before the registry is exposed to the terminal.

The installer stages writes in memory. On success, `package-lock.json` is written to the project store and package files
replace the in-memory dependency overlay. `node_modules` are not persisted to `localStorage`. After reload, `npm ci`
recreates them from the saved lockfile and bundled tarballs. Switching projects discards the previous project's overlay.
Failed installs do not publish their staged package tree.

## Boundaries

- This is offline corpus install support, not access to the public npm registry. A package absent from the corpus fails
  with the registry's named refusal.
- The package manager's existing resolution, lockfile and integrity behavior is reused; the terminal is only an adapter.
- The shell remains a finite command interpreter. `npx`, package-name arguments, arbitrary flags, registry URLs and
  shell operators remain unsupported.
- Dev servers, preview ports and service-worker routing remain outside this slice.

## Verification

Unit integration verifies the lockfile is saved, package files are absent from project storage, and a subsequent runtime
snapshot sees the overlay. A Chromium test installs `@corpus/leaf`, requires it, reloads, runs `npm ci`, and requires it
again. Windows `npm run verify` retains four known host/baseline failures (corpus tarball byte drift, two stale hash
guards, and POSIX path expectations); they are unrelated to this implementation. The base CI run on Linux passed before
this change.
