#!/usr/bin/env bash
# Stop hook: delegate to whatever verification the project defines.
# The global hook never hardcodes a chain. Detection order, first match wins:
#   1. package.json "verify" script, run via detected package manager
#   2. Makefile "verify" target
#   3. ./scripts/verify.sh (executable)
# Exit 0 if no entrypoint exists or verify succeeds. Exit 2 if verify fails.
set -uo pipefail

# Stdin from Claude Code carries the event JSON. We do not need any field from
# it; consume so the pipe does not stay open.
cat >/dev/null

# Detect package manager from lockfile. Empty stdout = no lockfile.
pkg_manager() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun
  elif [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ]; then echo yarn
  elif [ -f package-lock.json ]; then echo npm
  fi
}

if [ -f package.json ] && jq -e '.scripts.verify' package.json >/dev/null 2>&1; then
  pm=$(pkg_manager)
  if [ -z "$pm" ]; then
    echo "stop-verify: package.json defines scripts.verify but no lockfile found (bun.lock, bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json). Commit a lockfile or remove the verify script." >&2
    exit 2
  fi
  case "$pm" in
    bun)  bun run verify || exit 2 ;;
    pnpm) pnpm run verify || exit 2 ;;
    yarn) yarn run verify || exit 2 ;;
    npm)  npm run verify || exit 2 ;;
  esac
  exit 0
fi

if [ -f Makefile ] && grep -Eq '^verify:' Makefile; then
  make verify || exit 2
  exit 0
fi

if [ -x scripts/verify.sh ]; then
  ./scripts/verify.sh || exit 2
  exit 0
fi

exit 0
