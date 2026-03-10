#!/bin/bash
# Block dangerous Bash commands with descriptive messages.
# Note: rm -rf is handled separately by no-dangerous-rm.py (path-aware).
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

deny() {
  jq -n --arg reason "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

# sudo
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)sudo\s'; then
  deny "Blocked: sudo runs commands as root. Too risky."
fi

# chmod 777
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)chmod\s+777\s'; then
  deny "Blocked: chmod 777 makes files world-writable."
fi

# git push --force / -f
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)git\s+push\s+.*(-f|--force)'; then
  deny "Blocked: force push overwrites remote history."
fi

# git reset --hard
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)git\s+reset\s+--hard'; then
  deny "Blocked: git reset --hard discards uncommitted changes."
fi

# git branch -D
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)git\s+branch\s+.*-D\s'; then
  deny "Blocked: git branch -D force-deletes without merge check."
fi

# obsidian dangerous subcommands
if echo "$COMMAND" | grep -qE '(^|\s|;|&&|\|)obsidian\s+(eval|delete\s.*permanent|plugin:(un)?install|dev:cdp|command|history:restore)\s'; then
  deny "Blocked: this obsidian subcommand can cause data loss or run arbitrary code."
fi

exit 0
