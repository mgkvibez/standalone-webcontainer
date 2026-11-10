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

## The global object, measured twice

The first run inside the runtime did not fail in esbuild, it failed in the **scope** the Go runtime was given:

```
panic: syscall/js: call of Value.Invoke on undefined
  syscall/js.Value.New -> syscall.Write(0x1, ...) -> main.runService
```

`Value.New` is the JS `Object` constructor reached through the Go runtime's global. The in-thread service assembles that global by copying
`self`'s properties into a fresh object, so a `self` carrying eight timers yields a world with no `Object` in it. Reproduced exactly, outside
our code, in plain Node:

| `self` given to `esbuild-wasm` | result |
|---|---|
| the eight-global object our runtime was lending | `panic: syscall/js: call of Value.Invoke on undefined` |
| the realm's real global object | `let x = 1;` |

So the runtime now lends a described realm surface (`src/runtime/realm-globals.ts`): `Object`, `Function`, `Array`, the error constructors, the
binary-data types, `Math`, `JSON`, `Reflect`, `Promise`, `Map`/`Set`, `URL`, `atob`/`btoa`, `structuredClone`, `queueMicrotask`, and the web
primitives already relied on. `self` is that surface merged with what the runtime owns, which is what a browser's global object is. The list is
curated on purpose: what is here is what a program may see, and Node-only globals stay absent.

## Where it stops now

With the realm surface in place the panic is gone and the service boots, but `initialize()`'s promise **never settles**: the run ends at ~100 ms
with exit 0, no stdout and no stderr. Measured against the obvious explanation by appending a chain of 60 timers to the program: identical
result, so it is not the loop emptying while work is pending, it is the Go service's readiness signal never arriving through our scheduler.

That is our defect, not esbuild's: the service drives itself with `setTimeout` and microtask turns, and the virtual clock collapses that
interleaving. Next step is a differential case for it (`npm run diff:event-loop`) rather than a patch: the same program run in real Node against
the same package gives a transform in 233 ms, so Node is available as the judge.

## The interleaving, decided by Node, and the first transform

`initialize()` never settling was not esbuild's fault either. Asked as a differential case before any patch
(`chained-then-from-timer`, `npm run diff:event-loop`):

| | Node | this runtime |
|---|---|---|
| `setTimeout(() => Promise.resolve().then(..).then(..).then(..))` | `one,two,three` | `one` |

The runtime drained continuations with a fixed **two** microtask hops, which is a guess at the depth of a chain. A `.then` whose callback returns
another `.then` keeps queueing continuations, so the chain is truncated wherever the hop count runs out. Node's rule is not "a couple of hops",
it is "the microtask queue is drained to exhaustion before the next macrotask runs", and only a **macrotask boundary** expresses that. The drain
now crosses one, via `MessageChannel` where it exists (a Worker clamps timers, and this runs on every pass) and a 0 ms timer otherwise.

That single line of semantics was the whole remaining gap. With it:

```
$ npx tsx tools/measure-esbuild-wasm.ts
install: 1 package(s) in 357 ms | esbuild -> esbuild-wasm@0.21.5 (initHook esbuild-wasm:initialize)
esbuild.wasm in the VFS: 11.1 MB
run: 170 ms | exit 0
CODE:let x = 1;
const f = (a) => `${a}`;
```

One TypeScript transform, in the container, through the real installer: the substitution, the browser entry, the hook with its lazy proxy, the realm
global object, and the event loop all holding at once. Differential suite 16/16 against real Node; 1102 tests green.

Next, per the agreed sequence: the dependency optimizer, where Vite passes esbuild plugins and the service model differs most (native esbuild runs a
process, the WASM build runs in-thread). `fixture-01` is still untouched and still red.

## The plugin round trip

The dependency optimizer passes esbuild **plugins**, and a plugin is a round trip from the compiler back into JavaScript mid-build. Native
esbuild makes that trip through a service process; the WASM build makes it inside the caller. That is the one place where the substitution itself,
rather than the runtime, could change behaviour, so it was measured on both sides before anything touches Vite.

| where | call | time |
|---|---|---|
| plain Node, `browser` entry, `worker:false` | `build()` with `onResolve` + `onLoad` | 215 ms |
| this runtime, same program | same | 181 ms |

Both produce the same bundle, including the virtual namespace comment:

