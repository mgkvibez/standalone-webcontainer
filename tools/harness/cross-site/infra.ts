/**
 * Infrastructure for the cross-site harness: reserved hostnames, a locally trusted
 * CA per browser, and one HTTPS fixture server.
 *
 * Nothing here is deployed and nothing here is a certificate bypass. Every browser
 * is made to genuinely trust the CA by the mechanism that browser reads, which is
 * different for each of them (measured, see docs/deploy/cross-site-harness.md).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocuments } from "./documents.js";

export class HarnessInfrastructureError extends Error {}

export const HOSTS = {
  /** Editor stand-in for the cross-site cases. */
  app: "swc-app.test",
  /** A second registrable domain, used as another top-level site. */
  other: "swc-other.test",
  /** Engine stand-in for the cross-site cases. */
  engine: "swc-engine.test",
  /** Same registrable domain as `sameEngine`, different origin: design A's shape. */
  sameApp: "a.swc.test",
  sameEngine: "b.swc.test",
} as const;

export const ALL_HOSTS = Object.values(HOSTS);
export const PORT = 9443;
const MARKER = "# swc-cross-site-harness";

export function requireRoot(what: string): void {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new HarnessInfrastructureError(
      `${what} needs root: /etc/hosts and the system trust store are root-owned. Re-run under sudo.`,
    );
  }
}

/** Add the reserved hostnames, remembering the previous file so it can be restored. */
export function installHosts(): () => void {
  requireRoot("reserving test hostnames in /etc/hosts");
  const path = "/etc/hosts";
  const original = readFileSync(path, "utf8");
  const block = [MARKER, ...ALL_HOSTS.map((host) => `127.0.0.1 ${host}`), MARKER, ""].join("\n");
  writeFileSync(path, original + (original.endsWith("\n") ? "" : "\n") + block);
  return () => writeFileSync(path, original);
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

export interface TrustSetup {
  readonly caCertPath: string;
  readonly leafKeyPath: string;
  readonly leafCertPath: string;
  readonly firefoxProfileDir: string;
  readonly cleanup: () => void;
}

/**
 * Generate a CA and a leaf covering every harness hostname, then make each browser
 * trust the CA by the store it actually reads:
 *   - WebKit  -> the system bundle (/etc/ssl/certs)
 *   - Chromium -> the NSS database at $HOME/.pki/nssdb (the system bundle is NOT enough)
 *   - Firefox -> the per-profile NSS database (enterprise roots and policies.json are NOT enough)
 */
export function installTrust(): TrustSetup {
  requireRoot("installing a locally trusted CA");
  const dir = join(tmpdir(), `swc-cross-site-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const caKey = join(dir, "ca.key");
  const caCert = join(dir, "ca.crt");
  const leafKey = join(dir, "leaf.key");
  const leafCsr = join(dir, "leaf.csr");
  const leafCert = join(dir, "leaf.crt");
  const ext = join(dir, "leaf.ext");
  const profile = join(dir, "firefox-profile");

  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert,
    "-days", "2", "-subj", "/CN=swc cross-site harness CA"]);
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", leafCsr,
    "-subj", `/CN=${HOSTS.app}`]);
  writeFileSync(ext, `subjectAltName=${ALL_HOSTS.map((host) => `DNS:${host}`).join(",")}\nbasicConstraints=CA:FALSE\n`);
  run("openssl", ["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", leafCert, "-days", "2", "-extfile", ext]);

  try {
    // `certutil -H` exits non-zero after printing usage, so it cannot be the probe.
    execFileSync("sh", ["-c", "command -v certutil"], { stdio: "ignore" });
  } catch {
    throw new HarnessInfrastructureError(
      "certutil is missing; install it (Debian/Ubuntu: apt-get install -y libnss3-tools). Chromium and Firefox both need it.",
    );
  }

  // WebKit: system bundle.
  const systemStore = "/usr/local/share/ca-certificates/swc-cross-site-harness.crt";
  writeFileSync(systemStore, readFileSync(caCert));
  run("update-ca-certificates", []);

  // Chromium: NSS database in $HOME/.pki/nssdb.
  const nssDb = join(homedir(), ".pki", "nssdb");
  mkdirSync(nssDb, { recursive: true });
  tryRun("certutil", ["-d", `sql:${nssDb}`, "-D", "-n", "swc-cross-site-harness"]);
  run("certutil", ["-d", `sql:${nssDb}`, "-A", "-t", "C,,", "-n", "swc-cross-site-harness", "-i", caCert]);

  // Firefox: the profile database it will actually open.
  mkdirSync(profile, { recursive: true });
  tryRun("certutil", ["-d", `sql:${profile}`, "-N", "--empty-password"]);
  run("certutil", ["-d", `sql:${profile}`, "-A", "-t", "C,,", "-n", "swc-cross-site-harness", "-i", caCert]);

  return {
    caCertPath: caCert,
    leafKeyPath: leafKey,
    leafCertPath: leafCert,
    firefoxProfileDir: profile,
    cleanup: () => {
      try { rmSync(systemStore, { force: true }); execFileSync("update-ca-certificates", [], { stdio: "ignore" }); } catch { /* best effort */ }
      try { execFileSync("certutil", ["-d", `sql:${nssDb}`, "-D", "-n", "swc-cross-site-harness"], { stdio: "ignore" }); } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Fixture {
  readonly origin: (host: string) => string;
  readonly close: () => Promise<void>;
}

/**
 * One HTTPS server answers every hostname. Behaviour is selected by `Host`, and the
 * document roles are explicit: embedder pages, engine documents, the worker script,
 * the credentialed-echo endpoint and the inert storage reader.
 */
export function startFixture(trust: TrustSetup): Promise<Fixture> {
  const docs = buildDocuments(HOSTS, PORT);
  const server: Server = createHttpsServer(
    { key: readFileSync(trust.leafKeyPath), cert: readFileSync(trust.leafCertPath) },
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
        return send("application/json", JSON.stringify({ cookieHeader: req.headers.cookie ?? null, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null, secFetchSite: req.headers["sec-fetch-site"] ?? null }), {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          vary: "origin",
        });
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

export function assertRepoRoot(cwd: string): void {
  if (!existsSync(join(cwd, "package.json"))) {
    throw new HarnessInfrastructureError(`expected to run from the repository root, got ${cwd}`);
  }
}
