/**
 * ES modules, reduced to the CommonJS shape this loader already dispatches (ADR-0012).
 *
 * Why transform rather than `import()`: the loader compiles a string with `new Function`, and native `import` is not
 * available there. Real dynamic import of blob and data URLs also resolves bare specifiers against the *browser's*
 * rules, not our VFS, so the same source would resolve differently in a test and in a preview. A transform keeps one
 * resolution path: every import becomes a `require` through the loader that already walks node_modules in our VFS.
 *
 * What this still does NOT give you: live bindings (an exported `let` is a snapshot at export time), recorded in ADR-0012 as a
 * limit because a code path that looks like it works and quietly does the wrong thing is worse than an explicit refusal.
 *
 * Top-level await used to be refused here. It is now *detected* and reported through `hasTopLevelAwait`, and the loader decides
 * what to do with it: a module that needs it is evaluated asynchronously, while a synchronous `require` of that module refuses
 * with Node's own `ERR_REQUIRE_ASYNC_MODULE`. Detection lives in the transform because the transform is what already walks the
 * syntax tree; whether evaluation can be async is the loader's business, not the parser's.
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
  /**
   * True when the module's *own* body awaits outside any function, which makes its evaluation asynchronous.
   *
   * The loader needs this before it compiles: `await` inside the CommonJS factory shape is a SyntaxError, so the body has to be
   * wrapped in an async arrow, and every caller has to know the module settled later than its `require` returned.
   */
  readonly hasTopLevelAwait: boolean;
  /**
   * Names this module binds LEXICALLY at its own top level, including the locals an import turns into.
   *
   * The loader needs this to decide which injected parameters to omit, and it is reported from here because the transform is the only
   * thing that actually knows. Recovering it from the generated text was wrong twice on real bytes: it missed a binding when the
   * scrubber mistook part of vite's `cli.js` for a template literal, and it treated declarations inside nested functions as if they
   * were the module's own. Only lexical declarations collide with a parameter (`let`, `const`, `class`, import bindings); `var` and
   * `function` reuse the parameter's slot, which is why they are absent.
   */
  readonly topLevelBindings: readonly string[];
  /**
   * The three names the generated code expects the loader to bind, after mangling.
   *
   * They are not constants, and that is the point. Every fixed name in the prologue is a name a module may legitimately declare:
   * vite's bundled chunk does `const require = createRequire(import.meta.url)` and `const __require = require` within its first
   * sixty lines, so a prologue that called either name threw "Cannot access 'require' before initialization" from inside the
   * module's own temporal dead zone. The names below are checked against the module's source and suffixed until none of them occurs
   * in it, which makes a collision impossible rather than unlikely.
   */
  readonly injected: {
    readonly exports: string;
    readonly require: string;
    readonly loadModuleAsync: string;
  };
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

/**
 * Every name a binding pattern introduces: `a`, `{ a }`, `{ a: b }`, `[a]`, `a = 1`, `...a`, and their nestings.
 *
 * Each one is a lexical binding, so each one is a SyntaxError if an injected parameter has the same name.
 */
