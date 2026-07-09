#!/usr/bin/env bash
# Tripwire against ACCIDENTAL secret reads landing in context (cat .env, head id_rsa).
# NOT a security boundary: a string matcher is defeated by obfuscation (c""at .env) and
# unlisted readers. Real enforcement is sandbox.credentials in settings.json. Keep this
# low-false-positive: file tokens are anchored to a path boundary so leading-dot accessors
# (jq '.data.key') never look like filenames (server.key). env bash avoids the /bin/bash 3.2
# ${VAR,,} "bad substitution" that would abort and fail open.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

SENSITIVE='(\.env($|[^[:alnum:]_])|[/-]credentials|(^|[^[:alnum:]_.])credentials\.[[:alnum:]]|/secrets?|(^|[^[:alnum:]_.])secrets?\.[[:alnum:]]|(^|[^[:alnum:]_.])[[:alnum:]_~][^[:space:]]*\.(pem|key|p12|pfx|keystore)($|[^[:alnum:]])|id_rsa|id_ed25519|token\.json|auth\.json|\.netrc|\.npmrc|\.pypirc)'
READERS='((^|[^[:alnum:]_])(cat|head|tail|less|more|grep|rg|egrep|fgrep|ag|ack|sed|awk|jq|yq|bat|base64|xxd|od|strings|nl|tac|tee|source)([[:space:]]|$)|find[[:space:]].*-exec|xargs)'

if [[ "$COMMAND" =~ $READERS ]] && [[ "${COMMAND,,}" =~ $SENSITIVE ]]; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Blocked: command reads from a sensitive file (.env, credentials, keys). Use the Read tool instead — it has its own deny rules."
    }
  }'
fi

exit 0
