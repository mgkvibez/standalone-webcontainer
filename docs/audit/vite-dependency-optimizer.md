# The dependency optimizer, measured to the end

`vite dev` has one path nothing else in this project touches: a bare import has to be pre-bundled before the browser can
load it. Every fixture so far imports a relative specifier, so `optimizeDeps` had never run. This slice ran it, and the
answer took three defects, none of which was the one the name suggests.

Probe: `npx vite-node tools/probe-vite-deps.ts` (frozen snapshot, no network). It fetches `/src/main.js`, follows the
rewritten specifier the way a browser does, and then asks the container what the optimizer left on disk.

## 1. A served request never ran its own timers

Measured with vite nowhere in sight (`tools/probe-timer.ts`, and six unit tests): an `http` handler that awaits
`setTimeout(..., 10)` never answered, and neither did one awaiting `setTimeout(..., 0)`. The queue was pumped only while a
program body ran, and a dev server outlives its body by design, so the timer that would resume the handler could never
fire. The request sat until the gateway's deadline and became a 504.

Fixed in ADR-0013 amendment 4: `Scheduler.pumpWhile(pending, limits)` pumps the queue for as long as a request is
outstanding, with its own guard accounting (per request, not per program) bounded under the gateway's deadline. Both probes
now answer `200`.

## 2. esbuild believed it had no filesystem

The optimizer's tool is `esbuild.context({ outdir })` plus a rebuild. `esbuild-wasm`'s browser service builds its channel
with `hasFS: false` (`lib/browser.js`), and the JS side then

- throws `The "write" option is unavailable in this environment` for an explicit `write: true`, and
- makes `write` **default to false**, where native esbuild defaults it to true.

So the build ran, returned `outputFiles`, and wrote nothing. Vite's commit step only renames the temporary cache directory
into place, which is why `_metadata.json` and `package.json` appeared while `picocolors.js` did not: metadata naming a file
nobody wrote. The browser asked for it and got `504 Outdated Optimize Dep`, forever.

Fixed at the esbuild init hook, which is where the runtime already prepares the package: `write` defaults to true, an
`outdir`/`outfile` receives the real bytes through the runtime's filesystem, and a context writes on every rebuild.
`write: false` stays a pure in-memory build, which is what the fixtures that read `outputFiles` rely on. Nine tests pin
the contract (`tests/unit/runtime.esbuild-hook.test.ts`), and the whole path is measured by
`tools/probe-esbuild-write.ts`: one build, one output file, `102 bytes`, contents equal to what esbuild reported.

**One detail that mattered more than its size:** the hook's replacement was a `Proxy`, and esbuild's bundle ends with
`default: browser_exports`, so an ES module import read `.default` and got the RAW object. The proxy was in place and
unreached; vite kept calling the unwrapped `context`. `default` now answers the proxy itself.

## 3. The result

```
GET /src/main.js                                 200
picocolors specifier after transform             /@id//node_modules/.vite/deps/picocolors.js?v=…
/out/… → node_modules/.vite/deps/picocolors.js   1185 bytes
node_modules/.vite/deps/picocolors.js.map        1291 bytes
GET /@id//node_modules/.vite/deps/picocolors.js  200, 1185 bytes
```

`picocolors` is real bundled CommonJS converted to an ES module by esbuild, served through the gateway to a browser that
asked for it by the rewritten specifier. The bytes come from the snapshot, so the measurement needs no network.

## What is still between this and fast

The optimizer only advances while a request is in flight: with the dev server idle its file never appears (measured: sixty
seconds of polling, nothing, then the file was there when the next request drove the pump). Vite's own protocol hides this
from a browser, which is why the probe's first attempt can still see a `504` and the reload succeeds, but a real editor
session would notice: a cold start is answered at request speed, not at optimizer speed.

That is a scheduling decision with a real cost (an idle pump competes with every other process in the same worker), so it is
recorded here for the audit rather than invented. Everything above it is a defect fixed at its own seam, with a test that
would fail if it came back.
