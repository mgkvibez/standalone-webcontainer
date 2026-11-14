/**
 * The Cloudflare Pages `_headers` file, as a checked artefact rather than a hand-written one.
 *
 * Why this exists: without COOP and COEP the document is not cross-origin isolated, `SharedArrayBuffer` does not exist,
 * and ADR-0018's synchronous syscall channel cannot be built. Nothing throws when it is missing: the runtime reaches a
 * state it cannot boot from and the page looks broken for no stated reason. The dev server and `vercel.json` already
 * send those headers; Cloudflare Pages reads them from a file that has to be *in the build output*, and a deploy that
 * quietly lacked it would be a production outage discoverable only in a browser.
 *
 * So the file is generated from the same values the dev server sends (`tools/deploy/isolation-headers.ts` reads them
 * from the resolved Vite config), `npm run headers:check` fails on any drift and runs inside `npm run verify`, and the
 * browser build refuses to finish without it (the `pages-headers-contract` plugin in `vite.config.ts`).
 *
 * Three Cloudflare-specific facts shape the file, all from the Pages `_headers` documentation:
 *
 * 1. Every rule whose pattern matches a request applies, and the headers accumulate.
 * 2. A header name that appears twice is **joined with a comma**, not overridden. Joining `Cache-Control` produces
 *    `public, max-age=31536000, immutable, public, max-age=0`, which RFC 9111 says a cache may treat as stale. Nothing
 *    errors. So each header name appears exactly once in the whole file.
 * 3. `! Name` detaches a header added by an earlier rule. This project uses no detach, because no rule needs to remove
 *    something a broader rule added.
 *
 * This module is pure: no `node:fs`, no `process`. The CLI in `pages-headers-cli.ts` does the I/O.
 */

/** Where the file lives in the repository, relative to the project root. `public/` is copied verbatim into `dist/browser`. */
export const PAGES_HEADERS_SOURCE = "public/_headers";

/** What the file is called once Vite has copied it into the output directory. Cloudflare reads it from there. */
export const PAGES_HEADERS_OUTPUT_NAME = "_headers";

/** Cloudflare Pages limits: "You may define up to 100 header rules. Each line has a 2,000 character limit." */
export const PAGES_MAX_RULES = 100;
export const PAGES_MAX_LINE_CHARACTERS = 2_000;

/**
 * The wire names of the three headers that make a document cross-origin isolated. Kept as names rather than as our own
 * vocabulary because these are what the browser reads and what a wrong value in the file would be wrong *as*.
 */
export const ISOLATION_HEADER_NAMES = {
  opener: "Cross-Origin-Opener-Policy",
  embedder: "Cross-Origin-Embedder-Policy",
  resource: "Cross-Origin-Resource-Policy",
} as const;

export interface IsolationValues {
  readonly opener: string;
  readonly embedder: string;
  readonly resource: string;
}

export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

export interface HeaderRule {
  readonly pattern: string;
  readonly headers: readonly HeaderEntry[];
}

/**
 * The two cache rules, mirroring `vercel.json`. Pages' own default for an asset is short-lived and revalidated; the
 * hashed files under `/assets/` never change under the same name, and the service worker must never be served from
 * cache, because a stale worker outlives the deployment that replaced it.
 *
 * Neither rule repeats a header the `/*` rule already sets, so nothing is joined. `nosniff` and `Referrer-Policy` are
 * inherited from `/*` instead of being repeated here, which differs from the `vercel.json` layout (where per-rule
 * duplication is harmless because Vercel overrides) and is the same effective result.
 */
const CACHE_RULES: readonly { readonly pattern: string; readonly value: string }[] = [
  { pattern: "/preview-sw.js", value: "no-store, no-cache, must-revalidate" },
  { pattern: "/assets/*", value: "public, max-age=31536000, immutable" },
];

/** Everything that has to be true of a document for the runtime to boot, plus the two defaults the catch-all owns. */
const CATCH_ALL_HEADERS: readonly { readonly name: string; readonly value: string }[] = [
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "Referrer-Policy", value: "no-referrer" },
];

/**
 * Renders the file. `isolation` is derived rather than typed in, so the Pages file cannot drift from the dev server:
 * `headers:check` compares this rendering against what is committed.
 *
 * Note what is deliberately absent: `Cache-Control` on `/*`. It would be joined with the two cache rules above.
 */
