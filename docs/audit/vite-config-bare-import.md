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

## One observation not attributed

The plugin's first version returned `config: () => ({ define: { __PLUGIN__: '"local-plugin"' } })` and the served module came back
**unreplaced**. `define` from a USER plugin's `config` hook therefore did not reach the transform in this setup. That was not investigated
further: the probe's question is whether a config's bare import loads and is used, and a `transform` hook answers it without depending on
plugin ordering. Vite's own hook ordering was not instrumented, so nothing is claimed about whether this is expected Vite behavior or something
this runtime perturbs. It is recorded because an unexplained unreplaced `define` is exactly the kind of detail that resurfaces later wearing a
different hat.

## What it cost

Nothing: this path was already correct, which is the useful kind of measurement. The tests exist so it stays correct, and they cost four cases
rather than a fixture the corpus has no slot for.
