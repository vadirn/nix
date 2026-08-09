#!/usr/bin/env bash
set -euo pipefail

[[ -n "${CLAUDE_ENV_FILE:-}" ]] || exit 0

echo "export PATH=\"${HOME}/.claude/bin:\${PATH}\"" >> "$CLAUDE_ENV_FILE"
