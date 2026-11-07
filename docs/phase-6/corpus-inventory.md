# Phase 6 corpus inventory, fixture 4 root cause, and proposed remediation

Status: **investigation only**. No runtime, harness or fixture definition was changed for this document.
Baseline: `195e63a`, 504 tests passing, CI green. Every figure below is labelled measured, code-inspected or predicted.

## 1. Method

Three probes were run against the real corpus and the real runtime; they are not part of the build and were deleted after
capture.

| Probe | What it did |
|---|---|
| `probe4.ts` | Ran fixture 4 exactly as the corpus test does (unstaged), then again with a synthetic `core.mjs` exercising fs, http, stream, timers and EventEmitter. |
| `probe4b.ts` | Ran one API per script in a fresh VFS, so a missing module could not mask the others. |
| `probe4c.ts` | Parsed and resolved `npx`/`pnpm` command forms to establish how the harness interprets them. |

"Exercised end-to-end" means the definition's own commands ran against a staged project and its own assertions decided the
outcome. Only two fixtures have ever met that bar.

## 2. Headline numbers

- **20 fixtures defined, 2 staged** (fixtures 1 and 7 declare `files`), 18 declare an empty project.
- **2 exercised end-to-end**: fixture 7 (PASS) and fixture 4 (RUNTIME_INCOMPATIBILITY).
- **4 fixtures are blocked by harness command interpretation alone** (`npx` ×3, `pnpm` ×1), before any runtime question.
- **6 builtins implemented**: `fs`, `path`, `process`, `buffer`, `events`, `http`.
- **Fixture 4 has two independent defects**, and the definition one hides the runtime one.

## 3. Corpus inventory

Assertion counts are `passed/failed/not-evaluated`. "Not run" means no assertion was evaluated because the fixture has
never been staged and executed.

| # | Name (short) | Expected | Actual (measured) | Exercised | Assertions | Primary gap | Owner |
|---|---|---|---|---|---|---|---|
| 1 | Vite dev server boots | PASS | NOT RUN | no | not run | real registry install; `fs.watch`; WebSocket; esbuild native binary | runtime + external |
| 2 | React Router deep links | PASS | NOT RUN | no | not run | same as 1, plus `react-router-dom` install | runtime + external |
| 3 | shadcn CLI writes component | PASS | NOT RUN | no | not run | **`npx` not interpreted**; registry install; network | harness first |
| 4 | Node core: fs/http/streams/timers/events | PASS | RUNTIME_INCOMPATIBILITY | **yes** | 0/6/0 | `stream` builtin absent; timer liveness >1 tick; no project files | **definition + runtime** |
| 5 | Next.js build and start | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | `swc` native binary; webpack; `child_process`; streams | runtime + external |
| 6 | Nuxt SSR build and start | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | `net`/`tls`; streams; `child_process` | runtime |
| 7 | CLI honours argv and exit codes | PASS | **PASS** | **yes** | 3/0/0 | none: this is the working reference | — |
| 8 | Express static server | PASS | NOT RUN | no | not run | registry install of express; http/fs present | external + harness |
| 9 | is-odd install then require | PASS, NETWORK | NOT RUN | no | not run | registry fetch (network); `require` resolution present | external |
| 10 | pnpm install path | PASS, NETWORK | NOT RUN | no | not run | **`pnpm` not interpreted**; no pnpm lane exists | harness + decision |
| 11 | Vite production build | PASS, TIMEOUT | NOT RUN | no | not run | esbuild native binary; `dist` write (fs present) | runtime + external |
| 12 | TypeScript compile | PASS | NOT RUN | no | not run | **`npx` not interpreted**; typescript install | harness first |
| 13 | Edit then HMR updates | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | `fs.watch` absent; WebSocket absent; timers | runtime |
| 14 | Spawn `node_modules/.bin` binary | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | **`npx` not interpreted**; bin resolver present but nothing installed | harness first |
| 15 | Native addon refused on purpose | UNSUPPORTED_BY_DESIGN | NOT RUN | no | not run | refusal path **implemented and unit-verified**; blocked by staging (ADR-0009 D-3) | definition + decision |
| 16 | In-process sockets and websockets | PASS, RUNTIME_INCOMPATIBILITY, TIMEOUT | NOT RUN | no | not run | `net`/`tls`/`dgram` absent entirely | runtime (boundary lane) |
| 17 | Large build at memory ceiling | PASS, TIMEOUT, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | build toolchain absent; no memory instrumentation | runtime + external |
| 18 | Generated-component production build | PASS, TIMEOUT | NOT RUN | no | not run | same build path as 11 | runtime + external |
| 19 | LibSQL through in-process WASM | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | no WASM module loading; binary fs read; possibly network | runtime |
| 20 | Drizzle schema and migration | PASS, RUNTIME_INCOMPATIBILITY | NOT RUN | no | not run | native sqlite driver (refusal path) or libsql (WASM) | runtime + external |

