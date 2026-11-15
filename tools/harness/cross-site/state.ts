/**
 * Shared state between the privileged system setup and the unprivileged harness.
 *
 * The rule this file exists to enforce: root does the sysadmin work and nothing else.
 * The harness itself, and every browser it launches, must run as the invoking user, with
 * that user's HOME — a browser started under root writes its NSS database to /root/.pki,
 * which is not the identity the test is supposed to be exercising.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class HarnessInfrastructureError extends Error {}

export interface HarnessState {
  readonly stateDir: string;
  readonly caCertPath: string;
  readonly leafCertPath: string;
  readonly leafKeyPath: string;
  readonly hosts: readonly string[];
  readonly installedAt: string;
  readonly installedByUid: number;
  readonly installedByGid: number;
}

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

export const ALL_HOSTS: readonly string[] = Object.values(HOSTS);
export const PORT = 9443;
export const HOSTS_MARKER = "# swc-cross-site-harness";
export const SYSTEM_CA_PATH = "/usr/local/share/ca-certificates/swc-cross-site-harness.crt";

export function stateDirPath(): string {
  return process.env["SWC_HARNESS_STATE"] ?? join(tmpdir(), "swc-cross-site");
}

export function stateFilePath(dir = stateDirPath()): string {
  return join(dir, "state.json");
}

export function readState(): HarnessState {
  const file = stateFilePath();
  if (!existsSync(file)) {
    throw new HarnessInfrastructureError(
      `no harness state at ${file}. Run the privileged setup first:\n`
      + `  sudo npm run harness:cross-site:setup`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as HarnessState;
}

export function assertUnprivileged(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0 && process.env["SWC_HARNESS_ALLOW_ROOT"] !== "1") {
    throw new HarnessInfrastructureError(
      "the harness must run as the invoking user, not root: a root browser writes its NSS database to /root/.pki "
      + "and the trust setup then applies to the wrong identity. Run the privileged setup separately "
      + "(sudo npm run harness:cross-site:setup) and then run the harness unprivileged.",
    );
  }
}
