/**
 * Dead-module guard: nothing under `src/` may be reachable only from a test, or from nothing at all.
 *
 * **Why this exists.** P0-6 was a 227-line protocol (`src/runtime/envelope.ts`), an 84-line preset integration
 * (`src/shims/presets.ts`) and a production dependency (`unenv`) that together had **zero** production callers and
 * **zero** bytes in the built bundle, and the tree carried them for five days while two of them advertised themselves
 * as the runtime's boundary. The register called that state "the worst of the three". Nothing caught it, because every
 * gate this project has asks whether the code that exists works; none asked whether anything calls it. A test file is
 * enough to keep a module compiling, importing and green forever without a single product consumer, which is exactly
 * how it happened.
 *
 * **What it measures.** For every `.ts` file under `src/`, it counts the modules that import it, split by lane:
 * `src/` (production), `tools/` (build, harness, probes: real consumers, never shipped) and `tests/` (the lane that
 * must never be the only reason a module exists). A module with no `src/` and no `tools/` consumer is either
 * `test-only` (a test is its whole audience) or `orphan` (nothing is). Both fail the guard unless declared.
 *
 * **Why a declaration table rather than "just delete them".** Some modules legitimately have no importer: a Worker
 * entry or a build input is loaded by URL or by the bundler, not by `import`. Those are declared below with a reason.
 * A module that is genuinely dead but out of scope for the change that found it must be named in the work register
 * (`docs/audit/remaining-work.md`) rather than quietly listed here: every `known-stranded` declaration carries its register
 * id, so dead code cannot be parked in this file without a paper trail a reader can follow. The guard refuses a
 * `known-stranded` declaration that cites no register id.
 *
 * **What it deliberately does not do.** It does not resolve `node_modules`, package exports, path aliases or a
 * computed `require()` specifier: this tree uses relative ESM specifiers, and a guard that guessed would either miss
 * cases or cry wolf. It also does not inspect `dist/`; "is it in the bundle" is a different question, answered by
 * grepping a build, and a module can be bundled only because something test-only imported it.
 *
 * Pure except for the file walker, so the analyser is testable without writing to disk.
 */

import { readdirSync, readFileSync } from "node:fs";

/** Which lane imported a module. `tests` is the lane that cannot justify a module's existence. */
export interface Consumers {
  readonly src: readonly string[];
  readonly tools: readonly string[];
  readonly tests: readonly string[];
}

/** A module that has no consumer outside `tests/`, or none at all. */
export interface Stranded {
  readonly module: string;
  /** `test-only`: tests import it. `orphan`: nothing does. */
  readonly kind: "test-only" | "orphan";
  readonly tests: readonly string[];
}

/**
 * A module allowed to have no production consumer.
 *
 * `register` is mandatory for a stranded module and names a row in `docs/audit/remaining-work.md`, so parking something here
 * is always visible to whoever reads the register.
 */
export interface Declaration {
  readonly module: string;
  readonly kind: "entry" | "known-stranded";
  readonly reason: string;
  /** Register row (`W-37`), required for `known-stranded`. */
  readonly register?: string;
}

/**
 * Modules that legitimately have no importer, because a bundler or a Worker loads them by URL rather than by `import`,
 * plus the dead modules this change found but did not touch. Measured, not assumed: each entry's reason names the
 * mechanism, and the guard's test fails if a declaration points at a module that no longer exists.
 */
