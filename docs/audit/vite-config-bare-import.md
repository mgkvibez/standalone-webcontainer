# A bare import in `vite.config.js`, measured

The last front-end path with no measurement on it. Every fixture either has no config or has one that imports a relative file, and the
dependency optimizer's rewrite is request-scoped, so a bare specifier in the CONFIG is the one shape nothing else covers: Vite loads a
config by bundling it with esbuild and **externalizing** every bare import, which turns `import plugin from "local-plugin"` into a
resolve-and-load the dev server performs itself, before any request exists and with no request to keep a pump alive.

Probe: `tools/probe-vite-config-plugin.ts`. It writes the plugin package into the project's own `node_modules` AFTER `npm install`, so the
package is absent from whatever the install recorded, and the answer needs no network.

**Pinned as tests, not as a fixture.** The corpus is pre-registered at ids 1-20 and the loader refuses any definition outside that range
(`definition.ts`, `manifest.ts`), which is the charter's rule rather than an inconvenience to route around. So the guard is
`tests/unit/loader-post-install-package.test.ts`, four cases: a package written after install resolves and loads from a config-shaped file, an
ES module's own `import` reaches it too, the nearest `node_modules` wins, and an absent name still fails with the name in the message.

## The answer: it works, and the reason is worth stating

```
make-plugin: plugin written
plugin on disk: yes
dev process: running ports=3301
local-plugin MODULE LOADED
local-plugin FACTORY CALLED
GET / -> 200
GET /src/main.js -> 200  document.title = "local-plugin";
```

Five facts, each of which could have been the failure:

1. **The bare specifier resolves from the project's `node_modules` even though the package was written after install.** Nothing memoized the
   install's file list into a resolver that a later write cannot see. That was the real risk here and it is not present.
2. **It resolves from the config's own directory** (`/`), not from `/node_modules/vite` or the runtime's entry. Vite bundles the config to a
   timestamped file beside it and imports that, so a resolver anchored to the importer is what makes the config's imports behave like a
   project's imports rather than like vite's dependencies.
3. **The factory is called.** A resolve that produced a path but not a module would have started a server whose config silently lacked the
   plugin, so the probe logs from inside the module and from inside the factory.
4. **Vite uses the plugin.** The plugin transforms `/src/main.js`, and the served module is the transformed text:
   `document.title = __PLUGIN__;` in, `document.title = "local-plugin";` out.
5. **The server still answers a request afterwards**, so loading the config did not consume the run in a way that leaves the server unable
   to serve (the guard the timer work added, exercised on a different path).

## The `define` observation, now settled: my expectation was wrong

The plugin's first version returned `config: () => ({ define: { __PLUGIN__: '"local-plugin"' } })` and the served module came back
**unreplaced**. That looked like a defect and is not one. Vite's own shipped source says so, at `chunks/dep-BK3b2jBa.js:47346` of vite 5.4.21:

```js
name: "vite:define",
async transform(code, id, options) {
  const ssr = options?.ssr === true;
  if (!ssr && !isBuild) {
    return;
  }
```

For a client dev transform the plugin returns immediately. The only substitution vite performs in dev is `process.env.NODE_ENV`, in the
client-env plugin (`~47504`). So a user `define` is **not** applied to dev-served source, by design, and the runtime that left it alone was
behaving correctly.

Cross-checked against a real server rather than the source alone: the same config under real Vite 7.3.7 (this repo's own devDependency) also
serves `document.title = __APP_VERSION__;` verbatim, including with the documented `__APP_VERSION__` example. Two implementations and the
source agree.

The branch that *does* substitute is build, and there the substitution is real work through esbuild-wasm with the output written to disk.
Measured (`tools/probe-vite-define.ts`, `vite build`, `define: { __DEFINED_VALUE__: '"define-worked"' }`):

```
dist/assets/index-DA4DlV4G.js  800 bytes
  contains define-worked: true
  still contains __DEFINED_VALUE__: false
```

**Limitation, stated rather than hidden:** real vite 5.4.21 could not be executed under Node for the cross-check, because this snapshot ships
`esbuild-wasm` where vite imports `esbuild` (`ERR_MODULE_NOT_FOUND: Cannot find package 'esbuild'`). The cross-check therefore used vite
7.3.7 plus 5.4.21's own source, not a 5.4.21 process.

## What it cost

Nothing: this path was already correct, which is the useful kind of measurement. The tests exist so it stays correct, and they cost four cases
rather than a fixture the corpus has no slot for.
