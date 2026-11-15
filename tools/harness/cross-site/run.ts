/**
 * Cross-site service-worker harness.
 *
 * Answers one question the existing *.localhost lane cannot: does a browser allow a
 * service worker to be registered from a third-party iframe on a genuinely different
 * site, and does it then control requests? Every row records the topology it was run
 * under and asserts it, because the harness's first version accidentally measured
 * same-site attachment while claiming to measure cross-site.
 *
 * Deliberately outside `npm run verify`: it needs root (/etc/hosts, system trust
 * store), a CA installed per browser, and three browser engines.
 *
 *   sudo npm run test:browser:cross-site
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chromium, firefox, webkit } from "@playwright/test";
import { assertTopology, describeTopology, TopologyMismatchError, type TopologyRecord } from "./topology.js";
import {
  HarnessInfrastructureError,
  HOSTS,
  PORT,
  prepareBrowserTrust,
  printDiagnostics,
  startFixture,
  verifyHostsReserved,
  type Fixture,
} from "./infra.js";
import { ALL_HOSTS, assertUnprivileged, readState } from "./state.js";
import { STORAGE_KEY } from "./documents.js";

/** Pinned so a result is always attributable to an engine version. */
export const PINNED = { chromium: "158.0.8127.18", firefox: "159.0", webkit: "27.2" } as const;
type BrowserName = keyof typeof PINNED;

export const TRUST_PATH: Record<BrowserName, string> = {
  chromium: "NSS database ($HOME/.pki/nssdb) via certutil — the system bundle is not read by this build",
  firefox: "per-profile NSS database via certutil, launched with launchPersistentContext",
  webkit: "system bundle via update-ca-certificates",
};

interface CaseSpec {
  readonly id: string;
  readonly description: string;
  readonly topHost: string;
  readonly engineHost: string;
  readonly frameRelationship: "first-party" | "third-party-iframe";
  /** Whether this row gates on control + a worker-served request, or records them. */
  readonly assertsControl: boolean;
  readonly expect: {
    readonly sameSite: boolean;
    readonly crossOrigin: boolean;
    readonly laxCookieAttached: boolean | "n/a";
  };
}

export const CASES: readonly CaseSpec[] = [
  {
    id: "cross-site-third-party",
    description: "engine in a third-party iframe on a different registrable domain",
    topHost: HOSTS.app,
    engineHost: HOSTS.engine,
    frameRelationship: "third-party-iframe",
    assertsControl: true,
    expect: { sameSite: false, crossOrigin: true, laxCookieAttached: false },
  },
  {
    id: "same-site-third-party",
    description: "engine in a third-party iframe on the same registrable domain (design A's shape)",
    topHost: HOSTS.sameApp,
    engineHost: HOSTS.sameEngine,
    frameRelationship: "third-party-iframe",
    assertsControl: true,
    expect: { sameSite: true, crossOrigin: true, laxCookieAttached: true },
  },
  {
    id: "cross-site-first-party",
    description: "engine loaded top-level, no third-party context",
    topHost: HOSTS.engine,
    engineHost: HOSTS.engine,
    frameRelationship: "first-party",
    // Baseline row: registration is asserted, control is recorded. A top-level document is
    // only controlled once an active worker claims it, and engines differ on whether the
    // first navigation shows it (Firefox 159 does not here), so gating on it would report an
    // engine lifecycle difference as a failure of the thing this harness exists to measure.
    assertsControl: false,
    expect: { sameSite: true, crossOrigin: false, laxCookieAttached: "n/a" },
  },
];

type Status = "pass" | "refusal" | "infrastructure" | "harness-error";

