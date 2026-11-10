# Where the Vite path stops, measured

Everything below came from running `fixture-01`'s own install and start commands against the frozen snapshot
(`fixtures/snapshots/vite`, 68 packages, no network at run time) and reading each failure.

## The boundary

`npm run dev` reaches vue's CLI, boots `bin/vite.js`, resolves `dist/node/cli.js`, loads
`dist/node/chunks/dep-BK3b2jBa.js`, and stops there on a require of `child_process` from **esbuild**:

```
esbuild 0.21.5, lib/main.js:1784   var child_process = require("child_process");
```

That line is at **module scope** (it is the head of the bundled `lib/npm/node.ts`), so it runs while esbuild's JS API is being
loaded, not when a transform is attempted. Vite imports esbuild eagerly from its node entry, so no `vite` command can start.

Spawning a native binary is not a capability this runtime has, and it is not one a browser can acquire. Two honest routes exist and
**both are decisions, not refactors**:

1. Add a refusal code for native process spawn, so a fixture making this request scores `UNSUPPORTED_BY_DESIGN` with evidence.
   `RefusalCode` is a closed set whose own documentation calls adding a member a design act.
2. Substitute esbuild's WASM build (`esbuild-wasm`, a different package with a different loader contract) in the install path.

Until one is chosen, `fixture-01` is a genuine red and is reported as one. Nothing in this document claims otherwise.

## What the same run proved, and what it cost to find

Nine defects, each found by real bytes and each fixed with a test that names the package that produced it
(`tests/unit/real-bytes-regressions.test.ts`, `tests/unit/loader-bindings.test.ts`):

| # | Failure as observed | Cause | Fix |
|---|---------------------|-------|-----|
| 1 | `Cannot access 'require' before initialization` | prologue used a name the module binds (`const require = createRequire(import.meta.url)`) | prologue targets a mangled name |
| 2 | same, for `__require` | the chunk declares `const __require = require` at line 56 | mangling escalates past any name the source uses |
| 3 | `Identifier 'performance' has already been declared` | an import local is a lexical binding; the text scan missed it | transform reports its own lexical bindings |
| 4 | binding dropped from a whole module | scan matched `const exports = []` inside two ordinary functions | scan is brace-depth aware |
| 5 | `Object.defineProperty called on non-object` | the module's own top-level `var exports` replaced our exports object | writes target `__esmExports` |
| 6 | `Cannot find module 'node:perf_hooks'` | absent shim | shim, surface from the call sites |
| 7 | `os` calls in the resolved path | absent shim | shim, surface from the call sites |
| 8 | `Cannot find module 'node:fs/promises'` | the promises object existed, the module entry did not | one object served both ways, plus `stat`/`lstat`/`realpath`/`access`/`rm` |
| 9 | `Cannot find module 'node:module'` | absent shim | `createRequire` bound to the calling file's directory, `builtinModules` and `isBuiltin` answered from this runtime's own table |

Top-level await was the previous slice's target and is no longer a blocker for this graph: one file in vite's whole dist needs it, and
it is the program entry.

## What was decided, and what it cost

The owner's ruling: take the WASM route, but **do not** use it to save `fixture-01`, and add the refusal anyway as a separate
capability. `fixture-01` therefore stays a genuine red until Vite boots. A refusal code that flips it to `UNSUPPORTED_BY_DESIGN`
would be honest bookkeeping that hides the most important failure.

So the two pieces are separate, and neither one rescues the fixture:

**Substitutions are a table, not a patch.** `src/npm/substitutions.ts` holds rows of requested package, substitute, version rule, init
hook and reason; `parseSubstitutions` refuses the ways a table rots (a self-substitution, a chain whose outcome would depend on
iteration order, a pin on a rule that ignores it, a row with no reason). The resolver fetches only the substitute's packument and
installs its bytes **under the requested name**, because Node resolves by directory and a caller writing `require('esbuild')` must find
them there. Every application is recorded in `InstallReport.substitutions` with its reason, and warned about in the install log.
Entry one, measured: `esbuild-wasm@0.21.5`, zero dependencies, `lib/main.js`, 12.2 MB unpacked, published on the same version line as
native `esbuild`, so the caller's own range (`^0.21.3`) resolves inside the substitute's versions.

**`NATIVE_PROCESS_EXEC_REFUSED` is a capability, not a fixture answer.** A module that requires `child_process` now gets a typed
refusal naming the owning package and the frame, instead of `Cannot find module 'child_process'`, which reads as a defect in this
loader. It is catchable, so a program may handle it and continue. It is not wired to `fixture-01`: that fixture's expected set is
untouched, and the substitution is what stands between Vite and this refusal.

**Consequence for the offline lane:** the Vite snapshot was captured with native `esbuild`, so an install from that snapshot cannot
satisfy the substitution. The snapshot needs recapturing through the substitution table before the hermetic lane can speak about Vite
again; until then `fixture-01` is a network-lane fixture.

## The init hook, measured (one transform, in isolation first)

Before touching the runtime, the same transform was run in plain Node against the extracted package: load `lib/browser.js`, provide `self`,
`initialize({ wasmModule, worker: false })`, then `transform()`. It works, and gives the numbers this design has to fit in:

| step | plain Node |
|---|---|
| load `lib/browser.js` | 2 ms |
| `initialize` (incl. `new WebAssembly.Module` over 11.1 MB) | 67 ms |
| first `transform` (TypeScript) | 233 ms |
| second `transform` (JSX) | immediate |

Three things made it work, and each was a separate defect in the runtime:

1. **The entry.** `esbuild-wasm`'s `main` is still the native-service build that spawns a binary; only its `browser` entry is the WebAssembly
   compiler. Our resolver now prefers `browser` over `main` (string form only), because this runtime is the browser a dependency was written
   for. Node ignores that field for the opposite reason.
2. **The startup.** `esbuild-wasm` must be handed its own `.wasm` through `initialize()`, and **it refuses to be used until that promise
   resolves**: `You need to wait for the promise returned from "initialize" to be resolved before calling this`. Its callers never call
   `initialize()` at all. So the hook returns a **lazy proxy**: every callable export awaits readiness on first call, which is the ordering
   problem the briefing named, demonstrated rather than assumed.
3. **The globals.** The in-thread service assembles its own scope by enumerating `self`, so the runtime now injects `self`, `WebAssembly`,
   `TextEncoder`, `TextDecoder` and `crypto`. Without `self` it dies with `self is not defined` before the first transform.

## Where it stops now

The Go runtime boots and reaches its own I/O, then panics:

```
panic: syscall/js: call of Value.Invoke on undefined
  syscall.Write(0x1, ...) → syscall/fs_js.go:419 → main.runService
```

The service writes its protocol to **fd 1**, and the wasm host has no `fs` bridge to write through. That bridge is ours to provide and it is
ours by nature: fd 1 is the process's stdout, which this runtime already owns. The next step is therefore narrow and well-defined: give the
wasm host `fs.writeSync`/`fs.write` bound to the running program's stdout and stderr, then re-run the same measurement.

`docs` note: `fixture-01` is untouched and still red. Nothing here classifies it.