export function renderPagesHeaders(isolation: IsolationValues): string {
  const lines: string[] = [
    "# Cloudflare Pages response headers.",
    "#",
    "# GENERATED FILE. Do not edit by hand: it is rendered from the isolation headers in `vite.config.ts`",
    "# (`ISOLATION_HEADERS`), which the dev server and `vercel.json` also send.",
    "#",
    "#   npm run headers:write    regenerate after changing vite.config.ts",
    "#   npm run headers:check    fail on drift (runs inside `npm run verify`)",
    "#",
    "# Why it has to be a file here: Pages does not read `vercel.json`, so this is the only way the deployed document",
    "# gets COOP/COEP and stays cross-origin isolated. Without them `SharedArrayBuffer` does not exist and the runtime",
    "# cannot boot. Each header name appears exactly once in this file, because Pages joins repeated names with a",
    "# comma; see tools/deploy/pages-headers.ts.",
    "",
  ];

  for (const rule of CACHE_RULES) {
    lines.push(rule.pattern, `  Cache-Control: ${rule.value}`, "");
  }

  lines.push("/*");
  lines.push(`  ${ISOLATION_HEADER_NAMES.opener}: ${isolation.opener}`);
  lines.push(`  ${ISOLATION_HEADER_NAMES.embedder}: ${isolation.embedder}`);
  lines.push(`  ${ISOLATION_HEADER_NAMES.resource}: ${isolation.resource}`);
  for (const header of CATCH_ALL_HEADERS) lines.push(`  ${header.name}: ${header.value}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Parses the subset of the `_headers` syntax this project uses, strictly.
 *
 * Strict rather than permissive on purpose: a file that Pages would silently ignore half of is the failure this whole
 * module exists to prevent, so an unrecognised line is an error naming its line number, not something to skip.
 */
export function parsePagesHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: { pattern: string; headers: HeaderEntry[] } | null = null;

  const sourceLines = text.split("\n");
  for (const [index, raw] of sourceLines.entries()) {
    const lineNumber = index + 1;
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) continue;

    if (!/^[ \t]/.test(line)) {
      const pattern = line.trim();
      if (pattern.includes(" ")) {
        throw new Error(`line ${lineNumber}: a path pattern cannot contain a space ("${pattern}")`);
      }
      current = { pattern, headers: [] };
      rules.push(current);
      continue;
    }

    if (current === null) throw new Error(`line ${lineNumber}: a header line appears before any path pattern`);

    const match = /^[ \t]+(!)?[ \t]*([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (match === null) {
      const hint = /^[ \t]+!/.test(line) ? " (detach lines are not used by this project)" : "";
      throw new Error(`line ${lineNumber}: expected "Name: value" inside the block for ${current.pattern}${hint}`);
    }
    const [, detach, name, value] = match;
    if (detach !== undefined) {
      throw new Error(`line ${lineNumber}: detach lines are not used by this project, so this file is not what it claims`);
    }
    if (name === undefined || value === undefined || value.trim() === "") {
      throw new Error(`line ${lineNumber}: "${name ?? line.trim()}" has no value`);
    }
    current.headers.push({ name, value: value.trim() });
  }

  return rules;
}

const sameName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * Whether Cloudflare would apply both patterns to the same request. Only then can a repeated header name be joined,
 * which is why the cache rules are allowed to disagree with each other and nothing is allowed to disagree with `/*`.
 *
 * Pages patterns are literal paths, a single trailing splat, or `/*` — and `/*` needs no special case, because its
 * prefix is `/` and every absolute path starts with that. Two literals overlap only when equal; a literal overlaps a
 * splat when it starts with the splat's prefix; two splats overlap when one prefix contains the other.
 */
export function patternsOverlap(left: string, right: string): boolean {
  if (left === right) return true;

  const prefix = (pattern: string): string | null =>
    pattern.endsWith("/*") ? pattern.slice(0, -1) : null;
  const leftPrefix = prefix(left);
  const rightPrefix = prefix(right);

  if (leftPrefix === null && rightPrefix === null) return false;
  if (leftPrefix !== null && rightPrefix !== null) {
    return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
  }
  const splat = leftPrefix ?? rightPrefix ?? "";
  const literal = leftPrefix === null ? left : right;
  return literal.startsWith(splat);
}

/** Every occurrence of a header name in the file, as `pattern` names so a problem can say where it came from. */
function occurrences(rules: readonly HeaderRule[], name: string): { pattern: string; value: string }[] {
  const found: { pattern: string; value: string }[] = [];
  for (const rule of rules) {
    for (const header of rule.headers) {
      if (sameName(header.name, name)) found.push({ pattern: rule.pattern, value: header.value });
    }
  }
  return found;
}

/**
 * What is wrong with this file, as sentences. Empty means it would isolate the deployed document.
 *
 * The checks are written in terms of consequences, because the reason this matters is not visible from the mismatch:
 * a missing COOP and a `require-corp` typo both end as "the runtime silently does not boot".
 */
export function pagesHeaderProblems(text: string, isolation: IsolationValues): string[] {
  let rules: HeaderRule[];
  try {
    rules = parsePagesHeaders(text);
  } catch (error) {
    return [`does not parse: ${error instanceof Error ? error.message : String(error)}`];
  }

  const problems: string[] = [];

  if (rules.length > PAGES_MAX_RULES) {
    problems.push(`declares ${rules.length} rules, and Cloudflare Pages accepts at most ${PAGES_MAX_RULES}`);
  }
  for (const [index, line] of text.split("\n").entries()) {
    if (line.length > PAGES_MAX_LINE_CHARACTERS) {
      problems.push(`line ${index + 1} is ${line.length} characters, and Cloudflare Pages accepts at most ${PAGES_MAX_LINE_CHARACTERS}`);
    }
  }

  const catchAll = rules.find((rule) => rule.pattern === "/*");
  if (catchAll === undefined) {
    problems.push("has no `/*` rule, so every path outside the two cache rules is served without isolation headers");
  } else {
    const required = [
      { name: ISOLATION_HEADER_NAMES.opener, expected: isolation.opener },
      { name: ISOLATION_HEADER_NAMES.embedder, expected: isolation.embedder },
      { name: ISOLATION_HEADER_NAMES.resource, expected: isolation.resource },
      ...CATCH_ALL_HEADERS.map((header) => ({ name: header.name, expected: header.value })),
    ];
    for (const { name, expected } of required) {
      const found = catchAll.headers.filter((header) => sameName(header.name, name));
      const first = found[0];
      if (first === undefined) {
        problems.push(`does not send ${name} on /*`);
      } else if (found.length > 1) {
        problems.push(`sends ${name} ${found.length} times on /*, which Pages joins into one comma-separated value`);
      } else if (first.value !== expected) {
        problems.push(`sends ${name}: "${first.value}", expected "${expected}" for this document to be cross-origin isolated`);
      }
    }
  }

  // A Cache-Control on the catch-all would be joined with the narrower cache rules, and RFC 9111 lets a cache treat
  // conflicting directives as stale. Inheriting nothing is the only safe arrangement.
  if (catchAll !== undefined && occurrences([catchAll], "Cache-Control").length > 0) {
    problems.push("sets Cache-Control on /*, which Pages would join onto /assets/* and /preview-sw.js into one conflicting directive");
  }

  // A name twice inside one block is joined just as surely as a name in two overlapping blocks.
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const header of rule.headers) {
      const key = header.name.toLowerCase();
      if (seen.has(key)) problems.push(`sets ${header.name} twice in the ${rule.pattern} rule, which Pages joins into one value`);
      seen.add(key);
    }
  }

  // Two rules that would answer the same request may not both name a header: Pages joins them, it does not override.
  // `/preview-sw.js` and `/assets/*` are disjoint and may disagree about Cache-Control; nothing may disagree with `/*`.
  for (const [index, rule] of rules.entries()) {
    for (const other of rules.slice(index + 1)) {
      if (!patternsOverlap(rule.pattern, other.pattern)) continue;
      const shared = rule.headers
        .map((header) => header.name)
        .filter((name) => other.headers.some((header) => sameName(header.name, name)));
      if (shared.length === 0) continue;
      const joined = shared
        .map((name) => {
          const values = [...occurrences([rule], name), ...occurrences([other], name)].map((entry) => entry.value);
          return `${name} ("${values.join(", ")}")`;
        })
        .join(", ");
      problems.push(`${rule.pattern} and ${other.pattern} both match some requests and both set ${joined}; Pages joins the values instead of overriding`);
    }
  }

  return problems;
}

