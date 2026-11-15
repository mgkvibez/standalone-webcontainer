/**
 * Unprivileged infrastructure for the cross-site harness: hostname verification, per-user CA
 * trust, one HTTPS fixture server, and the diagnostics that make a launch failure obvious.
 *
 * Everything here runs as the invoking user. System-wide work (OS packages, the system trust
 * store, /etc/hosts) lives in system-setup.ts and must already have been done.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import { buildDocuments } from "./documents.js";
import { ALL_HOSTS, HarnessInfrastructureError, HOSTS, HOSTS_MARKER, PORT, type HarnessState } from "./state.js";

export { HOSTS, HarnessInfrastructureError, PORT } from "./state.js";

export function verifyHostsReserved(): void {
  const text = readFileSync("/etc/hosts", "utf8");
  const missing = ALL_HOSTS.filter((host) => !new RegExp(`^\\s*127\\.0\\.0\\.1\\s+${host.replace(/\./g, "\\.")}\\s*$`, "m").test(text));
  if (missing.length > 0) {
    throw new HarnessInfrastructureError(
      `hostnames not reserved in /etc/hosts (missing ${missing.join(", ")}). Run the privileged setup first: `
      + "sudo npm run harness:cross-site:setup",
    );
  }
  if (!text.includes(HOSTS_MARKER)) {
    throw new HarnessInfrastructureError(
      "/etc/hosts has the hostnames but not the harness marker; run sudo npm run harness:cross-site:setup",
    );
  }
}

export interface TrustSetup {
  readonly firefoxProfileDir: string;
  readonly chromiumNssDir: string;
  readonly cleanup: () => void;
}

function tryRun(cmd: string, args: readonly string[]): void {
  try {
    execFileSync(cmd, [...args], { stdio: "ignore" });
  } catch {
    // Idempotent setup: "already absent" and "already initialised" are both fine.
  }
}

function run(cmd: string, args: readonly string[]): string {
  try {
    return execFileSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    throw new HarnessInfrastructureError(`${cmd} ${args.join(" ")} failed: ${stderr.trim() || String(error)}`);
  }
}

/**
 * Trust the CA in the two browsers that do not read the system bundle, using the databases
 * those browsers actually open — in THIS user's home and THIS harness's profile. If this runs
 * as root, it writes /root/.pki and the trust applies to the wrong identity, which is exactly
 * the failure that made the CI lane red.
 */
export function prepareBrowserTrust(state: HarnessState): TrustSetup {
  try {
    execFileSync("sh", ["-c", "command -v certutil"], { stdio: "ignore" });
  } catch {
    throw new HarnessInfrastructureError(
      "certutil is missing; install it (Debian/Ubuntu: apt-get install -y libnss3-tools). Chromium and Firefox both need it.",
    );
  }
  const home = homedir();
  const chromiumNssDir = join(home, ".pki", "nssdb");
  mkdirSync(chromiumNssDir, { recursive: true });
  tryRun("certutil", ["-d", `sql:${chromiumNssDir}`, "-D", "-n", "swc-cross-site-harness"]);
  run("certutil", ["-d", `sql:${chromiumNssDir}`, "-A", "-t", "C,,", "-n", "swc-cross-site-harness", "-i", state.caCertPath]);

  // Fresh profile every run: a reused profile carries the previous run's service worker and
  // storage, which turns "does this browser control a new registration" into "what did last
  // run leave behind". CI is a clean runner, so the harness makes itself look like one.
  const firefoxProfileDir = join(state.stateDir, "firefox-profile");
  rmSync(firefoxProfileDir, { recursive: true, force: true });
  mkdirSync(firefoxProfileDir, { recursive: true });
  tryRun("certutil", ["-d", `sql:${firefoxProfileDir}`, "-N", "--empty-password"]);
  tryRun("certutil", ["-d", `sql:${firefoxProfileDir}`, "-D", "-n", "swc-cross-site-harness"]);
  run("certutil", ["-d", `sql:${firefoxProfileDir}`, "-A", "-t", "C,,", "-n", "swc-cross-site-harness", "-i", state.caCertPath]);

  return {
    firefoxProfileDir,
    chromiumNssDir,
    cleanup: () => {
      tryRun("certutil", ["-d", `sql:${chromiumNssDir}`, "-D", "-n", "swc-cross-site-harness"]);
      rmSync(firefoxProfileDir, { recursive: true, force: true });
    },
  };
}

