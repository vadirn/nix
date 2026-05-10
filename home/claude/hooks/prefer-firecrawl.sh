#!/usr/bin/env bash
# Block WebSearch/WebFetch and route to the firecrawl-cli skill.
set -euo pipefail

REASON="WebSearch and WebFetch are blocked. Use the firecrawl-cli skill instead (firecrawl-search for queries, firecrawl-scrape for URLs)."

jq -n --arg reason "$REASON" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $reason
  }
}'