export const ENTRIES: readonly Declaration[] = [
  {
    module: "src/browser/entry.ts",
    kind: "entry",
    reason: "Vite build input for the page bundle (`npm run build:browser`); nothing imports the HTML entry.",
  },
  {
    module: "src/harness/index.ts",
    kind: "known-stranded",
    reason:
      "Barrel re-export of the harness. Every consumer deep-imports the module it needs, so the barrel has no reader. Not one of P0-6's three artefacts, so registered rather than deleted.",
    register: "W-37",
  },
  {
    module: "src/harness/command.ts",
    kind: "known-stranded",
    reason:
      "Step-command parser reached only from tests and from `execute.ts` (itself stranded). The harness CLI plans commands in `tools/harness/fixture-executor.ts` instead, so the tested parser is not the parser that runs fixtures.",
    register: "W-37",
  },
  {
    module: "src/harness/execute.ts",
    kind: "known-stranded",
    reason:
      "`createStepExecutor`, the harness's step executor, reached only from tests. `tools/harness/fixture-executor.ts` builds its own `ExecuteStep`, so the CLI never calls this one. This is the W-26 shape exactly: a tested subsystem the product path does not use.",
    register: "W-37",
  },
  {
    module: "src/harness/scripts.ts",
    kind: "known-stranded",
    reason:
      "package.json script and bin resolution, reached only from `tests/unit/harness.scripts.test.ts`; the CLI path resolves through the container instead.",
    register: "W-37",
  },
  {
    module: "src/network/service-worker.ts",
    kind: "known-stranded",
    reason:
      "Request/Response function used only by tests; the served `/preview-sw.js` is a hand-written file in `public/`, not built from this module. Registered so the divergence is visible instead of assumed wired.",
    register: "W-37",
  },
  {
    module: "src/network/sw-bridge.ts",
    kind: "known-stranded",
    reason:
      "Service-worker/page bridge of the same shape: exercised by tests only, while the shipped service worker carries its own copy of the correlation logic.",
    register: "W-37",
  },
  {
    module: "src/process/base64.ts",
    kind: "known-stranded",
    reason:
      "Superseded by `src/process/frame.ts`, which removed base64 from the wire; nothing imports it, not even a test. Registered rather than deleted because removal is outside P0-6.",
    register: "W-37",
  },
];

/**
 * Import forms that create a real dependency: `from "..."`, a side-effect `import "..."`, a dynamic `import("...")`,
 * and the `new URL("./worker.ts", import.meta.url)` form a bundler uses for a Worker entry. Side-effect imports are
 * included because they are dependencies like any other; a test that only ran a module for its side effect is still
 * the module's whole audience.
 */
const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+|new\s+URL\(\s*)["'](\.[^"']+)["']/gu;

/** `.js` in a specifier means `.ts` on disk, which is the only rewrite this tree needs. */
const candidates = (fromFile: string, specifier: string): string[] => {
  const base = resolvePath(dirOf(fromFile), specifier);
  const withoutExtension = base.replace(/\.(?:js|mjs|ts)$/u, "");
  return [base, `${withoutExtension}.ts`, `${withoutExtension}/index.ts`];
};

const dirOf = (file: string): string => file.split("/").slice(0, -1).join("/");

