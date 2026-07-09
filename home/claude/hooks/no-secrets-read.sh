#!/bin/bash
# Block Read/Grep tools on sensitive files (.env, credentials, keys).
# Matcher: Read, Grep (set both in settings.json).
#
# Two checks: (1) basename patterns catch a direct read of a secret file (Read or
# Grep path pointing straight at it); (2) for Grep, whose ripgrep recurses, deny
# when the path is or is under a sensitive directory (~/.ssh, ~/.aws, ...), which
# a basename check alone misses (`Grep path=~/.ssh` surfaces key contents).
# Residual (not covered): a recursive Grep over a repo that itself contains a
# `.env` still returns matching lines (not whole files); low value, left as-is.
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

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

# Extract the relevant path field depending on the tool
if [ "$TOOL" = "Read" ]; then
  TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Grep" ]; then
  TARGET=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
fi

[ -z "$TARGET" ] && exit 0

# Grep into (or at) a sensitive directory: resolve ~ and compare with a
# trailing slash so /a/.ssh matches but /a/.sshkeep does not.
if [ "$TOOL" = "Grep" ]; then
  RESOLVED="${TARGET/#\~/$HOME}"
  RESOLVED="${RESOLVED%/}"
  for dir in "$HOME/.ssh" "$HOME/.aws" "$HOME/.gnupg" "$HOME/.config/gh" "$HOME/.docker"; do
    if [ "$RESOLVED" = "$dir" ] || [ "${RESOLVED#"$dir"/}" != "$RESOLVED" ]; then
      deny "Blocked: Grep into $dir would surface secret contents. Target a specific non-secret file if needed."
    fi
  done
fi

BASENAME=$(basename "$TARGET")

# Sensitive file patterns
if echo "$BASENAME" | grep -qEi '^\.(env|env\..*)$|^credentials|^secret|\.pem$|\.key$|^id_rsa|^id_ed25519|\.p12$|\.pfx$|\.keystore$|^token\.json$|^auth\.json$|^\.netrc$|^\.npmrc$|^\.pypirc$'; then
  deny "Blocked: $TARGET matches a sensitive file pattern (.env, credentials, keys)."
fi

exit 0
