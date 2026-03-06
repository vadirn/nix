#!/bin/bash
# Block Bash commands that read content from sensitive files.
# Catches: cat .env, grep password .env, head ~/.ssh/id_rsa, jq . secrets.json, etc.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Patterns for sensitive file paths/names
SENSITIVE='(\.env($|\s|\.)|credentials|secret|\.pem|\.key|id_rsa|id_ed25519|\.p12|\.pfx|\.keystore|token\.json|auth\.json|\.netrc|\.npmrc|\.pypirc)'

# Commands that read file contents (not just metadata)
READERS='(^|\s|/)(cat|head|tail|less|more|grep|rg|egrep|fgrep|ag|ack|sed|awk|jq|yq|bat|find\s.*-exec|xargs)'

if echo "$COMMAND" | grep -qEi "$READERS" && echo "$COMMAND" | grep -qEi "$SENSITIVE"; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Blocked: command reads from a sensitive file (.env, credentials, keys). Use the Read tool instead — it has its own deny rules."
    }
  }'
fi

exit 0