### Evidence per fixture

- 1, 2, 11, 13, 18 depend on a Vite/esbuild path. Evidence for the native dependency: ADR-0001 and the runtime's own
  refusal text at `src/runtime/commonjs.ts:219`. Predicted, not measured, because staging is absent.
- 3, 12, 14: measured. `parseStepCommand("npx tsc -p tsconfig.json")` returns `{"kind":"exec","bin":"npx"}` and
  `resolveBin("npx")` returns `null`, so the step becomes `npm error command not found: npx` with exit 1. The same holds
  for `pnpm` in fixture 10. These four are harness bugs, not runtime limits.
- 5, 6, 17: code-inspected. `child_process`, `net`, `tls`, `dgram`, `worker_threads` are absent from the builtin table at
  `src/runtime/in-process.ts:213-235`.
- 15: the refusal is implemented and covered by 20 regression tests (`harness.refusal-contract.test.ts`). What blocks it
  is that the definition ships no `sharp` install target and no `require-native.mjs`.
- 19, 20: `WebAssembly` exists in the host, but nothing in the runtime can fetch, read and instantiate a `.wasm` payload
  from the VFS, and there is no `net` for anything client-server.

## 4. Runtime capability matrix (measured by probe4b)

| Capability | Status | Evidence |
|---|---|---|
| `fs` (read/write/stat) | works | `fs-ok`, exit 0 |
| `path` | works | used by every fixture that passed |
| `process` (argv, env, stdout) | works | fixture 7 reads argv, exits with the documented code |
| `buffer` | works | passed through from host |
| `events` / EventEmitter | works | `events-ok`, exit 0 |
| `http` server + gateway routing | works | `http-ok`, exit 0 |
| timers, 0 ms | works | `timer-ok` via the ADR-0013 macrotask drain |
| **timers, >1 tick** | **fails silently** | `setTimeout(...,5)` printed nothing, exit 0 |
| **`stream` (node:, bare, require)** | **absent** | `ModuleNotFoundError: Cannot find module` in all three forms |
| `net`, `tls`, `dgram` | absent | not in the builtin table |
| `child_process`, `worker_threads` | absent | not in the builtin table |
| `util`, `os`, `url`, `crypto`, `assert`, `zlib` | absent | not in the builtin table |
| native addons | refused by design | typed refusal, 20 tests |
| WASM module loading | absent | no loader |

## 5. Fixture 4 root cause

### Defect A, definition: the fixture ships no project

Measured on the definition as committed:

```
step 0 npm install  exit=1  stderr: MISSING_PACKAGE_JSON: no package.json at /app/package.json
step 1 node core.mjs exit=1  stderr: Error: ENOENT: open '/app/core.mjs'
```

`files` is absent from `fixture-04.json`, so `materializeProject` stages nothing. The fixture cannot pass, and cannot even
be judged, because the program its assertions describe does not exist. This is a **fixture definition** defect. Fixing it
is a definition change, and per ADR-0009 D-3 definition content is the owner's call, not the implementer's.

### Defect B, runtime: `stream` is missing, and the timer drain is one tick deep

With a synthetic `package.json` and `core.mjs` staged, the run fails at the first line that touches an unimplemented
builtin, and because it is a static ESM import nothing else in the module executes:

```
step 1 node core.mjs exit=1
stderr: ModuleNotFoundError: Cannot find module 'node:stream' from '/app'
```