/** Normalises `a/b/../c` and strips empty and `.` segments, without `node:path` so the analyser stays portable. */
function resolvePath(fromDir: string, specifier: string): string {
  const parts = `${fromDir}/${specifier}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Every module a file depends on, resolved against the file set it is given.
 *
 * A specifier that resolves to nothing is dropped rather than reported: a broken import is `tsc`'s finding, and this
 * guard reporting it too would double up on a gate that already fails the build.
 */
export function dependenciesOf(file: string, source: string, known: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    for (const candidate of candidates(file, specifier)) {
      if (known.has(candidate)) {
        out.add(candidate);
        break;
      }
    }
  }
  out.delete(file); // a module that imports itself is not a consumer
  return out;
}

/**
 * Maps each module to its importers, by lane.
 *
 * `lanes` is a map from lane name to that lane's files, so a test can pass a synthetic tree and the CLI can pass the
 * real one without this function knowing which is which.
 */
export function collectConsumers(lanes: Readonly<Record<string, ReadonlyMap<string, string>>>): Map<string, Consumers> {
  const known = new Set<string>();
  for (const files of Object.values(lanes)) for (const file of files.keys()) known.add(file);

  const importers = new Map<string, { src: string[]; tools: string[]; tests: string[] }>();
  for (const [lane, files] of Object.entries(lanes)) {
    if (lane !== "src" && lane !== "tools" && lane !== "tests") continue;
    for (const [file, source] of files) {
      for (const dependency of dependenciesOf(file, source, known)) {
        const bucket = importers.get(dependency) ?? { src: [], tools: [], tests: [] };
        bucket[lane].push(file);
        importers.set(dependency, bucket);
      }
    }
  }

  const consumers = new Map<string, Consumers>();
  for (const module of known) {
    const bucket = importers.get(module) ?? { src: [], tools: [], tests: [] };
    consumers.set(module, {
      src: [...bucket.src].sort(),
      tools: [...bucket.tools].sort(),
      tests: [...bucket.tests].sort(),
    });
  }
  return consumers;
}

/**
 * Every src module reachable from a real consumer, following `src/` imports transitively.
 *
 * `roots` are the modules something outside `src/` actually uses: each declared entry, plus every module a `tools/`
 * module imports. Everything those reach is live; everything else is not. Transitively, because P0-6 was a CHAIN:
 * `envelope.ts` had a `src/` importer, so a one-hop "does anything in src import me" check called it live while the
 * importer itself was reachable only from a test. A single hop shades exactly the case the guard exists for.
 */
export function reachableFrom(consumers: ReadonlyMap<string, Consumers>, roots: Iterable<string>): Set<string> {
  // Reverse index: module -> the src modules that import it.
  const importedBy = new Map<string, string[]>();
  for (const [module, seen] of consumers) {
    for (const importer of seen.src) {
      const list = importedBy.get(importer) ?? [];
      list.push(module);
      importedBy.set(importer, list);
    }
  }

  const live = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const module = queue.pop() as string;
    if (live.has(module)) continue;
    live.add(module);
    for (const dependency of importedBy.get(module) ?? []) if (!live.has(dependency)) queue.push(dependency);
  }
  return live;
}

/**
 * The guard's judgement.
 *
 * A src module is live when it is reachable from a declared entry or from a module under `tools/`; that closure is
 * computed over `src/` imports, so a module behind a dead module is dead too. A module outside the closure is
 * `test-only` (tests import it) or `orphan` (nothing does). Declared modules are exempt.
 *
 * Only `src/` is judged. A file under `tools/` is a CLI: `tools/verify/deployment.ts` and every `probe-*.ts` are
 * executed by an npm script, so "nothing imports it" is the normal, correct state for them, and judging them here
 * would make the guard cry wolf until someone disabled it.
 */
export function findStranded(
  consumers: ReadonlyMap<string, Consumers>,
  declared: readonly Declaration[] = ENTRIES,
  scope = "src/",
): Stranded[] {
  const roots = new Set<string>(declared.filter((entry) => entry.kind === "entry").map((entry) => entry.module));
  for (const [module, seen] of consumers) if (seen.tools.length > 0) roots.add(module);

  const live = reachableFrom(consumers, roots);
  const exempt = new Set(declared.map((entry) => entry.module));
  const findings: Stranded[] = [];

  for (const [module, seen] of consumers) {
    if (!module.startsWith(scope)) continue;
    if (exempt.has(module) || live.has(module)) continue;
    findings.push({ module, kind: seen.tests.length > 0 ? "test-only" : "orphan", tests: seen.tests });
  }
  return findings.sort((a, b) => a.module.localeCompare(b.module));
}

/** A declaration that needs a register row and carries none, or names a module that is not there. */
export function problemsWithDeclarations(
  consumers: ReadonlyMap<string, Consumers>,
  declared: readonly Declaration[] = ENTRIES,
): string[] {
  const problems: string[] = [];
  for (const entry of declared) {
    if (entry.kind === "known-stranded" && (entry.register ?? "").trim() === "") {
      problems.push(`${entry.module}: a known-stranded declaration must cite a register row`);
    }
    if (!consumers.has(entry.module)) problems.push(`${entry.module}: declared, but no such module exists`);
    if (entry.reason.trim() === "") problems.push(`${entry.module}: declared without a reason`);
  }
  return problems;
}

/** Every `.ts` file under `root`, keyed by repo-relative path so findings are copy-pasteable. */
export function collectLane(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.set(full, readFileSync(full, "utf8"));
      }
    }
  };
  walk(root.replace(/^\.\//u, "").replace(/\/+$/u, ""));
  return files;
}
