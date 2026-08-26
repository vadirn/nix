#!/usr/bin/env bash
# Tripwire against ACCIDENTAL secret reads landing in context (cat .env, head id_rsa).
# NOT a security boundary: a string matcher is defeated by obfuscation (c""at .env) and
# unlisted readers. Real enforcement is sandbox.credentials in settings.json. Keep this
# low-false-positive: file tokens are anchored to a path boundary so leading-dot accessors
# (jq '.data.key') never look like filenames (server.key). env bash avoids the /bin/bash 3.2
# ${VAR,,} "bad substitution" that would abort and fail open.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Extensions a secret actually ships in. Source and doc extensions are absent on
# purpose: a module named credentials.ts is code ABOUT secrets, not a secret, and
# denying it only teaches the agent to rename its files — which costs a real
# rename and buys nothing, since this hook is a tripwire and not the boundary.
SECRET_EXT='(json|ya?ml|ini|cfg|conf|toml|properties|txt|csv|xml|enc|b64|bak)'

# A bare credentials/secret file ends its token; one with an extension has to
# carry a data extension to count. The two differ on a trailing slash, and the
# asymmetry is deliberate: a `secrets/` directory nearly always holds secrets,
# while a `*-credentials/` directory is nearly always a package.
SENSITIVE='(\.env($|[^[:alnum:]_])'
SENSITIVE+='|[/-]credentials($|[^[:alnum:]_./-])'
SENSITIVE+="|(^|[^[:alnum:]_.])credentials\\.$SECRET_EXT($|[^[:alnum:]])"
SENSITIVE+='|/secrets?($|[^[:alnum:]_.-])'
SENSITIVE+="|(^|[^[:alnum:]_.])secrets?\\.$SECRET_EXT($|[^[:alnum:]])"
SENSITIVE+='|(^|[^[:alnum:]_.])[[:alnum:]_~][^[:space:]]*\.(pem|key|p12|pfx|keystore)($|[^[:alnum:]])'
SENSITIVE+='|id_rsa|id_ed25519|token\.json|auth\.json|\.netrc|\.npmrc|\.pypirc)'
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
