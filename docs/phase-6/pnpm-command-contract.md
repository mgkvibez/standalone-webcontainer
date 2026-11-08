# R2: pnpm command contract, for review

> **Naming.** "R2" here is milestone 2 of Phase 6, not the ruling `P0-2`. See `docs/decisions/NUMBERING.md`.

Status: **contract approved with amendments** (owner decisions below). Implementation not started. No pnpm support is implemented, `fixture-10.json` is untouched, and nothing here changes a
classification. Baseline `ec9b6ea`, 511 tests.

## 1. Why this cannot be an alias

An alias would make `pnpm install supply one npm-shaped install and claim it was pnpm`. Three concrete differences make
that a false claim rather than a shortcut:

| Dimension | npm (what our installer does today) | pnpm | Consequence if aliased |
|---|---|---|---|
| Lockfile | `package-lock.json`, v3 subset, read and written | `pnpm-lock.yaml`, different schema, YAML | We would silently ignore a pnpm lockfile, or emit none, while reporting success |
| `node_modules` layout | hoisted flat tree | isolated store at `node_modules/.pnpm` with symlinked entries | Ghost dependencies resolve for us and would not for real pnpm |
| Script environment | `npm_*` variables | `npm_*` plus pnpm's own | A script branching on the manager sees npm |

The layout difference is the serious one. pnpm's isolation is a correctness property, not a storage optimisation: a
package cannot `require` something it never declared. Aliasing gives us a runtime that is more permissive than pnpm,
which is the direction that makes fixtures pass for the wrong reason.

## 2. Proposed compatibility profile: `pnpm-resolution`

A deliberately small profile. It gives pnpm's **command vocabulary** for the operations a fixture actually performs, and
refuses everything whose meaning depends on pnpm's own storage engine.

### 2.1 Supported

| Command | Semantics | Notes |
|---|---|---|
| `pnpm install` | install `dependencies` + `devDependencies` from `package.json` using the existing installer | no lockfile read, no lockfile written |
| `pnpm install --prod` / `--production` | same, `devDependencies` omitted | same flag meanings the npm path already has |
| `pnpm install --frozen-lockfile` | **see 2.2, refused** | cannot verify a lockfile we cannot parse |
| `pnpm i` | alias of `pnpm install` | |
| `pnpm run <script> [-- args]` | run a `package.json` script through the existing script runner | identical to `npm run`, including the `--` forwarding rule |
| `pnpm run` (no name) | list scripts and exit 0, as pnpm does | |
| `pnpm test` | `pnpm run test` | |
| `pnpm <bin>` where `<bin>` is installed | same resolution as the bare-binary path | pnpm also runs local bins |

### 2.2 Refused, by name, with the message shown

Every refusal states the rule, not just "unsupported", so a fixture author can act on it.

| Command | Refusal message |
|---|---|
| `pnpm install <pkg>` / `pnpm add <pkg>` | `pnpm add <pkg>: adding dependencies is not supported; declare it in package.json` |
| `pnpm remove` / `pnpm uninstall` | `pnpm remove: removing dependencies is not supported` |
| `pnpm update` / `pnpm up` | `pnpm update: only an exact install from package.json is supported` |
| `pnpm install --frozen-lockfile` / `--lockfile-only` | `pnpm --frozen-lockfile: pnpm-lock.yaml is not parsed by this harness, so the lockfile cannot be verified` |
| `pnpm dlx <pkg>` | `pnpm dlx: fetching a package from the registry is not supported` |
| `pnpm store`, `pnpm link`, `pnpm publish`, `pnpm patch`, `pnpm workspace*` | `pnpm <sub>: not interpreted by this harness` |
| any flag not listed in 2.1 | `pnpm <flag>: not interpreted by this harness` |

### 2.3 Mandatory disclosure

A supported `pnpm` command must not report as if pnpm's storage engine ran. The step detail carries a fixed deviation
record, and it is written into evidence:

```
pnpm-resolution profile: package.json install, npm-style hoisted node_modules, no pnpm-lock.yaml read or written
```

That string is part of the contract, not a log line: it is the difference between "passed under a declared profile" and
"passed while pretending".

## 3. What this means for fixture 10

Fixture 10 is `pnpm install` then `node check.mjs`, expected `PASS, NETWORK`, and its intent is "the pnpm install path".
Under this profile it would run and would assert on a tree this harness built with npm semantics. Two honest readings:

- **Reading A**: fixture 10 measures *pnpm command support*, and the declaration in 2.3 makes the deviation explicit. It
  scores.
- **Reading B**: fixture 10 measures *pnpm's install semantics* (isolated store, yaml lockfile). Under any profile short of
  a real store it cannot pass honestly, so it should stay unscored until that engine exists.

