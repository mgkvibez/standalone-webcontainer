/**
 * ES modules, reduced to the CommonJS shape this loader already dispatches (ADR-0012).
 *
 * Why transform rather than `import()`: the loader compiles a string with `new Function`, and native `import` is not
 * available there. Real dynamic import of blob and data URLs also resolves bare specifiers against the *browser's*
 * rules, not our VFS, so the same source would resolve differently in a test and in a preview. A transform keeps one
 * resolution path: every import becomes a `require` through the loader that already walks node_modules in our VFS.
 *
 * What this does NOT give you, deliberately and visibly: live bindings (an exported `let` is a snapshot at export
 * time), and top-level await (refused with a specific message rather than silently mis-executed). Both are recorded in
 * ADR-0012 as limits, because a code path that looks like it works and quietly does the wrong thing is worse here than
 * an explicit refusal.
 */

import { parse } from "acorn";

export class EsmSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsmSyntaxError";
  }
}

export interface EsmTransformOptions {
  /** What `import.meta.url` reports. Node uses a file:// URL, so callers pass one. */
  readonly url: string;
}

export interface EsmTransformResult {
  /** CommonJS-compatible source that the loader can compile in the same factory as any other module. */
  readonly code: string;
  /** Specifiers this module imports, for diagnostics and for a future static dependency graph. */
  readonly specifiers: readonly string[];
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

/** Depth-first walk that tracks how many functions we are inside, which is how top-level await is detected. */
function walk(node: AstNode, visit: (node: AstNode, functionDepth: number) => void, functionDepth = 0): void {
  visit(node, functionDepth);

  const entersFunction =
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "MethodDefinition";

  const nextDepth = entersFunction ? functionDepth + 1 : functionDepth;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit, nextDepth);
    } else if (isNode(child)) {
      walk(child, visit, nextDepth);
    }
  }
}

function nameOf(node: unknown, what: string): string {
  if (isNode(node) && node.type === "Identifier" && typeof node["name"] === "string") return node["name"];
  throw new EsmSyntaxError(`${what} uses a form this transform does not support (destructuring or computed names)`);
}

