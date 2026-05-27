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

# Detect package manager from lockfile.
pkg_manager() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun
  elif [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ]; then echo yarn
  elif [ -f package-lock.json ]; then echo npm
  else echo npm
  fi
}

if [ -f package.json ] && jq -e '.scripts.verify' package.json >/dev/null 2>&1; then
  pm=$(pkg_manager)
  case "$pm" in
    bun)  bun run verify ;;
    pnpm) pnpm run verify ;;
    yarn) yarn verify ;;
    npm)  npm run verify ;;
  esac
  rc=$?
  [ $rc -eq 0 ] && exit 0 || exit 2
fi

if [ -f Makefile ] && grep -Eq '^verify:' Makefile; then
  make verify
  rc=$?
  [ $rc -eq 0 ] && exit 0 || exit 2
fi

if [ -x scripts/verify.sh ]; then
  ./scripts/verify.sh
  rc=$?
  [ $rc -eq 0 ] && exit 0 || exit 2
fi

exit 0
