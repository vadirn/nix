#!/bin/bash
# Block dangerous Bash commands with descriptive messages.
# Note: rm -rf is handled separately by no-dangerous-rm.py (path-aware).
# Also handles git -C (absorbed from no-git-c.sh).
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

P='(^|[[:space:];]|&&|\|)'
FORCE_RE="${P}git[[:space:]]+push.*(-f|--force)"
BRANCH_RE="${P}git[[:space:]]+branch.*-D([[:space:]]|$)"
OBSIDIAN_RE="${P}obsidian[[:space:]]+(eval|delete[[:space:]].*permanent|plugin:(un)?install|dev:cdp|command|history:restore)([[:space:]]|$)"

if [[ "$COMMAND" =~ ${P}sudo[[:space:]] ]]; then
  deny "Blocked: sudo runs commands as root. Too risky."
fi

if [[ "$COMMAND" =~ ${P}chmod[[:space:]]+777[[:space:]] ]]; then
  deny "Blocked: chmod 777 makes files world-writable."
fi

if [[ "$COMMAND" =~ $FORCE_RE ]]; then
  deny "Blocked: force push overwrites remote history."
fi

if [[ "$COMMAND" =~ ${P}git[[:space:]]+reset[[:space:]]+--hard ]]; then
  deny "Blocked: git reset --hard discards uncommitted changes."
fi

if [[ "$COMMAND" =~ $BRANCH_RE ]]; then
  deny "Blocked: git branch -D force-deletes without merge check."
fi

if [[ "$COMMAND" =~ ${P}git[[:space:]]+-C[[:space:]] ]]; then
  deny "Use plain \`git\` — you are already in the repo."
fi

if [[ "$COMMAND" =~ $OBSIDIAN_RE ]]; then
  deny "Blocked: this obsidian subcommand can cause data loss or run arbitrary code."
fi

exit 0
