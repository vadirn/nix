#!/bin/bash
# Block Read/Grep tools on sensitive files (.env, credentials, keys).
# Matcher: Read, Grep (set both in settings.json).
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

# Extract the relevant path field depending on the tool
if [ "$TOOL" = "Read" ]; then
  TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
elif [ "$TOOL" = "Grep" ]; then
  TARGET=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
fi

[ -z "$TARGET" ] && exit 0

BASENAME=$(basename "$TARGET")

# Sensitive file patterns
if echo "$BASENAME" | grep -qEi '^\.(env|env\..*)$|^credentials|^secret|\.pem$|\.key$|^id_rsa|^id_ed25519|\.p12$|\.pfx$|\.keystore$|^token\.json$|^auth\.json$|^\.netrc$|^\.npmrc$|^\.pypirc$'; then
  jq -n --arg file "$TARGET" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": ("Blocked: " + $file + " matches a sensitive file pattern (.env, credentials, keys).")
    }
  }'
fi

exit 0