function describe(path: string): string {
  if (!existsSync(path)) return `${path} (missing)`;
  const stat = statSync(path);
  const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
  return `${path} (mode ${mode}, uid ${stat.uid}, gid ${stat.gid})`;
}

/** Printed before any browser launches, so a launch failure is diagnosable from the log alone. */
export function printDiagnostics(trust: TrustSetup): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  let whoami = "unknown";
  try { whoami = execFileSync("whoami", { encoding: "utf8" }).trim(); } catch { /* best effort */ }
  const lines = [
    `id: uid=${uid} gid=${gid}`,
    `whoami: ${whoami}`,
    `HOME: ${homedir()}`,
    `home ownership: ${describe(homedir())}`,
    `nss db: ${describe(trust.chromiumNssDir)}`,
    `firefox profile: ${describe(trust.firefoxProfileDir)}`,
  ];
  for (const [name, exe] of [["chromium", chromium.executablePath()], ["firefox", firefox.executablePath()], ["webkit", webkit.executablePath()]] as const) {
    lines.push(`${name} executable: ${describe(exe)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export interface Fixture {
  readonly origin: (host: string) => string;
  readonly close: () => Promise<void>;
}

/**
 * One HTTPS server answers every hostname. Behaviour is selected by `Host`: embedder pages,
 * engine documents, the worker script, the credentialed-echo endpoint, the inert reader.
 */
export function startFixture(state: HarnessState): Promise<Fixture> {
  const docs = buildDocuments(HOSTS, PORT);
  const server: Server = createHttpsServer(
    { key: readFileSync(state.leafKeyPath), cert: readFileSync(state.leafCertPath) },
    (req, res) => {
      const host = String(req.headers.host ?? "").split(":")[0] ?? "";
      const url = new URL(req.url ?? "/", `https://${host}`);
      const send = (type: string, body: string, extra: Record<string, string> = {}) => {
        res.writeHead(200, { "content-type": type, ...extra });
        res.end(body);
      };
      const isEngineHost = host === HOSTS.engine || host === HOSTS.sameEngine;
      if (isEngineHost && url.pathname === "/sw.js") return send("application/javascript", docs.serviceWorker);
      if (isEngineHost && url.pathname === "/engine") {
        return send("text/html; charset=utf-8", docs.engine(url.searchParams.get("tag") ?? "engine"));
      }
      if (isEngineHost && url.pathname === "/inert") return send("text/html; charset=utf-8", docs.inertReader);
      if (isEngineHost && url.pathname === "/") return send("text/html; charset=utf-8", docs.engine("first-party"));
      if (!isEngineHost && url.pathname === "/echo") {
        // Reflect the caller: the same-site case has a different engine origin, and a
        // hardcoded allow-origin would make its fetch fail for reasons unrelated to cookies.
        const origin = String(req.headers.origin ?? `https://${HOSTS.engine}:${PORT}`);
        return send("application/json", JSON.stringify({
          cookieHeader: req.headers.cookie ?? null,
          origin: req.headers.origin ?? null,
          referer: req.headers.referer ?? null,
          secFetchSite: req.headers["sec-fetch-site"] ?? null,
        }), { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "origin" });
      }
      if (!isEngineHost && url.pathname === "/") {
        const engineHost = host === HOSTS.sameApp ? HOSTS.sameEngine : HOSTS.engine;
        return send("text/html; charset=utf-8", docs.embedder(host, engineHost));
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`unrouted ${host}${url.pathname}`);
    },
  );
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => {
      resolve({
        origin: (host: string) => `https://${host}:${PORT}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
