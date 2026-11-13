/**
 * The product's dependency optimizer completes without a browser or a request to prod it.
 *
 * This is the case the resident pump was built for, and it is pinned here rather than only in the browser lane because the browser lane is slow,
 * needs a real install, and reports a failure as a page that never rendered. Measured on the previous commit: the dev server listened, the page's
 * script was rewritten to a pre-bundled URL, and that URL never came back with a body, because the optimizer's own queued work had no moment in
 * which to run.
 *
 * `picocolors` is the smallest real case: a plain CommonJS module that vite itself depends on, so the frozen snapshot holds it and the answer needs
 * no network. The three assertions are the three facts the fix has to deliver: the specifier is rewritten, the pre-bundled file exists on disk, and
 * the rewritten URL serves the converted module.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Container } from "../../src/container/container.js";
import { loadSnapshotRegistry } from "../../src/registry/snapshot.js";
import { InProcessClient, MapFiles, repoRoot } from "../../tools/harness/fixture-executor.js";

const snapshot = (): ReturnType<typeof loadSnapshotRegistry> => {
  const root = join(repoRoot, "fixtures/snapshots/vite");
  return loadSnapshotRegistry({
    slug: "vite",
    root,
    manifestText: readFileSync(join(root, "snapshot.json"), "utf8"),
    read: (path) => new Uint8Array(readFileSync(path)),
  });
};

const files = (): MapFiles =>
  new MapFiles({
    "package.json": JSON.stringify(
      { name: "optimizer", private: true, version: "0.0.0", type: "module", scripts: { dev: "vite" }, devDependencies: { vite: "^5.4.0" } },
      null,
      2,
    ),
    "index.html": '<!doctype html>\n<html><head><meta charset="utf-8" /></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n',
    "src/main.js": 'import pc from "picocolors";\n\ndocument.title = pc.green("ready");\n',
  });

describe("the product's optimizer", () => {
  it("pre-bundles a bare import, writes it, and serves it", async () => {
    const runtime = new InProcessClient();
    const container = new Container({ runtime, files: files(), registry: snapshot() });
    const session = container.createSession("optimizer");

    await container.execute(session.id, "npm install");
    await container.execute(session.id, "npm run dev -- --port 3311 --host 127.0.0.1");

    const answer = await runtime.probe("http://localhost:3311/src/main.js");
    expect(answer.status).toBe(200);
    const rewritten = /from\s+"([^"]*deps\/picocolors[^"]*)"/.exec(answer.body)?.[1] ?? null;
    expect(rewritten, `no pre-bundled specifier in:\n${answer.body.slice(0, 600)}`).not.toBeNull();

    // On disk, read from outside the server: the optimizer's write, not the server's in-memory metadata. Polled rather than read once, because the
    // optimizer is asynchronous BY DESIGN - vite answers with the rewritten specifier before the pre-bundled file is finished - so a single read
    // would be a race that passes on a fast machine and fails on a slow one.
    const deadline = Date.now() + 30_000;
    let written: string | null = null;
    while (written === null && Date.now() < deadline) {
      written = runtime.readFile("/node_modules/.vite/deps/picocolors.js");
      if (written === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(written, "the optimizer never wrote its pre-bundled file").not.toBeNull();

    const prebundled = await runtime.probe(`http://localhost:3311${rewritten ?? ""}`);
    expect(prebundled.status).toBe(200);
    // esbuild-wasm's CommonJS shim, not vite's error page and not an empty body.
    expect(prebundled.body).toContain("__commonJS");
  }, 120_000);
});