interface CaseResult {
  browser: BrowserName;
  browserVersion: string;
  launchVariant: string;
  trustPath: string;
  caseId: string;
  status: Status;
  topology?: TopologyRecord | undefined;
  frameThirdParty?: boolean | undefined;
  registration?: string | undefined;
  control?: boolean | undefined;
  controlAfter?: string | undefined;
  navigationAttempts?: number;
  pageDiagnostics?: string[];
  workerServed?: boolean | undefined;
  cookiesSent?: string[] | null | undefined;
  embedderCookies?: string | undefined;
  sameOriginProbe?: unknown;
  cookieProbe?: Record<string, unknown> | undefined;
  storage?: Record<string, unknown> | undefined;
  detail?: string | undefined;
}

interface EngineReport {
  tag?: string;
  activation?: string;
  thirdParty?: boolean;
  storagePrior?: string | null;
  registration?: string;
  registrationDetail?: string;
  controlledBeforeWait?: boolean;
  control?: boolean;
  workerServed?: { servedBySw?: boolean };
  workerServedError?: string;
  ownCookie?: string;
  credentialedFetch?: { cookieHeader?: string | null; origin?: string | null; referer?: string | null; secFetchSite?: string | null };
  editorOrigin?: string;
  credentialedFetchError?: string;
}

function cookieNames(header: string | null | undefined): string[] {
  if (!header) return [];
  return header.split(";").map((part) => part.trim().split("=")[0] ?? "").filter(Boolean).sort();
}

async function openEngineReport(page: Page, inFrame: boolean): Promise<EngineReport> {
  if (inFrame) {
    await page.waitForFunction(() => Array.isArray((window as unknown as { findings?: unknown[] }).findings)
      && ((window as unknown as { findings: unknown[] }).findings.length > 0), null, { timeout: 40_000 });
    return page.evaluate(() => (window as unknown as { findings: EngineReport[] }).findings[0] as EngineReport);
  }
  await page.waitForFunction(() => Boolean((window as unknown as { __result?: unknown }).__result), null, { timeout: 40_000 });
  return page.evaluate(() => (window as unknown as { __result: EngineReport }).__result);
}

