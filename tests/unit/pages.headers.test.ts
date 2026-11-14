/**
 * The Cloudflare Pages isolation contract.
 *
 * Mirrors `tests/unit/isolation.headers.test.ts`: that file pins the dev server against `vercel.json`, this one pins a
 * third carrier, the `_headers` file Cloudflare Pages reads from the build output. The property under test is the same
 * one in both cases: if the deployed document is not cross-origin isolated, `SharedArrayBuffer` does not exist, and
 * ADR-0018's synchronous syscall channel cannot be built. Nothing throws when that happens. The page simply cannot boot.
 *
 * Two things are deliberately checked here rather than only in the build: that the committed file is *derived* from the
 * Vite config (so it cannot drift into a hand-maintained copy), and that the build is still wired to verify the file it
 * published (so the check cannot be removed without a test going red). The build itself then proves the copy happened:
 * `pages-headers-contract` in `vite.config.ts` fails `vite build` when `dist/browser/_headers` is absent or wrong, which
 * is what makes a broken Pages deploy impossible rather than merely unlikely.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveIsolationValues } from "../../tools/deploy/isolation-headers.js";
import {
  PAGES_HEADERS_OUTPUT_NAME,
  PAGES_HEADERS_SOURCE,
  PAGES_MAX_LINE_CHARACTERS,
  PAGES_MAX_RULES,
  ISOLATION_HEADER_NAMES,
  pagesHeaderProblems,
  parsePagesHeaders,
  patternsOverlap,
  renderPagesHeaders,
  runPagesHeaders,
  type IsolationValues,
} from "../../tools/deploy/pages-headers.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The file that ships. Read from disk so a missing file is a failure with a sentence attached, not an ENOENT trace:
 * this is the failure mode the whole change exists to prevent, so it should read like one.
 */
function committedHeaders(): string {
  const path = resolve(root, PAGES_HEADERS_SOURCE);
  if (!existsSync(path)) {
    throw new Error(
      `${PAGES_HEADERS_SOURCE} is missing. Cloudflare Pages would publish a build without COOP/COEP, so the deployed ` +
        "document would not be cross-origin isolated and SharedArrayBuffer would not exist. Run `npm run headers:write`.",
    );
  }
  return readFileSync(path, "utf8");
}

interface RawConfig {
  readonly publicDir?: string;
  readonly build?: { readonly outDir?: string; readonly emptyOutDir?: boolean };
  readonly plugins?: readonly { readonly name?: string; readonly apply?: string }[];
}

/**
 * The resolved browser build config. Imported through `vite.config.js` and called, the same way the isolation test does,
 * because the point is to read what the build actually uses rather than to grep the source for the values.
 */
async function browserConfig(): Promise<RawConfig> {
  const loaded = (await import("../../vite.config.js")) as unknown as {
    default: (env: { command: string; mode: string }) => RawConfig;
  };
  // `production`, not `preview`: preview mode refuses to build without VITE_PREVIEW_BASE_DOMAIN, and the output layout
  // is identical in both. Nothing here depends on the domain.
  return loaded.default({ command: "build", mode: "production" });
}

function headersFor(rules: ReturnType<typeof parsePagesHeaders>, pattern: string): Record<string, string> {
  const rule = rules.find((entry) => entry.pattern === pattern);
  if (rule === undefined) throw new Error(`no rule for ${pattern}`);
  return Object.fromEntries(rule.headers.map((header) => [header.name.toLowerCase(), header.value]));
}

/** The isolation headers from `vercel.json`, the deployment config that already ships. */
function vercelIsolation(): Record<string, string> {
  const config = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as {
    headers?: readonly { readonly source: string; readonly headers: readonly { readonly key: string; readonly value: string }[] }[];
  };
  const rule = (config.headers ?? []).find((entry) => entry.source === "/(.*)");
  if (rule === undefined) throw new Error("vercel.json has no catch-all header rule");
  const headers = Object.fromEntries(rule.headers.map((header) => [header.key.toLowerCase(), header.value]));
  return {
    [ISOLATION_HEADER_NAMES.opener.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.opener.toLowerCase()] ?? "",
    [ISOLATION_HEADER_NAMES.embedder.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.embedder.toLowerCase()] ?? "",
    [ISOLATION_HEADER_NAMES.resource.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.resource.toLowerCase()] ?? "",
  };
}

const pagesIsolation = (text: string): Record<string, string> => {
  const headers = headersFor(parsePagesHeaders(text), "/*");
  return {
    [ISOLATION_HEADER_NAMES.opener.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.opener.toLowerCase()] ?? "",
    [ISOLATION_HEADER_NAMES.embedder.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.embedder.toLowerCase()] ?? "",
    [ISOLATION_HEADER_NAMES.resource.toLowerCase()]: headers[ISOLATION_HEADER_NAMES.resource.toLowerCase()] ?? "",
  };
};