```
// virt:virtual:dep
var virtual_dep_default = "from-plugin";

// app/entry.js
console.log(virtual_dep_default);
```

`npx tsx tools/measure-esbuild-wasm.ts --plugin` is that measurement. Two callbacks, both returning values through the in-thread service, on our
scheduler: the plugin model survives the substitution.

**What this does not prove**, and the next thing to measure: this build's plugin returns contents from memory and touches no files. Vite's
dependency optimizer plugins **read package files**, which is exactly the `fs` bridge the Go host does not have yet (`syscall.Write` on fd 1 was
the first symptom). So the order is: the `fs`/fd bridge into the wasm host first, then `optimizeDeps`, then the dev server. Building `optimizeDeps`
before the bridge would measure a boundary we already know about rather than the dep optimizer.

## Where esbuild-wasm runs, and the fd layer we do not need

Two questions had to be settled before any bridge code, and both were settled by measuring rather than by reading the POSIX spec.

**What the Go host actually asks for.** esbuild's blob builds its global object by defining a live getter for every property of `self`, then guards
its whole stub block behind `if (!globalThis.fs)`, so supplying `fs` suppresses that block. That is a contract, not a bag of names, and the bisect
is blunt about it:

| `self.fs` supplied | outcome |
|---|---|
| the stub's own object (nothing supplied) | boots, transform works |
| `{}` | `panic: syscall/js: call of Value.Get on undefined` at `syscall.init` |
| `{}` with `writeSync` + `write` | same panic |
| a near-complete mirror | boots |

So the recorder mirrors the stub's shape (`src` measurement: `npx tsx tools/measure-esbuild-wasm.ts --syscalls`) and then records. What one real
build asks for:

| phase | calls |
|---|---|
| plugin build, `stdin` contents | `write` x3, `stat` x1 |
| build reading a real file from the VFS | `write` x4, `open` x2, `stat` x1 |

Four members, and the failing build names the fifth requirement in its own words: `Cannot read directory ".": not implemented on js`, because
`open` answered ENOSYS and esbuild fell back to reading a directory. So the bridge is `write`, `open`, `read`, `close`, `stat` and the `constants`
object. No `chmod`, no `lchown`, no `fcntl`, no fd table anyone would have written from the spec.

**The finding that decides the architecture:** every one of those is a **callback form**. `fs.write(fd, buf, offset, length, position, callback)`,
`fs.open(path, flags, mode, callback)`, `fs.stat(path, callback)`. Not one `*Sync` member was called in either run, and Go's own stub for
js/wasm does not define any: its `fs` surface is asynchronous by construction. A synchronous bridge is not merely unnecessary here, it is
unreachable, because the Go side has no synchronous call to make.

That settles the Worker question in the direction that saves the most work. `Atomics.wait` being forbidden on the main thread rules out a
*synchronous* cross-thread bridge, and there is no synchronous call to bridge. So `esbuild-wasm` needs no Worker for the filesystem: the host object
is a thin adapter over the runtime's own `fs` shim, which is already async, already VFS-backed, and in production already served from the kernel
Worker over the SAB channel. The async shape means the same adapter works in-process and across threads unchanged. The fd layer over the syscall
channel stays unbuilt.

**Correction, added after the adapter was built.** "The plugin-mediated resolver is not needed either" was wrong, and the measurement in the next
section is what says so: the host object can answer metadata, but the Go side cannot receive file BYTES at all, so contents must arrive through
`onLoad` plugins. The resolver point stands and Vite's optimizer route is the one that works. The fd layer conclusion survived: no file bytes cross
the boundary, so there is no fd read to build.

