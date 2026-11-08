# R6: deterministic offline dependency installation — architecture proposal

> **Naming.** "R6" here is milestone 6 of Phase 6, not the ruling `P0-6`. See `docs/decisions/NUMBERING.md`.

Status: **proposal only, awaiting owner approval**. No runtime, harness, corpus or fixture file was changed for this
document. Baseline: `4d1b661`, 575 tests, CI run 41871231038 (success). GATE_THRESHOLD 0.9, ADR-0009, ADR-0013,
ADR-0014, ADR-0015 and fixtures 4/7/15 are untouched by it.

## 1. Method

Everything below is labelled **measured** (probe run), **code-inspected** (read) or **proposed**.

Three probes were run and then deleted, as with the R5 investigation:

| Probe | What it did | Result |
|---|---|---|
| A | Installed `{ghost: "^1.0.0"}` against an empty registry | **measured**: a plain `Error`, `code: (none)`, `registry 404 for ghost` |
| B | Installed `alpha@1.2.0 → beta@2.1.0` normally, then reinstalled from the written lockfile with a registry that **throws on every packument** and serves tarballs by URL | **measured**: `alpha@1.2.0, beta@2.1.0`, `usedLockfile: true`, **0 packument calls** |
| C | Built the same minimal package tarball twice and hashed it | **measured**: identical bytes, `sha512-t4yIB3w9J96uas8R2r7kPRLNmeFHdZ9oH4nkIsyHaLnGuTnRC3726tqNJBybtCJ0JNlpXwwYbGPZRVEJtVgIVQ==`, 216 bytes |

Probe B is the load-bearing result: **the installer can already install a complete tree with the registry's resolution
surface switched off entirely**, because the lockfile carries version, tarball URL and integrity per package.

## 2. What exists today (code-inspected)

`src/npm/`, 1,555 lines across four modules:

| Module | Responsibility |
|---|---|
| `install.ts` | Resolution queue, hoisting/nesting, platform filter, integrity, lockfile write, `InstallError` codes |
| `lockfile.ts` | `package-lock.json` v3 **subset** read/write: `version`, `resolved`, `integrity`, `dev`, `optional`, `dependencies` |
| `semver-range.ts` | Range parsing and `maxSatisfying`, verified against npm's own behaviour (ADR-0006 D-14) |
| `tarball.ts` | Hostile-input tar reader: refuses path escapes, refuses symlinks/hardlinks/devices, 32 MB/file and 256 MB/archive caps |

Injection points, which are what make an offline corpus possible without touching the installer:

- `RegistryClient { packument(name), tarball(url) }` — the **only** network-shaped surface, and it is a parameter.
- `VfsWriter { mkdirSync, writeFileSync }` — structural, so the real VFS and a double both fit.
- `Runtime.install()` loads `package-lock.json` from the VFS and passes it in (`in-process.ts:171-188`).

### 2.1 How each thing in scope is represented

| Concern | Representation today | Where |
|---|---|---|
| Package manifest | `PackageManifest`: `name`, `version`, `dependencies`, `devDependencies` only | `install.ts:104` |
| Dependency versions | Packument: `versions` map + `dist-tags`; resolved by `maxSatisfying`; dist-tags honoured by name | `install.ts:202` |
| Package contents | Real gzipped npm tarballs, `package/` prefix stripped, every file written into the VFS | `tarball.ts`, `install.ts` |
| Transitive dependencies | Breadth-first queue; an edge is re-walked per version, not per package (`visited` keyed by `name@version`) | `install.ts:470-560` |
| Nested dependencies | Shallow hoist to the root; a version conflict nests under its dependent (ADR-0006 D-15, duplicate bytes accepted) | `install.ts:535` |
| Entry points | **`main` only**, read by the CommonJS loader at require time; `exports`/`imports` maps are **not implemented** (ADR-0004 D-4) | `commonjs.ts:224` |
| `bin` scripts | Read from `package.json` by the harness, resolved to `node_modules/.bin` | `harness/scripts.ts` |
| ESM in packages | Supported: `.mjs`, `type: "module"`, CJS↔ESM interop, dynamic import, `import.meta.url` (ADR-0012) | `runtime/esm.ts` |
| Integrity | `sha512` only. **Absent = warning, mismatch = fatal** | `install.ts:183-201`, D-16 |
| Platform-specific packages | `os`/`cpu` declarations skipped when reached through an optional edge, fatal otherwise | D-19 |
| Peer dependencies | **Not implemented**; a missing peer installs and fails at require time | ADR-0006 |

