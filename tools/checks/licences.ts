/**
 * CLI for the licence audit. Executed, never imported.
 *
 * A runtime package outside the allowlist fails the build. A dev-only one is printed and does not, because it does not
 * ship; printing it anyway is what keeps the dev list from growing unnoticed.
 */

import { readFileSync } from "node:fs";

import { auditLockfile, type Lockfile } from "./licence-audit.js";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as Lockfile;
const { runtime, devOnly, scanned } = auditLockfile(lock);

for (const finding of devOnly) {
  console.log(`dev-only off-list licence: ${finding.name}@${finding.version} ${finding.license}`);
}

if (runtime.length > 0) {
  for (const finding of runtime) {
    console.error(`RUNTIME licence violation: ${finding.name}@${finding.version} ${finding.license}`);
  }
  console.error(`\n${runtime.length} runtime package(s) outside MIT/Apache-2.0/BSD/ISC. Add to EXCEPTIONS only with a reason.`);
  process.exit(1);
}

console.log(`runtime licences clean: ${scanned} packages scanned`);
