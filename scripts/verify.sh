#!/usr/bin/env bash
# Local verification gate — CI replacement while GitHub Actions is
# unavailable due to the account billing lock (Oct 26). Local
# verification, independently confirmed green by the expert, is the
# official merge gate for this period.
#
# WHY the license check differs from the spec'd one-liner
# `grep -E "(webcontainer|nodebox)" package-lock.json || echo ...`:
#   (1) that pattern matches OUR OWN package name
#       ("standalone-webcontainer" is the lockfile root entry), so it
#       fails on a clean tree forever;
#   (2) `grep ... || echo passed` inverts the exit semantics — when
#       grep FINDS a forbidden dependency it exits 0, so the gate would
#       pass exactly when it must fail.
# This gate keeps the spec's intent: scan only node_modules install
# paths for forbidden runtime packages and exit 1 on any hit.
set -euo pipefail

echo "=== [1/4] npm ci (clean install) ==="
timeout 180 npm ci

echo "=== [2/4] tsc --noEmit ==="
timeout 120 npx tsc --noEmit

echo "=== [3/4] npm test ==="
timeout 120 npm test

echo "=== [4/4] license audit (forbidden runtime deps) ==="
if grep -qE '"node_modules/[^"]*(webcontainer|nodebox)' package-lock.json; then
  echo "FORBIDDEN dependency in lockfile (webcontainer|nodebox)" >&2
  exit 1
fi
echo "License check passed"

echo "=== VERIFY OK — local gate green ==="