/** Names bound by a declaration, for emitting `exports.x = x` after it. */
function declaredNames(declaration: AstNode): readonly string[] {
  if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
    return [nameOf(declaration["id"], declaration.type)];
  }
  if (declaration.type === "VariableDeclaration") {
    const declarators = declaration["declarations"];
    if (!Array.isArray(declarators)) throw new EsmSyntaxError("unreadable variable declaration");
    return declarators.map((declarator) => {
      if (!isNode(declarator)) throw new EsmSyntaxError("unreadable declarator");
      return nameOf(declarator["id"], "export const");
    });
  }
  throw new EsmSyntaxError(`export ${declaration.type} is not supported`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function transformEsm(source: string, options: EsmTransformOptions): EsmTransformResult {
  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      locations: false,
    }) as unknown as AstNode;
  } catch (error) {
    throw new EsmSyntaxError(`could not parse ES module: ${error instanceof Error ? error.message : String(error)}`);
  }

  const edits: Edit[] = [];
  const specifiers: string[] = [];
  let counter = 0;
  const temp = (): string => `__esmTmp${(counter += 1)}`;

  walk(program, (node, functionDepth) => {
    if (node.type === "AwaitExpression" && functionDepth === 0) {
      throw new EsmSyntaxError(
        "top-level await is not supported by this loader yet (ADR-0012); move the await inside an async function",
      );
    }

    if (node.type === "MetaProperty") {
      edits.push({ start: node.start, end: node.end, text: "__importMeta" });
      return;
    }

    if (node.type === "ImportExpression") {
      // acorn 8 parses `import("x")` as ImportExpression, so this is the shape that actually fires. Only the keyword
      // is replaced; the argument list is left exactly as written, including any computed specifier.
      edits.push({ start: node.start, end: node.start + "import".length, text: "__dynamicImport" });
      return;
    }

    if (node.type === "CallExpression" && isNode(node["callee"]) && node["callee"].type === "Import") {
      edits.push({ start: node["callee"].start, end: node["callee"].end, text: "__dynamicImport" });
      return;
    }

    if (node.type === "ImportDeclaration") {
      const sourceNode = node["source"];
      const source_ = isNode(sourceNode) && typeof sourceNode["value"] === "string" ? sourceNode["value"] : undefined;
      if (source_ === undefined) throw new EsmSyntaxError("import without a string specifier");
      specifiers.push(source_);

      const specifierNodes = node["specifiers"];
      const list = Array.isArray(specifierNodes) ? specifierNodes : [];
      const lines: string[] = [];

      let namespaceLocal: string | null = null;
      let defaultLocal: string | null = null;
      const named: { imported: string; local: string }[] = [];

      for (const specifier of list) {
        if (!isNode(specifier)) continue;
        if (specifier.type === "ImportNamespaceSpecifier") namespaceLocal = nameOf(specifier["local"], "import * as");
        else if (specifier.type === "ImportDefaultSpecifier") defaultLocal = nameOf(specifier["local"], "import");
        else if (specifier.type === "ImportSpecifier") {
          named.push({ imported: nameOf(specifier["imported"], "import { }"), local: nameOf(specifier["local"], "import { }") });
        }
      }

      const needsModule = defaultLocal !== null && named.length > 0;
      const moduleVar = needsModule ? temp() : null;
      if (moduleVar !== null) lines.push(`const ${moduleVar} = require(${quote(source_)});`);
      else if (list.length === 0) lines.push(`require(${quote(source_)});`);

      if (defaultLocal !== null) {
        lines.push(
          needsModule
            ? `const ${defaultLocal} = __esmInterop(${moduleVar as string});`
            : `const ${defaultLocal} = __esmInterop(require(${quote(source_)}));`,
        );
      }
      if (namespaceLocal !== null) {
        lines.push(`const ${namespaceLocal} = require(${quote(source_)});`);
      }
      if (named.length > 0) {
        const source2 = moduleVar ?? `require(${quote(source_)})`;
        const bound = moduleVar === null ? temp() : moduleVar;
        if (moduleVar === null) lines.push(`const ${bound} = ${source2};`);
        for (const { imported, local } of named) {
          lines.push(`const ${local} = ${bound}[${quote(imported)}];`);
        }
      }

      edits.push({ start: node.start, end: node.end, text: lines.join(" ") });
      return;
    }

    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node["declaration"];
      if (!isNode(declaration)) throw new EsmSyntaxError("unreadable default export");

      const named = declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration";
      const idNode = declaration["id"];
      if (named && isNode(idNode) && idNode.type === "Identifier") {
        // Keep the declaration, drop the keyword, then export the name.
        edits.push({ start: node.start, end: declaration.start, text: "" });
        edits.push({ start: node.end, end: node.end, text: ` exports.default = ${nameOf(idNode, "export default")};` });
      } else {
        edits.push({ start: node.start, end: declaration.start, text: "exports.default = " });
      }
      return;
    }

    if (node.type === "ExportNamedDeclaration") {
      const declaration = node["declaration"];
      const sourceNode = node["source"];
      const from =
        isNode(sourceNode) && typeof sourceNode["value"] === "string" ? (sourceNode["value"] as string) : undefined;
      const specifierNodes = node["specifiers"];
      const specifiers = Array.isArray(specifierNodes) ? specifierNodes : [];

      if (isNode(declaration)) {
        // export function f(){} / export const a = 1 -> keep the declaration, export each name after it.
        edits.push({ start: node.start, end: declaration.start, text: "" });
        const names = declaredNames(declaration);
        edits.push({ start: node.end, end: node.end, text: names.map((name) => ` exports.${name} = ${name};`).join("") });
        return;
      }

      const assignments: string[] = [];
      if (from !== undefined) {
        // export { a, b as c } from "x": bind the source module once, then copy each name across.
        const moduleVar = temp();
        assignments.push(`const ${moduleVar} = require(${quote(from)});`);
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const imported = nameOf(specifier["local"], "re-export");
          const exportedName = nameOf(specifier["exported"] ?? specifier["local"], "re-export");
          assignments.push(`exports.${exportedName} = ${moduleVar}[${quote(imported)}];`);
        }
      } else {
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const local = nameOf(specifier["local"], "export { }");
          const exported = nameOf(specifier["exported"] ?? specifier["local"], "export { }");
          assignments.push(`exports.${exported} = ${local};`);
        }
      }
      edits.push({ start: node.start, end: node.end, text: assignments.join(" ") });
      return;
    }

    if (node.type === "ExportAllDeclaration") {
      const sourceNode = node["source"];
      const from = isNode(sourceNode) && typeof sourceNode["value"] === "string" ? "sourceNode" : undefined;
      if (from === undefined) throw new EsmSyntaxError("export * without a string specifier");
      const value = (sourceNode as AstNode)["value"] as string;
      const moduleVar = temp();
      edits.push({
        start: node.start,
        end: node.end,
        text:
          `const ${moduleVar} = require(${quote(value)}); ` +
          `for (const __k of Object.keys(${moduleVar})) { if (__k !== "default" && __k !== "__esModule") exports[__k] = ${moduleVar}[__k]; }`,
      });
      return;
    }
  });

  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let body = source;
  let cursor = Number.MAX_SAFE_INTEGER;
  for (const edit of ordered) {
    if (edit.end > cursor) continue; // overlapping edit, keep the outermost
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
    cursor = edit.start;
  }

  const prelude = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    `const __importMeta = { url: ${quote(options.url)} };`,
    "const __dynamicImport = (spec) => Promise.resolve(require(spec));",
    "const __esmInterop = (m) => (m && m.__esModule ? m.default : m);",
  ].join("\n");

  return { code: `${prelude}\n${body}`, specifiers };
}