function boundNames(pattern: unknown, into: string[]): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      if (typeof pattern["name"] === "string") into.push(pattern["name"]);
      return;
    case "ObjectPattern": {
      const properties = pattern["properties"];
      if (Array.isArray(properties)) {
        for (const property of properties) {
          if (!isNode(property)) continue;
          // A Property holds its binding in `value`; a RestElement (`...rest`) holds it in `argument`.
          boundNames(property.type === "Property" ? property["value"] : property["argument"], into);
        }
      }
      return;
    }
    case "ArrayPattern": {
      const elements = pattern["elements"];
      if (Array.isArray(elements)) for (const element of elements) boundNames(element, into);
      return;
    }
    case "AssignmentPattern":
      boundNames(pattern["left"], into);
      return;
    case "RestElement":
      boundNames(pattern["argument"], into);
      return;
    default:
      return;
  }
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
  let hasTopLevelAwait = false;
  const topLevelBindings: string[] = [];
  const temp = (): string => `__esmTmp${(counter += 1)}`;

  walk(program, (node, functionDepth) => {
    // Lexical declarations at the module's own level, which a parameter cannot coexist with. `var` and `function` are deliberately
    // absent: both share the parameter's slot instead of colliding with it.
    if (functionDepth === 0) {
      if (node.type === "VariableDeclaration" && node["kind"] !== "var") {
        const declarators = node["declarations"];
        if (Array.isArray(declarators)) {
          for (const declarator of declarators) {
            if (isNode(declarator)) boundNames(declarator["id"], topLevelBindings);
          }
        }
      } else if (node.type === "ClassDeclaration") {
        boundNames(node["id"], topLevelBindings);
      }
    }

    if (functionDepth === 0) {
      // `for await` is await at module scope without an AwaitExpression node, so it needs naming explicitly. acorn sets
      // `await: true` on a ForOfStatement written that way.
      if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node["await"] === true)) {
        hasTopLevelAwait = true;
        return;
      }
    }

    if (node.type === "MetaProperty") {
      edits.push({ start: node.start, end: node.end, text: "__esmImportMeta" });
      return;
    }

    if (node.type === "ImportExpression") {
      // acorn 8 parses `import("x")` as ImportExpression, so this is the shape that actually fires. Only the keyword
      // is replaced; the argument list is left exactly as written, including any computed specifier.
      edits.push({ start: node.start, end: node.start + "import".length, text: "__esmDynamicImport" });
      return;
    }

    if (node.type === "CallExpression" && isNode(node["callee"]) && node["callee"].type === "Import") {
      edits.push({ start: node["callee"].start, end: node["callee"].end, text: "__esmDynamicImport" });
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

      // The locals an import introduces are lexical bindings of this module, so they collide with an injected parameter exactly as a
      // `const` does. This is the case that broke vite's cli.js: `import { performance } from 'node:perf_hooks'` becomes
      // `const performance = ...`, which cannot coexist with a `performance` parameter.
      for (const local of [namespaceLocal, defaultLocal, ...named.map((entry) => entry.local)]) {
        if (local !== null) topLevelBindings.push(local);
      }

      const needsModule = defaultLocal !== null && named.length > 0;
      const moduleVar = needsModule ? temp() : null;
      if (moduleVar !== null) lines.push(`const ${moduleVar} = __esmRequire(${quote(source_)});`);
      else if (list.length === 0) lines.push(`__esmRequire(${quote(source_)});`);

      if (defaultLocal !== null) {
        lines.push(
          needsModule
            ? `const ${defaultLocal} = __esmInterop(${moduleVar as string});`
            : `const ${defaultLocal} = __esmInterop(__esmRequire(${quote(source_)}));`,
        );
      }
      if (namespaceLocal !== null) {
        lines.push(`const ${namespaceLocal} = __esmRequire(${quote(source_)});`);
      }
      if (named.length > 0) {
        const source2 = moduleVar ?? `__esmRequire(${quote(source_)})`;
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
        edits.push({ start: node.end, end: node.end, text: ` __esmExports.default = ${nameOf(idNode, "export default")};` });
      } else {
        edits.push({ start: node.start, end: declaration.start, text: "__esmExports.default = " });
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
        edits.push({ start: node.end, end: node.end, text: names.map((name) => ` __esmExports.${name} = ${name};`).join("") });
        return;
      }

      const assignments: string[] = [];
      if (from !== undefined) {
        // export { a, b as c } from "x": bind the source module once, then copy each name across.
        const moduleVar = temp();
        assignments.push(`const ${moduleVar} = __esmRequire(${quote(from)});`);
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const imported = nameOf(specifier["local"], "re-export");
          const exportedName = nameOf(specifier["exported"] ?? specifier["local"], "re-export");
          assignments.push(`__esmExports.${exportedName} = ${moduleVar}[${quote(imported)}];`);
        }
      } else {
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const local = nameOf(specifier["local"], "export { }");
          const exported = nameOf(specifier["exported"] ?? specifier["local"], "export { }");
          assignments.push(`__esmExports.${exported} = ${local};`);
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
          `const ${moduleVar} = __esmRequire(${quote(value)}); ` +
          `for (const __k of Object.keys(${moduleVar})) { if (__k !== "default" && __k !== "__esModule") __esmExports[__k] = ${moduleVar}[__k]; }`,
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

  // Two names in the generated prologue are deliberately not the obvious ones. `__esmRequire` rather than `require`, because an ES
  // module is free to declare its own `const require = createRequire(import.meta.url)` (vite's bundled chunk does), and that lexical
  // binding is in its temporal dead zone while the prologue resolves imports: the emitted `require(...)` calls would throw
  // "Cannot access 'require' before initialization" before a line of the module ran. Same reasoning for `__esmExports` below.
  //
  // Every assignment this transform emits targets `__esmExports`, which the loader binds to the module's exports object, and NOT
  // `exports`. That is not cosmetic: real ESM has no `exports` at all, so a module is free to declare one for itself, and vite's
  // `dist/node/chunks/dep-BK3b2jBa.js` does exactly that (`var exports = { ".": { ... } }` at top level, its own package.json inside
  // the bundle). Writing our exports into that variable would have silently lost every export declared after it.
  const prelude = [
    '"use strict";',
    'Object.defineProperty(__esmExports, "__esModule", { value: true });',
    `const __esmImportMeta = { url: ${quote(options.url)} };`,
    // `import()` must await a target whose own evaluation is asynchronous, which a synchronous `require` cannot do. The loader
    // injects the async entry point, so both spellings of dynamic import share one path.
    "const __esmDynamicImport = (spec) => __esmLoadModuleAsync(spec);",
    "const __esmInterop = (m) => (m && m.__esModule ? m.default : m);",
  ].join("\n");

  // Somewhere for the mangler to put a suffix, then out.
  return finish();

  /**
   * Pick a suffix that makes every internal name absent from the module's own source, then apply it.
   *
   * The suffix is chosen so that no internal name occurs in the module's SOURCE, and the substitution is then applied to the whole
   * generated text. So in the ordinary case (no suffix, nothing substituted) the module's text is untouched, and in the rare case a module
   * binds one of these names for itself, that binding is renamed consistently with ours: every occurrence in the text is rewritten the
   * same way, which is a safe rename of a local, not a collision. The remaining hazard is a module that both declares such a name and
   * passes it as a string key (`obj["__esmRequire"]`); it would be renamed too. That needs both to be true at once, and vite, rollup and
   * esbuild do neither. The fast path is the common case, and the loop is bounded by the number of names times the number of collisions.
   */
  function finish(): EsmTransformResult {
    const internals = [
      "__esmExports",
      "__esmRequire",
      "__esmInterop",
      "__esmImportMeta",
      "__esmDynamicImport",
      "__esmLoadModuleAsync",
      "__esmTmp",
    ] as const;
    let suffix = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!internals.some((name) => source.includes(`${name}${suffix}`))) break;
      suffix = String(attempt + 1);
    }
    const renamed = (name: string): string => `${name}${suffix}`;
    let code = `${prelude}\n${body}`;
    if (suffix !== "") {
      for (const name of internals) code = code.split(name).join(renamed(name));
    }
    return {
      code,
      specifiers,
      hasTopLevelAwait,
      topLevelBindings,
      injected: {
        exports: renamed("__esmExports"),
        require: renamed("__esmRequire"),
        loadModuleAsync: renamed("__esmLoadModuleAsync"),
      },
    };
  }
}