export interface PagesHeadersIo {
  /** Returns the file's contents, or `null` when it does not exist. Any other read error must be thrown. */
  readonly read: (path: string) => string | null;
  readonly write: (path: string, contents: string) => void;
}

export interface PagesHeadersRun {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

function mode(argv: readonly string[]): "write" | "check" {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) throw new Error("pass exactly one of --write or --check");
  return write ? "write" : "check";
}

/**
 * `--write` regenerates the committed file from the derived values; `--check` reports drift and changes nothing.
 *
 * Drift here means any difference from the rendering, including a comment, so the file that is deployed is byte-for-byte
 * the file this module produces. Semantic equality would let a hand-edit live alongside the generator and diverge later.
 */
export function runPagesHeaders(input: {
  readonly argv: readonly string[];
  readonly isolation: IsolationValues;
  readonly io: PagesHeadersIo;
}): PagesHeadersRun {
  const expected = renderPagesHeaders(input.isolation);
  const wanted = mode(input.argv);

  if (wanted === "write") {
    input.io.write(PAGES_HEADERS_SOURCE, expected);
    return { lines: [`wrote ${PAGES_HEADERS_SOURCE} (${expected.length} bytes)`], exitCode: 0 };
  }

  const actual = input.io.read(PAGES_HEADERS_SOURCE);
  if (actual === null) {
    return {
      lines: [
        `${PAGES_HEADERS_SOURCE} is missing.`,
        "Cloudflare Pages would serve this build without COOP/COEP, so the document would not be cross-origin",
        "isolated, SharedArrayBuffer would not exist, and ADR-0018's syscall channel would not boot.",
        "Run `npm run headers:write`.",
      ],
      exitCode: 1,
    };
  }

  const problems = pagesHeaderProblems(actual, input.isolation);
  if (actual !== expected) {
    problems.push("differs from the generated file; run `npm run headers:write` (this file is generated, not edited)");
  }
  if (problems.length === 0) {
    return { lines: [`${PAGES_HEADERS_SOURCE} matches the isolation headers in vite.config.ts`], exitCode: 0 };
  }

  return {
    lines: [
      `${PAGES_HEADERS_SOURCE} would not isolate the deployed document:`,
      ...problems.map((problem) => `  - ${problem}`),
      "Run `npm run headers:write` after fixing vite.config.ts.",
    ],
    exitCode: 1,
  };
}
