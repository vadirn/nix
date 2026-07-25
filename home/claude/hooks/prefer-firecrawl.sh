#!/usr/bin/env bash
# Block WebSearch/WebFetch and route to the Firecrawl MCP server.
set -euo pipefail

REASON="WebSearch and WebFetch are blocked. Use the Firecrawl MCP server instead (firecrawl_search for queries, firecrawl_scrape for URLs)."

jq -n --arg reason "$REASON" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $reason
  }
}'