const derived: () => Promise<IsolationValues> = resolveIsolationValues;

describe("the Pages header file is where the build will find it", () => {
  it("sits at the root of the directory Vite copies into the output", async () => {
    const config = await browserConfig();
    // Undefined means Vite's default, which this config does not override.
    const publicDir = config.publicDir ?? "public";
    const outDir = config.build?.outDir ?? "";
    expect(outDir).toBe("dist/browser");

    const publicPath = resolve(root, publicDir);
    const sourcePath = resolve(root, PAGES_HEADERS_SOURCE);

    expect(isAbsolute(publicDir) || !publicDir.startsWith("..")).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);
    expect(statSync(sourcePath).isFile()).toBe(true);

    // Vite copies `public/` verbatim, so the file's path *inside* `public/` is its path inside `dist/browser`. A file
    // nested anywhere else in there would publish at that nested path, where Cloudflare never reads it.
    const outputName = relative(publicPath, sourcePath);
    expect(outputName).toBe(PAGES_HEADERS_OUTPUT_NAME);
    expect(basename(outputName)).toBe("_headers");
    expect(outputName.includes("/") || outputName.includes("\\")).toBe(false);

    // And the source must not be a file inside the output directory masquerading as one, because `emptyOutDir` would
    // delete it and the build would look configured while shipping nothing.
    expect(relative(resolve(root, outDir), sourcePath).startsWith("..")).toBe(true);
  });

  it("keeps the build wired to verify the file it published, so the check cannot be silently dropped", async () => {
    const config = await browserConfig();
    const plugin = (config.plugins ?? []).find((entry) => entry.name === "pages-headers-contract");
    expect(plugin).toBeDefined();
    // Build-only: in dev the headers come from the server config, and `public/_headers` is not what serves them.
    expect(plugin?.apply).toBe("build");
  });
});