**Cold versus warm.** Measured, one build in-process: install 357 ms (network, never in a user's boot), `new WebAssembly.Module` over 11.1 MB of wasm
49-67 ms, first transform 170-233 ms total including init, second transform immediate. Vite's own optimizer output lives in `node_modules/.vite` and
is regenerated freely, which makes it the textbook OPFS artefact: large, regenerable, shared across tabs. Measuring that cache is deferred with the
rest of the storage decision, and this note is the revisit trigger it was promised.

**Version drift.** `esbuild-wasm` publishes on the same line as `esbuild`, but the two do not ship on the same day, so a dependent can ask for a
version the substitute has not published. That now refuses in one sentence naming both sides
(`esbuild@^0.28.2 needs a version esbuild-wasm has not published: ... newest is 0.21.5`) and it never degrades to `latest`, which would serve a
different compiler silently. Pinned by `tests/unit/npm.substitutions.test.ts`, including that nothing is written to disk on the refusal.

## Parity: identical bytes, not "looks like it works"

`npx tsx tools/parity-esbuild.ts` compiles the same input twice and compares the output as bytes: native esbuild from this repo's own `node_modules`
(a Node process spawning a platform binary) and `esbuild-wasm` inside the container through the substitution table (WebAssembly, in-thread, no child
process). Any difference is a failure, with the first differing character and its context printed.

| job | native | wasm | sha256 (both) |
|---|---|---|---|
| typescript, es2020 | 56 B | 56 B | `228c8677a6b50e1c` |
| module declaring its own `exports` binding | 96 B | 96 B | `30f73cbe0f7c80b8` |
| jsx automatic runtime | 145 B | 145 B | `d0e24a219796ff6c` |

Both sides must be the **same version**, and the tool says so instead of quietly comparing different compilers: it installs `esbuild@<native version>`
through the table, then refuses if the substitute resolved anything else, naming both. Native 0.28.2 today, substituted 0.28.2.

The second job is there on purpose. It is the shape a real package produced and a synthetic corpus never would: a module declaring its own `exports`,
colliding with the injected CommonJS binding in a loader. Parity is what proves the compiler's output is untouched by anything our loader does around
it.

**All five jobs now run by default, including both builds.** The two build jobs were described as "waiting on the host `fs` adapter" while that
adapter did not exist. It exists now, and the jobs are not merely enabled, they are reshaped into the form the embedder can actually reach.

## The host `fs` object: metadata, not bytes

A Go binary compiled to `js/wasm` never touches a filesystem itself. Every file call is a `syscall/js` call into a JavaScript object named `fs`, and
`esbuild-wasm`'s loader installs a stub of that object whose every member answers `ENOSYS`, guarded as one block behind `if (!globalThis.fs)`. So the
choice is not "stub or no stub", it is "their stub, or an object of this exact shape": `self.fs = {}` panics the Go runtime at `syscall.init`, while a
mirror of the stub's member set boots.

**What was measured, not assumed.** `npx tsx tools/measure-esbuild-wasm.ts --syscalls --trace` installs a recording object and prints every call in
order with its arguments and its outcome. Three findings, each of which changed the design:

1. **Go's `Open` is not POSIX `open`.** From Go's own `src/syscall/fs_js.go`: it calls `open`, then `fstat(fd)`, and only asks for `readdir(path)` if
   `fstat` says the fd is a directory. A host `open` that fails on a directory makes esbuild report `Cannot read directory ".": Is a directory`, which
   looks like a host refusing a directory when it is the host failing to open one. The recorded sequence for one build is
   `stat("C:\")` (ENOENT, esbuild probing the cwd), `open("/app")`, `fstat(3)` → directory, `readdir("/app")`, `close(3)`, then the same for `/`, then
   `lstat` and `open` on the entry.
2. **`Stats` is read field by field and a partial object panics.** `syscall.setStat` calls `.Int()` on `dev`, `ino`, `mode`, `nlink`, `uid`, `gid`,
   `rdev`, `size`, `blksize`, `blocks` and the three `*Ms` values. Omitting them is not a degraded result, it is
   `panic: syscall/js: call of Value.Int on undefined` at `syscall/fs_js.go:166`. `mode` is load-bearing: directory-ness is `mode & S_IFMT == S_IFDIR`.
3. **File bytes cannot cross into the Go side at all.** This is the one that decides the architecture. `esbuild-wasm`'s in-thread service assigns
   `fs.read` and `fs.writeSync` **unconditionally**, after the host object is already in place, and its `read` is stdin-only: any other fd throws
   `Bad read`. A build whose entry must be read from disk therefore dies inside esbuild's own function, and
   `npx tsx tools/measure-esbuild-wasm.ts --build` reproduces it: `panic: JavaScript error: Bad read` through
   `bundler.runOnLoadPlugins -> FSCache.ReadFile -> os.ReadFile -> syscall.Read`.

The consequence is a shape, not a compromise. The Go side can learn a file's **metadata** and never its **bytes**, so module contents have to travel by
`onLoad`, which is exactly what Vite's dependency optimizer does. `src/runtime/host-fs.ts` implements the measured subset (`stat`, `lstat`, `open`,
`fstat`, `readdir`, `close`, `write`), keeps the stub's `ENOSYS` for everything unmeasured, and carries the full `Stats` shape so Go does not panic.