## 3. What can be installed deterministically today

**Measured, not predicted** (probe B): a project plus its `package-lock.json` installs its full tree with the packument
surface refusing every call. Tarball bytes must still arrive from somewhere, so "offline" concretely means:

1. **Resolution mode** — packuments are served from a local corpus. Needed when a manifest has loose ranges and no lockfile.
2. **Pinned mode** — packuments are refused outright and tarballs are served by exact URL. Proves the lockfile is doing
   the work rather than the registry, and is the strongest available evidence that nothing silently hits a network.

Both modes are the same `RegistryClient` interface, so nothing in `src/npm/` changes.

## 4. Gaps that shape the design

1. **`npm install <package>` is refused by the harness parser** — `command.ts:177-188` returns `kind: "invalid"` with
   "installing packages that are not in package.json is not supported". Fixture 9's first step is exactly
   `npm install is-odd@3.0.1`, so **fixture 9 cannot pass today no matter what corpus exists.** This is the single most
   consequential fact in this review and needs a decision (§8, D-R6-1).
2. **A missing package is not typed.** Probe A: a plain `Error`, no code. Everything else in the install path has a code
   (`INTEGRITY_MISMATCH`, `NO_MATCHING_VERSION`, `UNSUPPORTED_SPEC`, `PLATFORM_UNSUPPORTED`, `TOO_MANY_PACKAGES`).
   Availability is the registry's business, so the fix belongs in the corpus registry, not the installer.
3. **`exports` maps are unimplemented**, so a corpus package that uses them documents a boundary, not a capability.
4. **The tarball builder lives in `tests/helpers/tarball.ts`.** A committed corpus cannot depend on a test helper; either
   it moves to `tools/` or the corpus ships pre-built bytes.
5. **Corpus bytes must be pinned or the corpus is not reproducible.** Probe C shows the builder is deterministic inside one
   process; that is not the same as across Node/zlib builds (Node ships zlib-ng in some builds and gzip output is not
   guaranteed byte-stable). A hash pinned over generated bytes can therefore fail on a different machine.
6. **Lifecycle scripts (`postinstall`) are deliberately not run** — a security stance, and why some real packages fail.

## 5. Proposed corpus

A small, **explicitly synthetic** corpus. Names are scoped `@corpus/*` so no result can ever be mistaken for evidence
about the real package of a similar name. Versions and integrity are pinned in a manifest.

| Package | Version | Shape it exercises |
|---|---|---|
| `@corpus/leaf` | 1.0.0 | CJS, `main`, no dependencies — the baseline |
| `@corpus/chain` | 1.0.0 | One transitive dependency on `@corpus/leaf` |
| `@corpus/deep` | 1.0.0 | Three levels: `deep → chain → leaf` |
| `@corpus/version-conflict` | 2.0.0 | Depends on `@corpus/leaf@^2` while the root wants `^1`, forcing a nested second copy |
| `@corpus/esm` | 1.0.0 | `type: "module"`, `.mjs` entry, named + default export |
| `@corpus/bin` | 1.0.0 | `bin` map, shebang script — for `npm run`/bin resolution |
| `@corpus/exports-map` | 1.0.0 | Uses `exports` only, no `main` — **documented boundary**, expected to fail to resolve |

