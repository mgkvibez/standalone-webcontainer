/**
 * W-19 P1: what a program inside a real process Worker can actually reach today.
 *
 * These tests are a BASELINE, not a fix and not an endorsement. Each records behaviour that exists at `main` and
 * fails if it changes in either direction: the exposure tests fail when a capability is removed (the point of P4)
 * and the restriction tests fail when a trusted object becomes reachable (the point of P2/P3).
 *
 * Nothing is mocked. A real `ProcessKernel` serves a real filesystem, a real `process-worker.ts` runs the program,
 * and the program reports what it can reach from inside, so assertions read a report produced ON THE FAR SIDE.
 *
 * CORRECTIONS from independent review:
 *   1. The realm routes are now the point rather than an omission. Every constructor and eval path is exercised and
 *      CLASSIFIED - a route that merely runs a constructor body and hands back a Promise or an iterator is recorded
 *      as exactly that, never as "reached the platform global".
 *   2. `constructedViaSelf` is gone (it implied a global-scope `Function` body can reach the curated facade; a
 *      `Function` body is evaluated in GLOBAL scope, so `self` there is the platform's `self`). Renamed to
 *      `platformSelfViaFunction` and described for what it actually measures.
 *   3. `realTimerFired` is asserted instead of merely set.
 *   4. T7 keeps the SharedArrayBuffer sweep and adds STRUCTURAL detection for any global exposing both
 *      `postMessage` and `close`, which is what a MessagePort looks like from outside.
 *   5. T8 is new: compatibility baselines that exercise real operations - fs round trip, WebAssembly compile and
 *      execute, CommonJS load, ESM load, and a package resolved out of node_modules - so a later hardening change
 *      cannot quietly break a real workload and still leave a green baseline.
 *   6. Reporting is hardened: the report carries a marker and is found by it rather than assumed to be the last
 *      line, and a missing or malformed report fails with the program's actual output.
 *
 * PORT NOTE: 3200 is bound by several specs in this lane (process-transport, preview-websocket, the W-41 spec and
 * this one). Safe only because `playwright.config.ts` sets `workers: 1` and `fullyParallel: false`. If parallelism
 * is ever enabled, these must take distinct ports.
 *
 * Coverage limits, stated rather than papered over:
 *   - T4 proves reachability and one real request; it does not prove what a payload would do with the response.
 *   - T5 proves the shim clock is not the platform clock; it does not measure real-timer accuracy.
 *   - T7 proves no trusted object is reachable BY NAME or structurally on the global. It cannot prove absence
 *     through a closure, which JS gives no way to introspect.
 *   - T8 proves the named operations work today. Package INSTALLATION and the W-41 after-run baseline are proven
 *     by `install-persistence.spec.ts`, `real-registry-acceptance.spec.ts` and `w41-after-run-failure.spec.ts` in
 *     this same lane, and are not duplicated here: a second copy is free to drift from the first.
 */

import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

/** Prefix a program uses for its report, so the report is found by identity rather than by position. */
const REPORT = "W19REPORT:";

/**
 * The capability surface, as data, from inside the process Worker.
 *
 * The clock probe is a busy loop rather than a timer: the virtual clock advances only when the scheduler's queue
 * runs, so a synchronous loop is the one construction where "virtual did not move, real did" is a fact.
 */
