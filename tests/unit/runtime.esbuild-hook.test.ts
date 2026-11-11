/**
 * The esbuild init hook restores native esbuild's write contract.
 *
 * WHY. `esbuild-wasm`'s browser service builds its channel with `hasFS: false`, so the JS side refuses `write: true` and makes `write` default to
 * false. Native esbuild defaults it to true. A caller written against Node esbuild (vite's `optimizeDeps` is one) therefore believes its files are on
 * disk when they exist only on the returned `outputFiles`, and vite's commit step only renames a directory that was never filled: measured as a dev
 * server that answers `504 Outdated Optimize Dep` forever for a dependency whose metadata names a file nobody wrote.
 *
 * The hook is exercised against a stand-in for esbuild rather than the real 12 MB WebAssembly build, because the CONTRACT is what must not regress:
 * which calls get their bytes written, and that a caller asking for `write: false` still gets a pure in-memory build.
 */
import { describe, expect, it } from "vitest";

import { initHookFor } from "../../src/runtime/init-hooks.js";

type Written = Map<string, string>;

/** A stand-in for `esbuild-wasm`: reports `outputFiles` and never writes, exactly like the hasFS:false service it stands for. */
function fakeEsbuild() {
  const calls: { method: string; options: Record<string, unknown> }[] = [];
  const outputFor = (options: Record<string, unknown>): { path: string; contents: Uint8Array; text: string }[] => {
    const directory = String(options.outdir ?? "");
    const single = options.outfile;
    const paths = typeof single === "string" ? [single] : [`${directory}/entry.js`, `${directory}/entry.js.map`];
    return paths.map((path) => {
      const text = `// ${path}\n`;
      return { path, contents: new TextEncoder().encode(text), text };
    });
  };
  const module = {
    version: "0.21.5",
    initialize: () => Promise.resolve(),
    build: (options: Record<string, unknown>) => {
      calls.push({ method: "build", options });
      if (options.write === true) throw new Error('The "write" option is unavailable in this environment');
      return Promise.resolve({ outputFiles: outputFor(options) });
    },
    context: (options: Record<string, unknown>) => {
      calls.push({ method: "context", options });
      if (options.write === true) throw new Error('The "write" option is unavailable in this environment');
      return Promise.resolve({
        rebuild: () => {
          calls.push({ method: "rebuild", options: {} });
          return Promise.resolve({ outputFiles: outputFor(options) });
        },
        dispose: () => Promise.resolve(),
      });
    },
    transform: (source: string) => {
      calls.push({ method: "transform", options: {} });
      return Promise.resolve({ code: source });
    },
  };
  return { module: { ...module, default: module }, calls };
}

function hookWith(module: unknown): { exports: Record<string, unknown>; written: Written } {
  const hook = initHookFor("esbuild-wasm");
  if (hook === undefined) throw new Error("esbuild-wasm declares no init hook");
  const written: Written = new Map();
  // The hook compiles the `.wasm` bytes it is handed, so the stand-in file is a real, empty module: magic, version, nothing else. Eight bytes is
  // the smallest module the browser will accept, and it keeps this test about the write contract rather than about WebAssembly.
  const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const prepared = hook.run(module, {
    dir: "/node_modules/esbuild",
    readFile: () => emptyModule,
    writeFile: (path, bytes) => written.set(path, new TextDecoder().decode(bytes)),
  });
  return { exports: prepared as Record<string, unknown>, written };
}