async function runCase(
  spec: CaseSpec,
  page: Page,
  fixture: Fixture,
  base: Omit<CaseResult, "caseId" | "status">,
): Promise<CaseResult> {
  const result: CaseResult = { ...base, caseId: spec.id, status: "pass" };
  const topUrl = `${fixture.origin(spec.topHost)}/`;

  try {
    await page.goto(topUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
  } catch (error) {
    return { ...result, status: "infrastructure", detail: `navigation failed: ${String((error as Error).message).split("\n")[0]}` };
  }

  try {
    // Topology is asserted from the case's own definitions, before any behaviour is recorded.
    result.topology = assertTopology(
      describeTopology(topUrl, `${fixture.origin(spec.engineHost)}/engine`, spec.frameRelationship),
      { sameSite: spec.expect.sameSite, crossOrigin: spec.expect.crossOrigin, frameRelationship: spec.frameRelationship },
    );
  } catch (error) {
    if (error instanceof TopologyMismatchError) return { ...result, status: "harness-error", detail: error.message };
    throw error;
  }

  const console_: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") console_.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => console_.push(`pageerror: ${String(error.message).split("\n")[0]}`));
  result.pageDiagnostics = console_;

  const inFrame = spec.frameRelationship === "third-party-iframe";
  let report: EngineReport;
  try {
    report = await openEngineReport(page, inFrame);
  } catch (firstError) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25_000 });
      report = await openEngineReport(page, inFrame);
      result.navigationAttempts = 2;
    } catch {
      return { ...result, status: "infrastructure", detail: `engine document never reported after two navigations: ${String((firstError as Error).message).split("\n")[0]}` };
    }
  }

  result.frameThirdParty = report.thirdParty;
  result.registration = report.registration;
  result.control = report.control;
  result.workerServed = report.workerServed?.servedBySw;
  result.cookiesSent = report.credentialedFetch ? cookieNames(report.credentialedFetch.cookieHeader) : null;
  if (inFrame) {
    result.embedderCookies = await page.evaluate(() => String((window as unknown as { embedderCookies?: string }).embedderCookies ?? ""));
    result.sameOriginProbe = await page.evaluate(() => (window as unknown as { sameOriginProbe?: unknown }).sameOriginProbe);
  }
  if (report.credentialedFetch) result.cookieProbe = report.credentialedFetch;
  result.storage = {
    priorInThisPartition: report.storagePrior,
    ownCookie: report.ownCookie ?? null,
  };

  // A third-party iframe that registers but never takes control within the bound is re-navigated
  // once: a fresh client of an already active worker is controlled immediately, which separates a
  // slow activation from a browser that will not control the frame at all.
  if (inFrame && report.registration === "accepted" && report.control !== true) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25_000 });
      const retried = await openEngineReport(page, true);
      if (retried.control === true) {
        report = { ...retried, registration: report.registration };
        result.control = retried.control;
        result.workerServed = retried.workerServed?.servedBySw;
        result.cookiesSent = retried.credentialedFetch ? cookieNames(retried.credentialedFetch.cookieHeader) : result.cookiesSent;
        if (retried.credentialedFetch) result.cookieProbe = retried.credentialedFetch;
        result.controlAfter = "reload";
      }
    } catch { /* reported below */ }
  }

  // A first-party document is not controlled until the fresh worker claims the client, and
  // engines differ on whether that lands on the first navigation (Firefox does not). One
  // reload is the standard lifecycle step, so the first-party row takes it deliberately and
  // records that it did, instead of pretending a first load must already be controlled.
  if (!inFrame && report.registration === "accepted") {
    try {
      // A fresh client in the same context, rather than a reload: an active worker with
      // scope "/" controls a new document immediately, and it avoids the reload path
      // restoring a prior document in some engines.
      const controlPage = await page.context().newPage();
      await controlPage.goto(`${fixture.origin(spec.engineHost)}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
      const reloaded = await openEngineReport(controlPage, false);
      await controlPage.close();
      report = { ...reloaded, registration: report.registration };
      result.control = reloaded.control;
      result.workerServed = reloaded.workerServed?.servedBySw;
      result.controlAfter = "second-client";
    } catch (error) {
      return { ...result, status: "infrastructure", detail: `reload after registration failed: ${String((error as Error).message ?? error).split("\n")[0]}` };
    }
  }

  if (report.registration === "refused") {
    // A refusal is a compatibility finding, never a skip.
    return { ...result, status: "refusal", detail: report.registrationDetail ?? "registration refused" };
  }

  const problems: string[] = [];
  if (report.thirdParty !== inFrame) problems.push(`frame relationship: expected thirdParty=${inFrame}, measured ${report.thirdParty}`);
  if (report.registration !== "accepted") problems.push(`registration: ${report.registration ?? "missing"}`);
  if (spec.assertsControl) {
    if (report.control !== true) problems.push("control: false after bounded controllerchange wait");
    if (report.workerServed?.servedBySw !== true) problems.push(`worker-served: ${report.workerServedError ?? "request was not served by the worker"}`);
  }
  if (spec.expect.laxCookieAttached !== "n/a") {
    // A fetch that never completed is a harness fault, not a cookie result: CORS, TLS or
    // the route would produce an empty list that looks exactly like "everything withheld".
    if (!report.credentialedFetch) {
      return { ...result, status: "harness-error", detail: `credentialed fetch did not complete: ${report.credentialedFetchError ?? "no response recorded"}` };
    }
    const sent = result.cookiesSent ?? [];
    const laxSent = sent.includes("session");
    if (laxSent !== spec.expect.laxCookieAttached) {
      problems.push(`SameSite=Lax cookie: expected ${spec.expect.laxCookieAttached ? "attached" : "withheld"}, measured ${laxSent ? "attached" : "withheld"}`);
    }
    if (!sent.includes("crosssite")) {
      problems.push(`SameSite=None cookie was not attached on a credentialed fetch (sent: ${sent.join(",") || "nothing"})`);
    }
  }
  if (problems.length > 0) {
    const diagnostics = result.pageDiagnostics ?? [];
    return {
      ...result,
      status: "harness-error",
      detail: problems.join("; ") + (diagnostics.length > 0 ? ` [${diagnostics.slice(0, 3).join(" | ")}]` : ""),
    };
  }
  return result;
}

async function readStorageAcrossSites(
  page: Page,
  fixture: Fixture,
  base: Omit<CaseResult, "caseId" | "status">,
): Promise<CaseResult> {
  const result: CaseResult = { ...base, caseId: "storage-across-top-level-sites", status: "pass" };
  try {
    await page.goto(`${fixture.origin(HOSTS.other)}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const underOther = await openEngineReport(page, true);
    await page.goto(`${fixture.origin(HOSTS.engine)}/inert`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const firstParty = await page.evaluate(() => (window as unknown as { __result: Record<string, unknown> }).__result);
    const secondSiteSaw = underOther.storagePrior ?? null;
    const firstPartySaw = (firstParty.storagePrior as string | null | undefined) ?? null;
    result.storage = {
      key: STORAGE_KEY,
      underFirstTopLevelSite: HOSTS.app,
      underSecondTopLevelSite: HOSTS.other,
      secondSiteRead: secondSiteSaw,
      firstPartyInertRead: firstPartySaw,
      partitioning: secondSiteSaw === null ? "isolated" : "shared",
    };
    // Partitioning is recorded, not asserted: it is a property of the build under test
    // (Playwright flags, ITP presence), and claiming it as product behaviour is how a
    // harness starts lying. A shared value is printed and carried in the report.
  } catch (error) {
    result.status = "infrastructure";
    result.detail = `storage probe failed: ${String((error as Error).message).split("\n")[0]}`;
  }
  return result;
}

interface Driver {
  readonly name: BrowserName;
  readonly version: string;
  readonly variant: string;
  readonly context: BrowserContext;
  readonly close: () => Promise<void>;
}

async function launchDriver(name: BrowserName, firefoxProfileDir: string): Promise<Driver> {
  if (name === "firefox") {
    const context = await firefox.launchPersistentContext(firefoxProfileDir, { headless: true });
    const version = context.browser()?.version() ?? "unknown";
    return { name, version, variant: "launchPersistentContext(profile)", context, close: () => context.close() };
  }
  const browser: Browser = name === "chromium" ? await chromium.launch() : await webkit.launch();
  const context = await browser.newContext();
  return { name, version: browser.version(), variant: "launch()", context, close: () => browser.close() };
}

function printTable(results: readonly CaseResult[]): void {
  const rows = results.map((r) => ({
    browser: `${r.browser} ${r.browserVersion}`,
    case: r.caseId,
    topology: r.topology ? `${r.topology.topLevelSite} -> ${r.topology.engineSite}${r.topology.sameSite ? " (same site)" : " (cross site)"}` : "-",
    frame: r.topology?.frameRelationship ?? "-",
    reg: r.registration ?? "-",
    control: r.control === undefined ? "-" : String(r.control),
    swServed: r.workerServed === undefined ? "-" : String(r.workerServed),
    cookies: r.cookiesSent === null ? "-" : r.cookiesSent?.join(",") || "(none)",
    storage: r.storage?.["partitioning"] ? String(r.storage["partitioning"]) : "-",
    status: r.status,
  }));
  const columns = Object.keys(rows[0] ?? { browser: "" }) as (keyof (typeof rows)[number])[];
  const widths = new Map(columns.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths.get(columns[i] ?? "browser") ?? 0)).join("  ");
  process.stdout.write(`\n${line(columns as string[])}\n${line(columns.map((c) => "-".repeat(widths.get(c) ?? 0)))}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map((c) => String(row[c])))}\n`);
  const detail = results.filter((r) => r.detail);
  if (detail.length > 0) {
    process.stdout.write("\nDetail\n");
    for (const r of detail) process.stdout.write(`  ${r.browser} ${r.caseId}: ${r.detail}\n`);
  }
}

async function main(): Promise<number> {
  const cwd = process.cwd();
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const browsers: BrowserName[] = requested.length > 0 ? (requested as BrowserName[]) : ["chromium", "firefox", "webkit"];

  let trust: ReturnType<typeof prepareBrowserTrust>;
  let fixture: Fixture;
  try {
    // Order matters: refuse root first, because a root browser trusts /root/.pki and the whole
    // point of the lane is to test the identity that actually runs it.
    assertUnprivileged();
    const state = readState();
    verifyHostsReserved();
    trust = prepareBrowserTrust(state);
    printDiagnostics(trust);
    fixture = await startFixture(state);
  } catch (error) {
    const message = error instanceof HarnessInfrastructureError ? error.message : String(error);
    process.stderr.write(`infrastructure: ${message}\n`);
    return 1;
  }
  const results: CaseResult[] = [];
  try {
    for (const name of browsers) {
      const base = { browser: name, browserVersion: PINNED[name], launchVariant: `launch()/${TRUST_PATH[name]}`, trustPath: TRUST_PATH[name] };
      let driver: Driver;
      try {
        driver = await launchDriver(name, trust.firefoxProfileDir);
      } catch (error) {
        results.push({ ...base, caseId: "launch", status: "infrastructure", detail: String((error as Error).message ?? error).split("\n")[0] ?? "launch failed" });
        continue;
      }
      const versionBase = { ...base, browserVersion: driver.version, launchVariant: driver.variant };
      if (driver.version !== PINNED[name]) {
        results.push({ ...versionBase, caseId: "launch", status: "infrastructure", detail: `browser version drift: pinned ${PINNED[name]}, installed ${driver.version}` });
        await driver.close();
        continue;
      }
      // Preflight: prove the CA is trusted by the process that just launched, before any row
      // is recorded. A browser that cannot negotiate HTTPS yields infrastructure, never a
      // compatibility verdict about service workers.
      try {
        const probe = await driver.context.newPage();
        await probe.goto(`${fixture.origin(HOSTS.engine)}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
        const protocol = await probe.evaluate(() => location.protocol);
        await probe.close();
        if (protocol !== "https:") throw new Error(`navigation settled on ${protocol}`);
      } catch (error) {
        results.push({
          ...versionBase,
          caseId: "trust-preflight",
          status: "infrastructure",
          detail: `TLS navigation failed in the launched browser (${TRUST_PATH[name].split("—")[0]?.trim()}): ${String((error as Error).message ?? error).split("\n")[0]}`,
        });
        await driver.close();
        continue;
      }
      try {
        const page = await driver.context.newPage();
        for (const spec of CASES) {
          results.push(await runCase(spec, page, fixture, versionBase));
        }
        const otherPage = await driver.context.newPage();
        results.push(await readStorageAcrossSites(otherPage, fixture, versionBase));
      } finally {
        await driver.close();
      }
    }
  } finally {
    await fixture.close();
    trust.cleanup();
  }

  printTable(results);
  const artifacts = join(cwd, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "cross-site-harness.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    hosts: ALL_HOSTS,
    port: PORT,
    pinned: PINNED,
    results,
  }, null, 2));

  const failed = results.filter((r) => r.status !== "pass");
  const refusals = failed.filter((r) => r.status === "refusal");
  const infra = failed.filter((r) => r.status === "infrastructure");
  const harnessErrors = failed.filter((r) => r.status === "harness-error");
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed · refusals (compatibility findings): ${refusals.length}`
    + ` · infrastructure failures: ${infra.length} · harness errors: ${harnessErrors.length}\n`,
  );
  if (harnessErrors.length > 0) process.stdout.write("The harness is wrong, not the browser: fix the case before reading any result.\n");
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`harness crashed: ${String((error as Error).stack ?? error).split("\n").slice(0, 6).join("\n")}\n`);
  process.exit(1);
});
