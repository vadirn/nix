#!/bin/bash
# Nudge WebSearch/WebFetch toward the firecrawl-cli skill.
# CLAUDE.md: "Use firecrawl for web search and fetching. Fall back to
# WebFetch/WebSearch only if firecrawl fails."
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

REASON="Prefer the firecrawl-cli skill for web fetch/search (firecrawl-search for queries, firecrawl-scrape for URLs). Fall back to ${TOOL} only after firecrawl fails; when retrying, state the firecrawl error explicitly so the user can see why."

jq -n --arg reason "$REASON" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $reason
  }
}'