Deliberately **not** in the shipped corpus, but available to tests only, in a `@corpus-broken/` namespace that no fixture
may reference:

- `@corpus-broken/corrupt` — bytes that do not match the declared integrity (mismatch is fatal, D-16)
- `@corpus-broken/missing-edge` — depends on a package the corpus does not serve (unavailable transitive dependency)
- `@corpus-broken/tar-hostile` — an archive with a `../` escape (reader already refuses; keeps it that way)

Fixtures must be *forbidden* from naming the broken namespace, enforced by a test over the definitions rather than by
convention.

### 5.1 Storage (decision D-R6-3)

**Recommended:** commit the `.tgz` bytes under `fixtures/registry/<name>/<version>.tgz`, plus
`fixtures/registry/manifest.json` recording name, version, dependencies, entry point, `resolved` URL and `sha512` for each.
Rationale: the bytes become immutable published artifacts, exactly as npm treats them, so integrity pinning is a property
of the file rather than of whichever zlib built it. A `tools/build-corpus.ts` regenerates them; its drift check **reports**
a mismatch instead of failing, because a zlib difference is not corpus drift.

**Alternative rejected:** generating tarballs at load from committed text. Text-diffable and no binaries, but the pinned
hash then depends on the local compressor, so the same commit verifies on one machine and fails on another.

## 6. Reporting model (scope item 6)

Every condition gets a stable code and a fixed classification. Nothing is allowed to *look* like success.

| Condition | Code | Where raised | Fixture consequence |
|---|---|---|---|
| Package the corpus does not serve | `PACKAGE_NOT_FOUND` **(new, typed)** | corpus registry | install step exits 1, stderr names the package and its dependent |
| Transitive edge unavailable | `PACKAGE_NOT_FOUND`, message carries `required by X@1.0.0` | corpus registry via the queue | as above; names the edge, not just the name |
| Range the installer does not resolve (`file:`, git, URL, path) | `UNSUPPORTED_SPEC` | installer (exists) | exits 1, names the spec kind |
| Range nobody satisfies | `NO_MATCHING_VERSION` (+ newest) | installer (exists) | exits 1 |
| Bytes do not match `dist.integrity` | `INTEGRITY_MISMATCH` **(fatal, exists)** | installer | exits 1; never a warning |
| No integrity published | warning string, not a code (exists) | installer | install proceeds, warning recorded in the report |
| Platform package required, not optional | `PLATFORM_UNSUPPORTED` (exists) | installer | exits 1 |
| `code:` needed but not implemented | `exports`-map only package | loader | require-time resolution failure, `RUNTIME_INCOMPATIBILITY` |

The distinction this milestone must not blur: **`PACKAGE_NOT_FOUND` is a corpus gap, `UNSUPPORTED_SPEC` is a by-design
refusal, `INTEGRITY_MISMATCH` is corruption.** Three different words for three different owners of the bug.

## 7. Can the existing implementation carry this? (scope item 7)

**Yes for the mechanism, no for fixture 9's command form.**

Supported already, with no installer change: resolution against a local packument corpus, nested placement, transitive
edges, tarball installation, integrity verification, lockfile write and lockfile-pinned install (measured, probe B), ESM and
CJS packages, `bin` resolution, `npm ci` refusing without a lockfile.

Not supported, and **not** to be faked: `npm install <spec>` (parser refuses), `exports` maps, `peerDependencies`,
lifecycle scripts, `.bin` shims on disk.

No network is introduced by any of this: `RegistryClient` stays the only surface, and the corpus implementation reads
committed bytes.

## 8. Decisions required from the owner

**D-R6-1 — fixture 9's command (blocking).** Its step is `npm install is-odd@3.0.1`, which the parser refuses. Options:
 (a) implement `npm install <spec>` (parser + a manifest write + a resolve of one package) and point fixture 9 at a corpus
 package — **this changes what the fixture proves**, since it then installs a synthetic package, not `is-odd`;
 (b) restage fixture 9 with a `package.json` + `package-lock.json` and no argument, keeping the assertions — the install
 path is still exercised end to end, but the fixture's literal command changes;
 (c) leave fixture 9 as `NETWORK` this milestone and accept that the front-end lane can reach at most 14/15 for now.