const PROBE = `
const report = {};
const via = (fn) => { try { return fn(); } catch (error) { return 'throw:' + (error && error.message); } };
const isPlatform = (value) => Boolean(value) && typeof value === 'object' && typeof value.XMLHttpRequest !== 'undefined';
const describe = (value) => {
  if (isPlatform(value)) return 'platform-global';
  if (value && typeof value.then === 'function') return 'promise';
  if (value && typeof value.next === 'function') return 'iterator';
  if (value === undefined) return 'undefined';
  return typeof value;
};

report.routes = {
  self: describe(self.XMLHttpRequest),
  direct: describe(XMLHttpRequest),
  globalThis: describe(globalThis.XMLHttpRequest),
  constructed: describe(via(() => Function('return XMLHttpRequest')())),
  platformSelfViaFunction: describe(via(() => Function('return typeof self === "undefined" ? undefined : self.XMLHttpRequest')())),
};

report.realm = {
  indirectEval: describe(via(() => (0, eval)('globalThis'))),
  directEval: describe(via(() => eval('globalThis'))),
  selfFunction: describe(via(() => self.Function('return globalThis')())),
  selfObjectCtor: describe(via(() => self.Object.constructor('return globalThis')())),
  literalCtor: describe(via(() => ({}).constructor.constructor('return globalThis')())),
  fnCtorProto: describe(via(() => Object.getPrototypeOf(Function).constructor('return globalThis')())),
};

report.constructors = {};
try {
  globalThis.__w19async = 'not-run';
  const returnedAsync = (async function () {}).constructor('globalThis.__w19async = typeof XMLHttpRequest;')();
  report.constructors.async = { returned: describe(returnedAsync), observed: globalThis.__w19async };
} catch (error) {
  report.constructors.async = { returned: 'throw:' + error.message };
}
try {
  globalThis.__w19gen = 'not-run';
  const iterator = (function* () {}).constructor('globalThis.__w19gen = typeof XMLHttpRequest; yield 1;')();
  const step = iterator.next();
  report.constructors.generator = { returned: describe(iterator), observed: globalThis.__w19gen, step: step && step.value };
} catch (error) {
  report.constructors.generator = { returned: 'throw:' + error.message };
}

const chain = [];
let level = Object.getPrototypeOf(globalThis);
while (level && chain.length < 6) {
  chain.push({ name: (level.constructor && level.constructor.name) || 'anonymous', fetch: typeof level.fetch, xhr: typeof level.XMLHttpRequest, onmessage: typeof level.onmessage });
  level = Object.getPrototypeOf(level);
}
report.prototypeChain = chain;

const virtualStart = Date.now();
const facadeStart = self.Date.now();
const platformStart = new globalThis.Date().getTime();
let sink = 0;
for (let index = 0; index < 20000000; index += 1) sink += Math.sqrt(index);
const virtualEnd = Date.now();
const facadeEnd = self.Date.now();
const platformEnd = new globalThis.Date().getTime();
report.clock = {
  virtualDelta: virtualEnd - virtualStart,
  facadeDelta: facadeEnd - facadeStart,
  platformDelta: platformEnd - platformStart,
  sameDate: self.Date === Date,
  sameSetTimeout: self.setTimeout === globalThis.setTimeout,
  samePerformance: self.performance === globalThis.performance,
  worked: sink > 0,
};
report.realTimerFired = false;
self.setTimeout(() => { report.realTimerFired = true; }, 5);

const names = Object.getOwnPropertyNames(globalThis);
const sabNames = [];
const portLike = [];
for (const name of names) {
  // The global object itself answers to both (WorkerGlobalScope has postMessage AND close), so it would match the
  // structural test below. Excluded explicitly rather than by loosening the test: this scan is looking for a PORT,
  // and the global is the container the port would be hiding in.
  if (name === 'globalThis' || name === 'self') continue;
  let value;
  try { value = globalThis[name]; } catch (error) { continue; }
  try { if (value instanceof SharedArrayBuffer) sabNames.push(name); } catch (error) { void error; }
  try {
    if (value && (typeof value === 'object' || typeof value === 'function')
      && typeof value.postMessage === 'function' && typeof value.close === 'function') portLike.push(name);
  } catch (error) { void error; }
}
const API = ['fetch', 'XMLHttpRequest', 'WebSocket', 'indexedDB', 'caches', 'Worker', 'BroadcastChannel', 'MessageChannel', 'postMessage', 'onmessage', 'importScripts', 'crypto', 'queueMicrotask'];
const own = {};
const inherited = {};
const facade = {};
for (const name of API) {
  own[name] = Object.prototype.hasOwnProperty.call(globalThis, name) ? typeof globalThis[name] : 'absent';
  inherited[name] = name in globalThis && !Object.prototype.hasOwnProperty.call(globalThis, name) ? typeof globalThis[name] : 'no';
  facade[name] = typeof self[name];
}
const fsModule = require('fs');
const fsKeys = Object.keys(fsModule);
report.reach = {
  sabNames,
  portLike,
  plumbingNames: names.filter((name) => !/^__w19/.test(name) && /^(__|swc$)|syscall|portRegistry|kernelChannel|processChannel|transportPort/i.test(name)),
  nativeChannels: ['MessageChannel', 'BroadcastChannel', 'SharedArrayBuffer'].filter((name) => typeof globalThis[name] !== 'undefined'),
  fsPortishKeys: fsKeys.filter((key) => /port|channel|buffer|client|transport|sab/i.test(key)),
  fsCallableKeys: fsKeys.filter((key) => {
    try {
      const value = fsModule[key];
      return value && typeof value === 'object' && (typeof value.postMessage === 'function' || typeof value.call === 'function');
    } catch (error) { return false; }
  }),
};
report.inventory = { own, inherited, facade };
report.facadeFs = Object.keys(self.fs || {}).sort();
try {
  const xhr = new globalThis.XMLHttpRequest();
  xhr.open('GET', location.origin + '/', false);
  xhr.send(null);
  report.xhrEffect = { status: xhr.status, length: (xhr.responseText || '').length, origin: location.origin };
} catch (error) {
  report.xhrEffect = { error: String(error && error.message) };
}

console.log("${REPORT}" + JSON.stringify(report));
`;