All six assertions then observe one empty stdout, which is why the failure reads as "and 5 more" rather than naming an
API. Two consequences:

1. `stream` is the load-bearing absence. fs, http, events and 0 ms timers all work in isolation (probe4b), so a staged
   fixture 4 would pass four of its five markers today and fail on `stream-ok`.
2. The fixture's own `knownLimits` says "absence of later markers means execution stopped, which is a liveness finding."
   That is exactly what happened, and it is a correct reading: one missing import stopped everything.

A second runtime limit is confirmed but would only appear after `stream` exists: `setTimeout(..., 5)` never ran. The
ADR-0013 drain awaits one macrotask boundary, which catches `setTimeout(...,0)` and nothing longer. A fixture that waits
5 ms for a timer callback would fail with an empty stdout and no error, which is the worst shape a failure can take.

### Why both must be fixed, in order

Defect A alone makes the fixture unjudgeable. Defect B alone makes it fail for a reason that is not in its own
description. Fixing A without B produces a fixture that fails on `stream`, and fixing B without A produces a fixture that
still cannot run. They are independent, and each needs a different owner's approval.

## 6. Proposed remediation, in order

Nothing here is started. Items are ordered so each one unlocks the most fixtures per unit of risk.

| # | Change | Type | Unlocks | Needs |
|---|---|---|---|---|
| R1 | Interpret `npx` in `parseStepCommand`: `--no-install`/bare resolves an installed bin; `pkg@version` is an install ref and must be refused explicitly rather than reported as "command not found" | harness | 3, 12, 14 partially; makes 15 expressible | none |
| R2 | Interpret `pnpm install`: either map to the same installer as npm, or refuse with a named unsupported reason | harness | 10 runnable | decision: pnpm lane or explicit refusal |
| R3 | Add a `stream` shim: `Readable`, `Writable`, `PassThrough`, `pipeline`, async iteration | runtime | 4, 5, 6, 8 partially | none, but it is a new subsystem and should be an ADR |
| R4 | Deepen liveness: own timer queue so work scheduled beyond one tick is drained, with a bounded deadline | runtime | 4, 13, 16, 17 | ADR-0013 amendment |
| R5 | Stage fixtures 1, 2, 4, 15 (project files, their real entry scripts) | definition | 1, 2, 4, 15 | **owner approval (ADR-0009 D-3)** |
| R6 | Registry install path proven against real packages, not the fake registry | harness + external | 8, 9, 11, 12, 14 | network decision |
| R7 | `net`/`tls` sockets | runtime | 16 | boundary-lane decision |

Explicitly **not** proposed: changing `GATE_THRESHOLD`, touching fixtures 7 or 15, weakening any assertion, or flipping
fixture 4's pinned expectation in `fixtures.run.test.ts` before its own program exists.

## 7. Compatibility matrix: now and if the plan lands

| Class | Fixtures | Now | After R1-R2 (harness only) | After R1-R4 | After all |
|---|---|---|---|---|---|
| Runnable and passing | 7 | 1 | 1 | 1-2 | 3-4 |
| Runnable and honestly failing | 4 | 1 | 1 | 1 | 0 |
| Blocked by harness interpretation | 3, 10, 12, 14 | 4 | 0 | 0 | 0 |
| Blocked by missing project files | 18 of 20 | 18 | 18 | 18 | 0 |
| Blocked by runtime capability | 5, 6, 13, 16, 17, 19, 20 | 7 | 7 | 5 | 2-3 |

The gate rate is unchanged by all of this: zero fixtures are frozen, so no rate exists to move.

## 8. Decisions needed from the owner

1. **Fixture 4 content (R5)**: may I stage `package.json` and `core.mjs` for fixture 4, written to its own assertions?
2. **pnpm (R2)**: support it as an alias of the npm installer, or refuse it with a named reason?
3. **`stream` scope (R3)**: minimal `Readable` only, or the four-class subset above?
4. **Liveness depth (R4)**: how long may a run wait for scheduled work before it is a TIMEOUT?
5. **Registry network (R6)**: is a real registry fetch part of the audit, or does the corpus stay offline-fixtured?