describe("the Pages header file isolates the deployed document", () => {
  it("sends COOP, COEP and CORP on every path", () => {
    expect(committedHeaders()).toContain("/*");
    expect(pagesIsolation(committedHeaders())).toEqual({
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
  });

  it("is derived from the dev server's headers rather than typed in, and today they agree", async () => {
    const isolation = await derived();
    expect(isolation).toEqual({ opener: "same-origin", embedder: "require-corp", resource: "cross-origin" });
    // The file must be exactly what the generator renders from those values. Byte equality, not semantic equality:
    // a hand-edit that happens to be equivalent today is a hand-edit that drifts tomorrow.
    expect(committedHeaders()).toBe(renderPagesHeaders(isolation));
  });

  it("agrees with vercel.json, so neither host can quietly differ from the other", async () => {
    const isolation = await derived();
    const fromConfig = {
      [ISOLATION_HEADER_NAMES.opener.toLowerCase()]: isolation.opener,
      [ISOLATION_HEADER_NAMES.embedder.toLowerCase()]: isolation.embedder,
      [ISOLATION_HEADER_NAMES.resource.toLowerCase()]: isolation.resource,
    };
    expect(pagesIsolation(committedHeaders())).toEqual(fromConfig);
    expect(vercelIsolation()).toEqual(fromConfig);
  });

  it("uses require-corp rather than credentialless, because credentialless is Chromium-only", () => {
    // Same reason as the dev-server test: `credentialless` isolates in Chromium and not in Firefox or Safari, so the
    // same build would work for some users and not others.
    expect(pagesIsolation(committedHeaders())["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  it("carries the two cache rules the deployment already promises", () => {
    const rules = parsePagesHeaders(committedHeaders());
    expect(headersFor(rules, "/preview-sw.js")["cache-control"]).toContain("no-store");
    expect(headersFor(rules, "/assets/*")["cache-control"]).toContain("immutable");
    expect(headersFor(rules, "/assets/*")["cache-control"]).toContain("max-age=31536000");
  });

  it("inherits nosniff and the referrer policy from the catch-all instead of repeating them", () => {
    // Pages joins a repeated header name, so the narrower rules say only what they change.
    const catchAll = headersFor(parsePagesHeaders(committedHeaders()), "/*");
    expect(catchAll["x-content-type-options"]).toBe("nosniff");
    expect(catchAll["referrer-policy"]).toBe("no-referrer");
  });

  it("introduces no CSP and no frame-blocking header", () => {
    // Both are explicit non-goals of this change, and both would break something real: a CSP without 'unsafe-eval'
    // kills the engine (`new Function`), and X-Frame-Options stops the editor embedding its preview.
    const text = committedHeaders().toLowerCase();
    expect(text).not.toContain("content-security-policy");
    expect(text).not.toContain("x-frame-options");
    expect(text).not.toContain("frame-ancestors");
  });

  it("has no problem for the checker to report", async () => {
    expect(pagesHeaderProblems(committedHeaders(), await derived())).toEqual([]);
  });
});

describe("the Pages header file respects Pages' own rules", () => {
  it("never lets two matching rules name the same header, because Pages joins them with a comma", () => {
    const rules = parsePagesHeaders(committedHeaders());
    const collisions: string[] = [];
    for (const [index, rule] of rules.entries()) {
      for (const other of rules.slice(index + 1)) {
        if (!patternsOverlap(rule.pattern, other.pattern)) continue;
        const shared = rule.headers.filter((header) =>
          other.headers.some((candidate) => candidate.name.toLowerCase() === header.name.toLowerCase()),
        );
        for (const header of shared) collisions.push(`${header.name} in ${rule.pattern} and ${other.pattern}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("treats the two cache rules as disjoint and everything under /* as overlapping", () => {
    // The overlap rule has to be right in both directions or it is either vacuous or unusable: it must permit
    // /preview-sw.js and /assets/* to disagree about Cache-Control, and forbid anything from disagreeing with /*.
    expect(patternsOverlap("/*", "/assets/app.js")).toBe(true);
    expect(patternsOverlap("/assets/*", "/assets/app.js")).toBe(true);
    expect(patternsOverlap("/assets/*", "/assets/js/chunk.js")).toBe(true);
    // Two nested splats do match the same requests, which is the case a hand-written file gets wrong: a second cache
    // rule for a subdirectory silently joins onto the broader one.
    expect(patternsOverlap("/assets/*", "/assets/js/*")).toBe(true);
    expect(patternsOverlap("/assets/js/*", "/assets/*")).toBe(true);
    expect(patternsOverlap("/assets/*", "/images/*")).toBe(false);
    expect(patternsOverlap("/preview-sw.js", "/assets/*")).toBe(false);
    expect(patternsOverlap("/a.js", "/b.js")).toBe(false);
  });

  it("does not cache the root document, because a joined Cache-Control is a silent conflicting directive", () => {
    expect(headersFor(parsePagesHeaders(committedHeaders()), "/*")["cache-control"]).toBeUndefined();
  });

  it("stays inside the documented limits: 100 rules, 2,000 characters per line", () => {
    const text = committedHeaders();
    expect(parsePagesHeaders(text).length).toBeLessThanOrEqual(PAGES_MAX_RULES);
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(PAGES_MAX_LINE_CHARACTERS);
  });
});

describe("the checker refuses a file that would not isolate the deployment", () => {
  const isolation: IsolationValues = { opener: "same-origin", embedder: "require-corp", resource: "cross-origin" };
  const good = renderPagesHeaders(isolation);
  const problems = (text: string): string[] => pagesHeaderProblems(text, isolation);

  it("accepts the generated file, so the negative controls below are not passing by accident", () => {
    expect(problems(good)).toEqual([]);
  });

  it("refuses a missing catch-all rule", () => {
    const text = good.replace(/^\/\*$/m, "/index.html");
    expect(problems(text).join(" ")).toMatch(/no `\/\*` rule/);
  });

  it("refuses a weakened COEP, which is the failure that would ship silently", () => {
    const text = good.replace("require-corp", "credentialless");
    const found = problems(text).join(" ");
    expect(found).toMatch(/Cross-Origin-Embedder-Policy: "credentialless", expected "require-corp"/);
  });

  it("refuses each of the other two values being wrong", () => {
    // A wrong value, not an absent one: `same-origin-allow-popups` still isolates the document from *being* embedded
    // in ways the opener policy cares about, but it is not the value the dev server and vercel.json send, and a
    // divergence between carriers is exactly what this test exists to stop.
    expect(
      problems(good.replace("Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Opener-Policy: same-origin-allow-popups")).join(" "),
    ).toMatch(/Cross-Origin-Opener-Policy: "same-origin-allow-popups", expected "same-origin"/);
    expect(problems(good.replace("Cross-Origin-Resource-Policy: cross-origin", "Cross-Origin-Resource-Policy: same-origin")).join(" ")).toMatch(
      /Cross-Origin-Resource-Policy: "same-origin"/,
    );
  });

  it("refuses each of the three being absent, which is the shape a half-copied file takes", () => {
    for (const name of ["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy"]) {
      const removed = good
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(`${name}:`))
        .join("\n");
      expect(problems(removed).join(" ")).toContain(`does not send ${name} on /*`);
    }
    expect(problems(good.replace("  Referrer-Policy: no-referrer\n", "")).join(" ")).toMatch(/does not send Referrer-Policy/);
  });

  it("refuses a header name repeated across rules that can match the same request", () => {
    const text = `${good}/assets/app.js\n  Cross-Origin-Embedder-Policy: unsafe-none\n`;
    const found = problems(text).join(" ");
    expect(found).toMatch(/both match some requests/);
    expect(found).toMatch(/Pages joins the values instead of overriding/);
  });

  it("refuses two splat rules that overlap, which a hand-written file does by accident", () => {
    const text = `${good}/assets/*\n  Cache-Control: public, max-age=60\n/assets/js/*\n  Cache-Control: public, max-age=600\n`;
    expect(problems(text).join(" ")).toMatch(/\/assets\/\* and \/assets\/js\/\* both match some requests/);
  });

  it("refuses a Cache-Control on the catch-all, which Pages would join into a conflicting directive", () => {
    const text = good.replace("  X-Content-Type-Options: nosniff", "  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=600");
    expect(problems(text).join(" ")).toMatch(/join onto \/assets\/\* and \/preview-sw\.js/);
  });

  it("refuses a name repeated inside one block", () => {
    const text = good.replace("  X-Content-Type-Options: nosniff\n", "  X-Content-Type-Options: nosniff\n  X-Content-Type-Options: nosniff\n");
    expect(problems(text).join(" ")).toMatch(/twice in the \/\* rule/);
  });

  it("refuses more rules or longer lines than Pages accepts", () => {
    const many = `${good}${Array.from({ length: PAGES_MAX_RULES }, (_, index) => `/p${index}.js\n  X-Test: ${index}\n`).join("")}`;
    expect(problems(many).join(" ")).toMatch(/accepts at most 100/);
    const wide = `${good}/wide.js\n  X-Test: ${"a".repeat(PAGES_MAX_LINE_CHARACTERS)}\n`;
    expect(problems(wide).join(" ")).toMatch(/accepts at most 2000/);
  });

  it("refuses a file it cannot parse instead of ignoring the lines it does not understand", () => {
    expect(() => parsePagesHeaders("  COOP: same-origin\n")).toThrow(/before any path pattern/);
    expect(() => parsePagesHeaders("/*\n  not a header line\n")).toThrow(/expected "Name: value"/);
    expect(() => parsePagesHeaders("/*\n  ! Cache-Control\n")).toThrow(/detach lines/);
    expect(problems("/*\n  not a header line\n").join(" ")).toMatch(/does not parse/);
  });
});

describe("npm run headers:check", () => {
  const isolation: IsolationValues = { opener: "same-origin", embedder: "require-corp", resource: "cross-origin" };
  const memoryIo = (contents: string | null, writes: { path: string; contents: string }[] = []) => ({
    read: () => contents,
    write: (path: string, text: string) => {
      writes.push({ path, contents: text });
    },
  });

  it("passes on the committed file, which is what CI runs", async () => {
    const run = runPagesHeaders({ argv: ["--check"], isolation: await derived(), io: memoryIo(committedHeaders()) });
    expect(run.lines.join(" ")).toMatch(/matches the isolation headers/);
    expect(run.exitCode).toBe(0);
  });

  it("fails when the file is missing, and says what the deployment would lose", () => {
    const run = runPagesHeaders({ argv: ["--check"], isolation, io: memoryIo(null) });
    expect(run.exitCode).toBe(1);
    const message = run.lines.join(" ");
    expect(message).toMatch(/is missing/);
    expect(message).toMatch(/cross-origin/);
    expect(message).toMatch(/headers:write/);
  });

  it("fails on a single byte of drift, so a hand-edit cannot live beside the generator", () => {
    const run = runPagesHeaders({ argv: ["--check"], isolation, io: memoryIo(renderPagesHeaders(isolation).trimEnd()) });
    expect(run.exitCode).toBe(1);
    expect(run.lines.join(" ")).toMatch(/differs from the generated file/);
  });

  it("fails when the file is present but wrong, naming the header", () => {
    const weakened = renderPagesHeaders(isolation).replace("require-corp", "unsafe-none");
    const run = runPagesHeaders({ argv: ["--check"], isolation, io: memoryIo(weakened) });
    expect(run.exitCode).toBe(1);
    expect(run.lines.join(" ")).toMatch(/Cross-Origin-Embedder-Policy/);
  });

  it("writes the rendered file at the source path and nothing else", () => {
    const writes: { path: string; contents: string }[] = [];
    const run = runPagesHeaders({ argv: ["--write"], isolation, io: memoryIo(null, writes) });
    expect(run.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(PAGES_HEADERS_SOURCE);
    expect(writes[0]?.contents).toBe(renderPagesHeaders(isolation));
  });

  it("refuses to guess whether it should write or check", () => {
    expect(() => runPagesHeaders({ argv: [], isolation, io: memoryIo(null) })).toThrow(/exactly one of --write or --check/);
    expect(() => runPagesHeaders({ argv: ["--write", "--check"], isolation, io: memoryIo(null) })).toThrow(
      /exactly one of --write or --check/,
    );
  });
});