I am not choosing between these. It changes what the fixture's name means and therefore what the gate rate means, which is
the owner's call under the charter.

## 4. Decisions requested before implementation

1. **Reading A or B for fixture 10** (section 3). This decides whether the fixture is scoreable under this profile.
2. **`pnpm run` scope**: is the script-runner mapping enough for this milestone, or is pnpm's script environment
   (`npm_lifecycle_event` and friends) expected too? We do not provide those variables today, and inventing them wrongly
   is worse than omitting them (ADR-0010 audit question 3).
3. **Store, ever?** If a later milestone wants `node_modules/.pnpm` with symlinks, the installer needs a second tree shape.
   Worth knowing now, because it changes whether the installer grows a layout abstraction or stays flat.
4. **Refusal vocabulary**: are the messages in 2.2 the wording you want fixtures and humans to see?

## 4a. Owner decisions recorded (Nov 4 2026)

### D-1. Fixture 10 measures real pnpm semantics, so it stays unscored

**Decided:** the `pnpm-resolution` profile must not score fixture 10, and no `pnpm` command may be counted toward the gate
through it. Reading B from section 3 is adopted: fixture 10 measures pnpm's installation semantics (isolated store, yaml
lockfile), which this harness does not have.

Consequence, recorded so it cannot drift: the profile is a **command-vocabulary** facility, tested by its own unit tests,
not a scoring path. If a future milestone implements the store, that milestone decides fixture 10's fate explicitly.

### D-2. `pnpm run` must carry a documented lifecycle environment

**Decided:** provide this subset, and only this subset:

| Variable | Value |
|---|---|
| `npm_lifecycle_event` | the script name that is running |
| `npm_package_name` | `name` from the project's `package.json` |
| `npm_package_version` | `version` from the project's `package.json` |
| `INIT_CWD` | the directory the command was invoked from (the project root) |
| `PATH` | the existing path plus `node_modules/.bin` entries, nearest first |
| `npm_config_user_agent` | a stated, stable string identifying this harness, never a fake npm version |
| executable-path variables | `npm_execpath` pointing at the resolved script runner, `npm_node_execpath` pointing at the runtime entry |

Variables npm sets that are not in this table are **absent rather than invented**. A script reading `npm_package_json`
sees nothing, and that is the documented behaviour.

### D-3. Flat `node_modules` is final for this milestone

**Decided:** no `.pnpm` store, not even partial. The installer keeps one layout, and the profile never claims otherwise.

### D-4. Refusal wording approved, with a four-part shape

**Decided:** every refusal names (a) the operation, (b) the reason, (c) that the limitation is intentional, and (d) the
supported alternative where one exists. This revises the messages in 2.2, which named the operation and the reason but not
the intentionality:

| Command | Refusal message |
|---|---|
| `pnpm add <pkg>` / `pnpm install <pkg>` | `pnpm add <pkg>: intentionally not supported: dependency installation is limited to package.json, so a new package cannot be added at run time (instead: declare it in package.json) ` |
| `pnpm remove` | `pnpm remove: intentionally not supported: the installer only materialises package.json (instead: remove the entry and reinstall) ` |
| `pnpm update` | `pnpm update: intentionally not supported: installs are exact, so there is no range to advance (instead: change the version in package.json) ` |
| `pnpm install --frozen-lockfile` | `pnpm --frozen-lockfile: intentionally not supported: pnpm-lock.yaml is not parsed, so it cannot be verified (instead: use package-lock.json, which is verified) ` |
| `pnpm dlx <pkg>` | `pnpm dlx: intentionally not supported: registry fetches are disabled by policy (instead: declare the package and install it) ` |
| `pnpm store` / `link` / `publish` / `patch` / `workspace*` | `pnpm <sub>: intentionally not supported: outside this profile (instead: the four supported forms are install, i, run, and an installed binary) ` |

## 5. Implementation sketch, if approved

Bounded to the command layer plus a deviation record, with no runtime change:

- `parsePnpm(rest)` in `src/harness/command.ts`, returning `install` (with `omitDev`), `run-script`, `exec`, or
  `invalid` with a 2.2 message.
- `PackageManager: "npm" | "pnpm"` on the install plan, so `runInstall` and the step detail can attach the 2.3 deviation
  without touching the installer itself.
- Tests: one per supported form, one per refused form, and one asserting the deviation string appears exactly when the
  command was pnpm.
- No change to `fixture-10.json`, no change to any expectation, and nothing scored differently until section 3 is decided.

Estimated blast radius: one source file, one detail string, one test file, one ADR amendment. The installer and runtime are
untouched.