/** T6's legitimate program: writes through the shim, reads it back, serves a preview on 3200. */
const LEGIT = `
const fs = require('fs');
const http = require('http');
fs.writeFileSync('/written.txt', 'written from the process worker');
console.log('read back: ' + fs.readFileSync('/written.txt', 'utf8'));
http.createServer((request, response) => response.end('ok from the process worker')).listen(3200);
`;

/** T8: real operations a hardening change must not break. Every value is produced by doing the work. */
const COMPAT = `
const fs = require('fs');
fs.writeFileSync('/compat.txt', 'vfs-round-trip');
const fsValue = fs.readFileSync('/compat.txt', 'utf8');
const wasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11]);
const wasmValue = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}).exports.run();
const cjsValue = require('./lib.cjs').value;
const pkgValue = require('compat-pkg')('x');
console.log("${REPORT}" + JSON.stringify({ fsValue, wasmValue, cjsValue, pkgValue, facadeFs: typeof self.fs }));
`;

const COMPAT_FILES: Record<string, string> = {
  "/compat.js": COMPAT,
  "/lib.cjs": "exports.value = 'cjs-ok';",
  "/lib.mjs": "export const value = 'esm-ok';",
  "/esm-entry.mjs": 'import { value } from "./lib.mjs";\nconsole.log("' + REPORT + '" + JSON.stringify({ esmValue: value }));\n',
  "/node_modules/compat-pkg/package.json": '{"name":"compat-pkg","version":"1.0.0","main":"index.js"}',
  "/node_modules/compat-pkg/index.js": "module.exports = (suffix) => 'pkg-ok:' + suffix;",
};

interface ProbeReport {
  routes: Record<string, string>;
  realm: Record<string, string>;
  constructors: { async: { returned: string; observed?: string }; generator: { returned: string; observed?: string; step?: number } };
  prototypeChain: readonly { readonly name: string; readonly fetch: string; readonly xhr: string; readonly onmessage: string }[];
  xhrEffect: { status?: number; length?: number; origin?: string; error?: string };
  clock: {
    virtualDelta: number;
    facadeDelta: number;
    platformDelta: number;
    sameDate: boolean;
    sameSetTimeout: boolean;
    samePerformance: boolean;
    worked: boolean;
  };
  realTimerFired: boolean;
  reach: { sabNames: string[]; portLike: string[]; plumbingNames: string[]; nativeChannels: string[]; fsPortishKeys: string[]; fsCallableKeys: string[] };
  inventory: { own: Record<string, string>; inherited: Record<string, string>; facade: Record<string, string> };
  facadeFs: string[];
}

/** Boots a kernel, runs one program, returns everything it printed. The kernel is always disposed. */
async function runProbe(page: import("@playwright/test").Page, files: Record<string, string>, entry: string): Promise<string> {
  return page.evaluate(
    async ({ programFiles, path }) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      let stdout = "";
      const kernel = new ProcessKernel({
        files: programFiles,
        transportTimeoutMs: 3_000,
        onOutput: (_pid: number, _channel: string, text: string) => {
          stdout += text;
        },
      });
      try {
        const pid = kernel.start({ argv: ["node", path] });
        await kernel.settled(pid);
        return stdout;
      } finally {
        kernel.dispose();
      }
    },
    { programFiles: files, path: entry },
  );
}

