/**
 * Top-level await, counted per module, before any decision is made about it.
 *
 * "Vite is ESM with top-level await" is a claim about a whole codebase, and it hides the only things that matter: how many modules actually have one,
 * and whether anything imports them. This tool answers exactly that with acorn, distinguishing a real top-level `await` from one inside a function
 * (ordinary async code, never a problem), and then naming the importers of every module that does have one.
 *
 * Why the importer column decides the design: a module whose evaluation is async makes every importer's evaluation async, transitively. If nothing
 * imports it there is no transitivity to implement, and async module records buy nothing.
 *
 * Usage: npx tsx tools/scan-tla.ts <dir> [--json]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { parse } from "acorn";

interface Found {
  /** Await lines at module scope, in source order. */
  readonly lines: readonly number[];
  /** Import specifiers this module names, kept so the importer graph needs only one pass. */
  readonly specifiers: readonly { readonly specifier: string; readonly line: number }[];
}

interface Node {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

const FUNCTION_TYPES = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

/** Walks one file, tracking function depth so an await inside a callback is not counted as top-level. */
function inspect(source: string): Found {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: true }) as unknown as Node;
  const lines: number[] = [];
  const specifiers: { specifier: string; line: number }[] = [];

  const visit = (node: Node, functionDepth: number): void => {
    const nextDepth = FUNCTION_TYPES.test(node.type) ? functionDepth + 1 : functionDepth;
    const line = node.loc?.start.line ?? 0;

    if (node.type === "AwaitExpression" && functionDepth === 0) lines.push(line);
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      const source = node["source"];
      if (isNode(source) && typeof source["value"] === "string") specifiers.push({ specifier: source["value"], line });
    }
    if (node.type === "ImportExpression") {
      const source = node["source"];
      if (isNode(source) && source.type === "Literal" && typeof source["value"] === "string") specifiers.push({ specifier: source["value"], line });
    }
    if (node.type === "CallExpression") {
      const callee = node["callee"];
      const args = node["arguments"];
      if (isNode(callee) && callee["name"] === "require" && Array.isArray(args) && isNode(args[0]) && typeof args[0]["value"] === "string") {
        specifiers.push({ specifier: args[0]["value"], line });
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, nextDepth);
      } else if (isNode(value)) {
        visit(value, nextDepth);
      }
    }
  };

  visit(ast, 0);
  return { lines, specifiers };
}

/** Every JS module under a directory, in a stable order so two runs print the same table. */
function modules(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:js|mjs|cjs)$/.test(name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: scan-tla.ts <dir> [--json]");
  process.exit(2);
}

const root = resolve(target);
const files = modules(root);
const inspected = new Map<string, Found>();
const unparsable: { file: string; reason: string }[] = [];

for (const file of files) {
  try {
    inspected.set(file, inspect(readFileSync(file, "utf8")));
  } catch (error) {
    // A UMD or CJS file parsed as a module can be a syntax error, and that is not a finding about await. Reported, never silently dropped.
    unparsable.push({ file: relative(root, file), reason: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) });
  }
}

const withTla = [...inspected.entries()].filter(([, found]) => found.lines.length > 0);

/** Who imports whom, resolved the way Node resolves a relative specifier: `./x` -> `x`, `x.js`, `x/index.js`. */
function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.mjs")]) {
    if (inspected.has(candidate)) return candidate;
  }
  return null;
}

const importers = new Map<string, { file: string; line: number }[]>();
for (const [file, found] of inspected) {
  for (const { specifier, line } of found.specifiers) {
    const targetFile = resolveRelative(file, specifier);
    if (targetFile === null) continue;
    const list = importers.get(targetFile) ?? [];
    list.push({ file: relative(root, file), line });
    importers.set(targetFile, list);
  }
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        root,
        modules: files.length,
        unparsable,
        tla: withTla.map(([file, found]) => ({ file: relative(root, file), lines: found.lines, importers: importers.get(file) ?? [] })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`${files.length} module(s) parsed under ${relative(process.cwd(), root) || "."}`);
  if (unparsable.length > 0) {
    console.log(`${unparsable.length} unparsable as a module (reported, not counted): ${unparsable.slice(0, 3).map((item) => item.file).join(", ")}`);
  }
  console.log("");
  if (withTla.length === 0) {
    console.log("no module has a top-level await");
  } else {
    console.log(`TOP-LEVEL AWAIT IN ${withTla.length} MODULE(S)`);
    for (const [file, found] of withTla) {
      const who = importers.get(file) ?? [];
      console.log(
        `  ${relative(root, file)}  line ${found.lines.join(",")}  ${who.length === 0 ? "imported by nothing" : `imported by ${who.map((item) => `${item.file}:${item.line}`).join(", ")}`}`,
      );
    }
  }
}
