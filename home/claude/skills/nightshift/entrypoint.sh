#!/bin/bash
set -uo pipefail

# Self-heal claude symlink: volume may contain stale symlink from prior image build.
# Resolve to whatever version is actually installed.
CLAUDE_BIN="$HOME/.local/bin/claude"
VERSIONS_DIR="$HOME/.local/share/claude/versions"

if [ ! -x "$CLAUDE_BIN" ] || [ ! -e "$CLAUDE_BIN" ]; then
    LATEST=$(ls "$VERSIONS_DIR" 2>/dev/null | sort -V | tail -1)
    if [ -z "$LATEST" ]; then
        echo "entrypoint: no claude version found in $VERSIONS_DIR, attempting fresh install" >&2
        curl -fsSL https://claude.ai/install.sh | bash
        LATEST=$(ls "$VERSIONS_DIR" 2>/dev/null | sort -V | tail -1)
        if [ -z "$LATEST" ]; then
            echo "entrypoint: install failed, no versions available" >&2
            exit 1
        fi
    fi
    ln -sf "$VERSIONS_DIR/$LATEST" "$CLAUDE_BIN"
    echo "entrypoint: repaired claude symlink -> $LATEST" >&2
fi

case "${1:-}" in
    ""|-*)
        exec claude "$@"
        ;;
    claude)
        shift
        exec claude "$@"
        ;;
    *)
        exec "$@"
        ;;
esac