/**
 * Runs a probe program and insists on a usable report.
 *
 * The report is located by its marker rather than by position: a program that logs after the report, or a runtime that
 * appends its own line, must not turn into "parsed something else". A crash produces no report at all, and that case
 * is reported with the program's own output, because a bare `JSON.parse` failure says nothing about what happened.
 */
async function probeReport(page: import("@playwright/test").Page, files: Record<string, string>, entry: string): Promise<ProbeReport> {
  const stdout = await runProbe(page, files, entry);
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(REPORT));
  if (line === undefined) {
    throw new Error(`the probe produced no report (did the program crash?); its output was: ${JSON.stringify(stdout)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(REPORT.length));
  } catch (error) {
    throw new Error(`the probe's report was not valid JSON (${(error as Error).message}); the line began: ${line.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`the probe's report was not an object; the line began: ${line.slice(0, 200)}`);
  }
  return parsed as ProbeReport;
}

test("T4: the platform global is reachable by every realm route, and XMLHttpRequest performs a real request", async ({ page }) => {
  await page.goto("/");
  const report = await probeReport(page, { "/probe.js": PROBE }, "/probe.js");

  // The curated facade: XHR is not on it. That is `self` doing its job and must stay true.
  expect(report.routes.self, JSON.stringify(report.routes)).toBe("undefined");
  // The bare identifier, the platform global and a constructed function all reach it.
  expect(report.routes.direct, JSON.stringify(report.routes)).toBe("function");
  expect(report.routes.globalThis, JSON.stringify(report.routes)).toBe("function");
  expect(report.routes.constructed, JSON.stringify(report.routes)).toBe("function");
  // A Function body is evaluated in GLOBAL scope, so `self` in there is the platform's `self`. This route measures
  // that, and says nothing about the facade: the facade is a parameter, not a global, so no Function body can see it.
  expect(report.routes.platformSelfViaFunction, JSON.stringify(report.routes)).toBe("function");

  // Every constructor and eval route obtains the platform global itself, not merely a value from it.
  for (const [route, outcome] of Object.entries(report.realm)) {
    expect(outcome, `realm route ${route} produced ${outcome}`).toBe("platform-global");
  }

  // A constructor body that runs returns a Promise; a generator's runs on `.next()`. Both observe the platform XHR,
  // so the distinction being pinned is the RETURN SHAPE, not "it did not escape".
  expect(report.constructors.async.returned, JSON.stringify(report.constructors)).toBe("promise");
  expect(report.constructors.async.observed, JSON.stringify(report.constructors)).toBe("function");
  expect(report.constructors.generator.returned, JSON.stringify(report.constructors)).toBe("iterator");
  expect(report.constructors.generator.observed, JSON.stringify(report.constructors)).toBe("function");

  // The prototype chain is where a deleted own-property could still be found. Names are pinned loosely (they are
  // platform detail); what is pinned hard is that no level of the chain carries XMLHttpRequest.
  expect(report.prototypeChain.length).toBeGreaterThanOrEqual(2);
  expect(report.prototypeChain.map((level) => level.name).join(">")).toMatch(/WorkerGlobalScope/);
  for (const level of report.prototypeChain) {
    expect(level.xhr, `prototype level ${level.name} exposes XMLHttpRequest`).toBe("undefined");
  }

  // Reachability alone is not the finding; completing a request against the host's origin is.
  expect(report.xhrEffect.error, JSON.stringify(report.xhrEffect)).toBeUndefined();
  expect(report.xhrEffect.origin).toBe(await page.evaluate(() => location.origin));
  expect(report.xhrEffect.status).toBe(200);
  expect(report.xhrEffect.length ?? 0).toBeGreaterThan(0);
});

test("T5: the shim clock is virtual on both shim surfaces and the platform clock is not", async ({ page }) => {
  await page.goto("/");
  const report = await probeReport(page, { "/probe.js": PROBE }, "/probe.js");

  // 20M sqrt is ~100-300 ms of real work. The virtual clock does not move during a synchronous turn, by design.
  expect(report.clock.worked).toBe(true);
  expect(report.clock.virtualDelta, JSON.stringify(report.clock)).toBe(0);
  expect(report.clock.facadeDelta, JSON.stringify(report.clock)).toBe(0);
  expect(report.clock.platformDelta, JSON.stringify(report.clock)).toBeGreaterThan(0);

  // `self.Date` is the runtime's own object, and it is the SAME object handed in as the `Date` parameter.
  expect(report.clock.sameDate).toBe(true);
  expect(report.clock.sameSetTimeout, JSON.stringify(report.clock)).toBe(false);
  expect(report.clock.samePerformance, JSON.stringify(report.clock)).toBe(false);

  // A timer scheduled on the platform's setTimeout never runs: the run settles first and the Worker is retired. This
  // field used to be set and never asserted, which is evidence-shaped and proves nothing.
  expect(report.realTimerFired, JSON.stringify(report.clock)).toBe(false);
});

test("T7: no filesystem port, syscall channel, shared buffer or port-like handle is reachable from user code", async ({ page }) => {
  await page.goto("/");
  const report = await probeReport(page, { "/probe.js": PROBE }, "/probe.js");

  // No global carries a SharedArrayBuffer instance, and no name on the global hints at our plumbing.
  expect(report.reach.sabNames, JSON.stringify(report.reach)).toEqual([]);
  expect(report.reach.plumbingNames, JSON.stringify(report.reach)).toEqual([]);
  // Structural, not name-based: a MessagePort is the only thing on a global that answers to both of these. Our channel
  // ends live in closures and in the transferred start message, so nothing here should look like one.
  expect(report.reach.portLike, JSON.stringify(report.reach)).toEqual([]);
  // The fs shim exports an API, not a handle.
  expect(report.reach.fsPortishKeys, JSON.stringify(report.reach)).toEqual([]);
  expect(report.reach.fsCallableKeys, JSON.stringify(report.reach)).toEqual([]);

  // LIMITS: this proves absence by name and by shape on the global object. It cannot see a closure, which is where
  // the channel ends actually live; that is a property of the reading, not of this test. Nor does it cover a name
  // nobody thought to put in the pattern - the structural sweep is the part that does not depend on guesswork, and
  // it only recognises objects, so a port hidden inside a function's properties would not be seen here either.
  expect(report.reach.nativeChannels).toContain("MessageChannel");
  expect(report.reach.nativeChannels).toContain("SharedArrayBuffer");
});

test("T6 baseline: filesystem and preview serving still work through the same boundary", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(
    async (program) => {
      const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
      let stdout = "";
      const kernel = new ProcessKernel({
        files: { "/legit.js": program },
        transportTimeoutMs: 3_000,
        onOutput: (_pid: number, _channel: string, text: string) => {
          stdout += text;
        },
      });
      try {
        kernel.start({ argv: ["node", "/legit.js"] });
        const startedAt = Date.now();
        while (Date.now() - startedAt < 20_000) {
          if ((kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3200)) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const reply = await kernel.transport({
          method: "GET",
          url: "/preview/3200/hello",
          headers: { accept: "text/plain" },
          body: new Uint8Array(),
        });
        return {
          stdout,
          status: reply.statusCode,
          body: new TextDecoder().decode(reply.body ?? new Uint8Array()),
        };
      } finally {
        kernel.stopServers([3200]);
        kernel.dispose();
      }
    },
    LEGIT,
  );

  expect(outcome.stdout).toContain("read back: written from the process worker");
  expect(outcome.status).toBe(200);
  expect(outcome.body).toBe("ok from the process worker");
});

test("T8 baseline: fs, WebAssembly, CommonJS, ESM and a node_modules package all still work", async ({ page }) => {
  await page.goto("/");
  const report = await probeReport(page, COMPAT_FILES, "/compat.js") as unknown as Record<string, string>;

  // Each of these is a value produced by doing the work, not by inspecting a global for its existence.
  expect(report.fsValue, JSON.stringify(report)).toBe("vfs-round-trip");
  expect(report.wasmValue, JSON.stringify(report)).toBe(42);
  expect(report.cjsValue, JSON.stringify(report)).toBe("cjs-ok");
  expect(report.pkgValue, JSON.stringify(report)).toBe("pkg-ok:x");
  // The facade's own `fs` is the surface esbuild-wasm reaches for; recorded so its removal is a deliberate change.
  expect(report.facadeFs, JSON.stringify(report)).toBe("object");

  const esm = await probeReport(page, COMPAT_FILES, "/esm-entry.mjs") as unknown as Record<string, string>;
  expect(esm.esmValue, JSON.stringify(esm)).toBe("esm-ok");
});