**That the adapter is load-bearing is measured too, not argued.** The parity run resolves the entry point with esbuild's own resolver, not a plugin, so
on the wasm side resolution can only work if the host object answers. With the adapter wired in, every job matches byte for byte. With the one wiring
line disabled, the same run fails before compiling anything: `Cannot read directory ".": not implemented on js` and `Could not resolve
"/app/entries/job-3.tsx"`. The build jobs' contents still come from `onLoad`, reading each job's own file with the program's `fs`, which is the
optimizer's route and the only reachable one.

| job | native | wasm | sha256 (both) |
|---|---|---|---|
| typescript, es2020 | 56 B | 56 B | `228c8677a6b50e1c` |
| module declaring its own `exports` binding | 96 B | 96 B | `30f73cbe0f7c80b8` |
| jsx automatic runtime | 145 B | 145 B | `d0e24a219796ff6c` |
| plugin round trip, minified | 40 B | 40 B | `9bc28c70ffbc78ec` |
| define and tree shaking | 60 B | 60 B | `998d621981d61eaf` |
| bare specifier through `node_modules` | 1424 B | 1424 B | `b9e1fcfe2b4b40f6` |

Each build job gets its own entry file. The jobs run in sequence through one program, so a shared path would hand every job the last job's source and
report identical results as agreement, which is the kind of green that measures nothing.

## The optimizer's core: a real package, resolved in JavaScript

`optimizeDeps` prebundles dependencies: Vite hands esbuild a set of entry points and a plugin that resolves and loads files itself, then keeps the
output. The question this slice had to answer is whether that shape works here, and the answer needed two runs that differ by one variable.

| run | entry imports | result |
|---|---|---|
| `measure-esbuild-wasm.ts --deps-rel` | `./dep.ts` | builds, 109 B |
| `measure-esbuild-wasm.ts --deps` | `is-odd` | `panic: JavaScript error: Bad read (while parsing "app/entry.ts")` |

Relative resolution works and a bare specifier does not, with an installed `is-odd` in `node_modules` and the same plugin supplying every file's
contents. The difference is what the resolver must read: a bare specifier needs the package's `package.json` **bytes** to look at `main`, `module` and
`exports`, and bytes cannot cross into the Go side. The panic names `app/entry.ts` because that is the file being parsed when it happened, which reads
like the entry is at fault; the entry is fine.

**So resolution moves into JavaScript, which is where Vite already puts it.** Vite's dependency plugin resolves with Vite's resolver for the same
reason, so this is not a workaround invented here. The runtime's own resolver is reachable from a program as
`require("module").createRequire("/app/main.js").resolve("is-odd")` → `/app/node_modules/is-odd/index.js`; a bare `require.resolve` does not exist,
which is worth knowing before writing the plugin.

The parity job `build: bare specifier through node_modules` is the proof that this is enough. The entry imports `is-odd` (which itself imports
`is-number`), the container resolves both in JavaScript and hands the files over, and native esbuild resolves the same package from the same mirrored
bytes with its own resolver. Both emit **1424 identical bytes**, `b9e1fcfe2b4b40f6`. Agreement here means two things at once: our resolver picks the
same files esbuild would, and the compiler is untouched by any of it.

**What is still between this and a working `optimizeDeps`.** Not the compiler and not the filesystem, and not top-level await either: that claim was
measured and it was wrong about both the file and the scope. `tools/scan-tla.ts` finds one module with a top-level await in `vite@5.4.21`,
`bin/vite.js`, imported by nothing, both awaits inert; `dist/node/cli.js` and `dist/node/module-runner.js` have none. Entry-level top-level await
now runs (ADR-0012 amendment), and a non-entry module that awaits is refused as `TLA_IN_NON_ENTRY` naming module and importer. What is left is the
orchestration around esbuild, which assumes a Node process with child processes, a cache directory and `chokidar`. This slice settles that the part
which had to be ours, the resolver plus the compiler call, produces the same bytes as Node does.
