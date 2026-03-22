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

# Prevent config drift between iterations: settings/MCP changes from one run must not leak into the next
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"
CLAUDE_JSON_SNAPSHOT="$HOME/.claude.json.snapshot"

if [ -d "$CLAUDE_DIR" ]; then
    if [ ! -d "$CLAUDE_DIR/.git" ]; then
        git -C "$CLAUDE_DIR" init -q
        git -C "$CLAUDE_DIR" add -A
        git -C "$CLAUDE_DIR" commit -q -m "baseline" --allow-empty
        [ -f "$CLAUDE_JSON" ] && cp "$CLAUDE_JSON" "$CLAUDE_JSON_SNAPSHOT"
    else
        git -C "$CLAUDE_DIR" checkout -q -- .
        git -C "$CLAUDE_DIR" clean -qfd
        [ -f "$CLAUDE_JSON_SNAPSHOT" ] && cp "$CLAUDE_JSON_SNAPSHOT" "$CLAUDE_JSON"
    fi
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
