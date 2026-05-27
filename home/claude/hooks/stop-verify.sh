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

# Hooks run in Claude's current cwd, which can drift after any cd. All
# filesystem checks and invocations are anchored to $CLAUDE_PROJECT_DIR so
# detection is reliable regardless of where Claude's cwd has landed.
if [ -z "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "stop-verify: CLAUDE_PROJECT_DIR is unset or empty; cannot anchor verification checks. Skipping." >&2
  exit 0
fi

# Detect package manager from lockfile. Empty stdout = no lockfile.
pkg_manager() {
  if [ -f "$CLAUDE_PROJECT_DIR/bun.lock" ] || [ -f "$CLAUDE_PROJECT_DIR/bun.lockb" ]; then echo bun
  elif [ -f "$CLAUDE_PROJECT_DIR/pnpm-lock.yaml" ]; then echo pnpm
  elif [ -f "$CLAUDE_PROJECT_DIR/yarn.lock" ]; then echo yarn
  elif [ -f "$CLAUDE_PROJECT_DIR/package-lock.json" ]; then echo npm
  fi
}

if [ -f "$CLAUDE_PROJECT_DIR/package.json" ] && jq -e '.scripts.verify' "$CLAUDE_PROJECT_DIR/package.json" >/dev/null 2>&1; then
  pm=$(pkg_manager)
  if [ -z "$pm" ]; then
    echo "stop-verify: package.json defines scripts.verify but no lockfile found (bun.lock, bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json). Commit a lockfile or remove the verify script." >&2
    exit 2
  fi
  (cd "$CLAUDE_PROJECT_DIR" && "$pm" run verify) || exit 2
  exit 0
fi

if [ -f "$CLAUDE_PROJECT_DIR/Makefile" ] && grep -Eq '^verify:' "$CLAUDE_PROJECT_DIR/Makefile"; then
  (cd "$CLAUDE_PROJECT_DIR" && make verify) || exit 2
  exit 0
fi

if [ -x "$CLAUDE_PROJECT_DIR/scripts/verify.sh" ]; then
  "$CLAUDE_PROJECT_DIR/scripts/verify.sh" || exit 2
  exit 0
fi

exit 0