describe("esbuild init hook: build writes its output", () => {
  it("writes every output file when the caller asks for an outdir, the way native esbuild does", async () => {
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    await (exports["build"] as (options: unknown) => Promise<unknown>)({ entryPoints: ["/app/a.ts"], outdir: "/out" });

    expect([...written.keys()].sort()).toEqual(["/out/entry.js", "/out/entry.js.map"]);
    expect(written.get("/out/entry.js")).toBe("// /out/entry.js\n");
  });

  it("honours an explicit write: true instead of letting esbuild refuse it", async () => {
    // This is the exact call that threw before the hook existed: `write: true` reaches a hasFS:false service, which refuses by name.
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    await expect(
      (exports["build"] as (options: unknown) => Promise<unknown>)({ entryPoints: ["/app/a.ts"], outdir: "/out", write: true }),
    ).resolves.toBeTruthy();
    expect(written.size).toBe(2);
  });

  it("writes an outfile when there is only one", async () => {
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    await (exports["build"] as (options: unknown) => Promise<unknown>)({ entryPoints: ["/app/a.ts"], outfile: "/out/bundle.js" });
    expect([...written.keys()]).toEqual(["/out/bundle.js"]);
  });

  it("leaves write: false a pure in-memory build", async () => {
    // The existing fixtures read `outputFiles` and never touch a disk; a hook that wrote anyway would put files into the VFS that no fixture asked for.
    const { module, calls } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    const result = (await (exports["build"] as (options: unknown) => Promise<unknown>)({
      entryPoints: ["/app/a.ts"],
      outdir: "/out",
      write: false,
    })) as { outputFiles: unknown[] };

    expect(written.size).toBe(0);
    expect(result.outputFiles.length).toBe(2);
    expect(calls[0]?.options["write"]).toBe(false);
  });

  it("leaves a call with nowhere to write alone, so the error is esbuild's own", async () => {
    // `write: true` with no `outdir`/`outfile` is a caller error in native esbuild too ("Must use outdir or outfile when write is not false"). The
    // hook does not invent that message and does not swallow the mistake: the call is passed through untouched and its refusal reaches the caller.
    const { module, calls } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    await expect(
      (exports["build"] as (options: unknown) => Promise<unknown>)({ entryPoints: ["/app/a.ts"], write: true }),
    ).rejects.toThrow(/write/);
    expect(calls[0]?.options["write"]).toBe(true);
    expect(written.size).toBe(0);
  });

  it("leaves transform and the rest of the API untouched", async () => {
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    const result = (await (exports["transform"] as (source: string) => Promise<{ code: string }>)("let x = 1;")) as { code: string };
    expect(result.code).toBe("let x = 1;");
    expect(written.size).toBe(0);
    expect(exports["version"]).toBe("0.21.5");
  });
});

describe("esbuild init hook: a context writes on every rebuild", () => {
  it("writes the outputs of a rebuild, which is how a dependency optimizer refreshes its cache", async () => {
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    const context = (await (exports["context"] as (options: unknown) => Promise<{ rebuild: () => Promise<unknown> }>)({
      entryPoints: ["/app/picocolors.js"],
      outdir: "/deps",
    })) as { rebuild: () => Promise<unknown> };

    expect(written.size).toBe(0);
    await context.rebuild();
    expect([...written.keys()].sort()).toEqual(["/deps/entry.js", "/deps/entry.js.map"]);
    await context.rebuild();
    expect(written.size).toBe(2);
  });

  it("keeps the rest of the context reachable through the wrapper", async () => {
    const { module } = fakeEsbuild();
    const { exports } = hookWith(module);

    const context = (await (exports["context"] as (options: unknown) => Promise<Record<string, unknown>>)({ outdir: "/deps" })) as Record<
      string,
      unknown
    >;
    expect(typeof context["dispose"]).toBe("function");
  });
});

describe("esbuild init hook: the module's own export shape", () => {
  it("routes the default export through the wrapper as well", async () => {
    // esbuild's bundle ends with `default: browser_exports`, and an ES module import reads that property. Returning the raw object from `default`
    // put every wrapped function out of reach, and vite's optimizer kept calling the unwrapped `context` and kept writing nothing.
    const { module } = fakeEsbuild();
    const { exports, written } = hookWith(module);

    const asDefault = exports["default"] as Record<string, unknown>;
    await (asDefault["build"] as (options: unknown) => Promise<unknown>)({ entryPoints: ["/app/a.ts"], outdir: "/out" });
    expect(written.size).toBe(2);
  });
});
