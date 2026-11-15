/**
 * Privileged setup and teardown for the cross-site harness. Root does sysadmin work only:
 * OS packages, the system trust store, /etc/hosts, and file ownership.
 *
 *   sudo npm run harness:cross-site:setup
 *   sudo npm run harness:cross-site:teardown
 *
 * It never launches a browser. Chromium and Firefox trust is seeded by the harness itself,
 * in the invoking user's own NSS databases, because that is the identity under test.
 */
import { execFileSync } from "node:child_process";
import { chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_HOSTS,
  HOSTS_MARKER,
  SYSTEM_CA_PATH,
  HarnessInfrastructureError,
  stateDirPath,
  stateFilePath,
  type HarnessState,
} from "./state.js";

function run(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function requireRoot(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== 0) {
    throw new HarnessInfrastructureError(
      "system setup needs root (system trust store and /etc/hosts). Re-run under sudo, or use the teardown target with sudo.",
    );
  }
}

/** The user the harness will run as: SUDO_USER's ids, or the current user if not sudo'd. */
function invokingUser(): { uid: number; gid: number } {
  const sudoUid = process.env["SUDO_UID"];
  const sudoGid = process.env["SUDO_GID"];
  if (sudoUid && sudoGid) return { uid: Number(sudoUid), gid: Number(sudoGid) };
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
  };
}

function stripHostsBlock(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === HOSTS_MARKER) { skipping = !skipping; continue; }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

function writeHosts(): void {
  const path = "/etc/hosts";
  const current = stripHostsBlock(readFileSync(path, "utf8"));
  const block = [HOSTS_MARKER, ...ALL_HOSTS.map((host) => `127.0.0.1 ${host}`), HOSTS_MARKER, ""].join("\n");
  writeFileSync(path, current.replace(/\n+$/, "\n") + block);
}

function installCa(dir: string): void {
  const caCert = join(dir, "ca.crt");
  const caKey = join(dir, "ca.key");
  const leafKey = join(dir, "leaf.key");
  const leafCsr = join(dir, "leaf.csr");
  const leafCert = join(dir, "leaf.crt");
  const ext = join(dir, "leaf.ext");
  if (!existsSync(caCert)) {
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert,
      "-days", "2", "-subj", "/CN=swc cross-site harness CA"]);
  }
  if (!existsSync(leafCert)) {
    run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", leafCsr, "-subj", `/CN=${ALL_HOSTS[0] ?? "swc-app.test"}`]);
    writeFileSync(ext, `subjectAltName=${ALL_HOSTS.map((host) => `DNS:${host}`).join(",")}\nbasicConstraints=CA:FALSE\n`);
    run("openssl", ["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
      "-out", leafCert, "-days", "2", "-extfile", ext]);
  }
  // WebKit reads the system bundle; the other two are seeded per user by the harness.
  copyFileSync(caCert, SYSTEM_CA_PATH);
  run("update-ca-certificates", []);
}

function setup(): void {
  requireRoot();
  const dir = stateDirPath();
  mkdirSync(dir, { recursive: true });
  writeHosts();
  installCa(dir);
  const owner = invokingUser();
  // The harness reads the CA and writes its own profile into this directory, unprivileged.
  for (const entry of ["ca.crt", "leaf.crt", "leaf.key", "ca.key"]) {
    const path = join(dir, entry);
    if (existsSync(path)) chownSync(path, owner.uid, owner.gid);
  }
  chownSync(dir, owner.uid, owner.gid);
  const state: HarnessState = {
    stateDir: dir,
    caCertPath: join(dir, "ca.crt"),
    leafCertPath: join(dir, "leaf.crt"),
    leafKeyPath: join(dir, "leaf.key"),
    hosts: ALL_HOSTS,
    installedAt: new Date().toISOString(),
    installedByUid: owner.uid,
    installedByGid: owner.gid,
  };
  writeFileSync(stateFilePath(dir), JSON.stringify(state, null, 2));
  chownSync(stateFilePath(dir), owner.uid, owner.gid);
  process.stdout.write(`system setup complete: ${dir} (owned by uid ${owner.uid}, gid ${owner.gid})\n`);
}

function teardown(): void {
  requireRoot();
  const path = "/etc/hosts";
  if (existsSync(path)) writeFileSync(path, stripHostsBlock(readFileSync(path, "utf8")));
  if (existsSync(SYSTEM_CA_PATH)) {
    rmSync(SYSTEM_CA_PATH, { force: true });
    run("update-ca-certificates", []);
  }
  process.stdout.write("system teardown complete: hosts entries and system CA removed\n");
}

try {
  if (process.argv.includes("--teardown")) teardown();
  else setup();
} catch (error) {
  const message = error instanceof HarnessInfrastructureError ? error.message : String(error);
  process.stderr.write(`system setup failed: ${message}\n`);
  process.exit(1);
}