My recommendation: **(b)**, with the definition change recorded explicitly, because it keeps the fixture honest about what
it is measuring. (a) can follow later as its own scope. (c) if you would rather no definition changed at all.

**D-R6-2 — corpus naming.** `@corpus/*` scopes (recommended, unmistakeable) versus plain plausible package names.

**D-R6-3 — corpus storage.** Committed `.tgz` + pinned `sha512` (recommended, §5.1) versus generated-from-text at load.

**D-R6-4 — missing-package typing.** Raise `PACKAGE_NOT_FOUND` in the corpus registry only (recommended, keeps the
installer's boundary clean), or wrap registry errors inside the installer so every client benefits.

**D-R6-5 — the `exports`-map package.** Ship it as a documented boundary with an expected require-time failure
(recommended, it is the honest way to record the gap), or omit it so no failure appears anywhere.

**D-R6-6 — broken namespace.** Allow `@corpus-broken/*` for integrity/corruption tests, forbidden to fixtures
(recommended), or keep every corpus package well-formed and test corruption with raw bytes in unit tests only.

**D-R6-7 — `npm install <spec>`.** Whether it enters scope at all this milestone (my recommendation: **no**, separate
scope with its own ADR), or is refused permanently with the existing message kept.

## 9. Risks

1. **Falsifiability risk.** A synthetic corpus proves *our install machinery*, not npm-ecosystem compatibility. Any report
   must say that in the same breath as the pass rate, or the corpus becomes a vanity metric.
2. **Fixture 9 gate risk.** Under D-R6-1(c) the best reachable front-end rate this milestone is 14/15 = 0.933, still above
   0.9 but with no headroom. Under (a)/(b) it stays 15/15.
3. **Determinism risk.** Byte-stable gzip across Node/zlib builds is not guaranteed; mitigated by committing bytes.
4. **Repo weight.** Committed tarballs are binary. Mitigated by a tiny corpus (7 packages, single-digit KB each).
5. **Temptation risk.** The gaps in §4 are where a rushed implementation would "helpfully" fake `npm install <spec>` or an
   `exports` map. Both stay refused with a name.

## 10. Recommended implementation sequence

Each phase is a separate commit, isolation-verified, full `npm run verify` before the next.

1. **R6a — corpus artifacts.** `tools/build-corpus.ts`, `fixtures/registry/*.tgz`, `fixtures/registry/manifest.json`,
   determinism/regeneration check. No runtime change. Tests: builder shapes, pinned hashes, hostile archive refused.
2. **R6b — corpus registry.** `src/registry/corpus.ts`: `packument` and `tarball` over the committed bytes, modes
   `resolution` and `pinned`, typed `PACKAGE_NOT_FOUND`. Tests: both modes, zero-network assertion, missing transitive edge.
3. **R6c — install-path regressions against the corpus.** Nested duplicate placement, transitive chain, ESM package,
   `bin` package, integrity mismatch fatal, `exports`-map boundary, `npm ci` without lockfile refused.
4. **R6d — ADR-0016** recording the corpus contract, and the fixture decision from D-R6-1 implemented only if approved.
   This is also where a staged fixture (if any) is verified end to end with evidence on disk.

## 11. What this proposal does NOT authorize

- No network, no real registry, no `pnpm` implementation, no sockets.
- No fixture staging, including fixture 9.
- No change to the parser's `npm install <spec>` refusal.
- No change to GATE_THRESHOLD, ADR-0009, ADR-0013, ADR-0014, ADR-0015, or fixtures 4, 7 and 15.
- No claim that `npm install` is implemented. It is a resolver, a tarball installer and a lockfile, which is a different
  sentence.
