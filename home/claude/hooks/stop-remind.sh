#!/usr/bin/env bash
# Stop hook launcher for stop-remind, which reminds the agent at turn end to save to crux,
# check the SDLC note and grade its confidence. The hook lives in the bun workspace to
# inherit its pinned typecheck, lint, and test: see
# home/agents/skills/tools/stop-remind/stop-remind.ts. Without bun on PATH this exits 127,
# which Claude Code shows as a hook error without blocking the stop.
set -u
exec bun "$(dirname "$(readlink -f "$0")")/../../agents/skills/tools/stop-remind/stop-remind.ts"
