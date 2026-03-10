#!/bin/bash
# Block SSRF, data exfiltration, raw sockets, and network scanners.
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

CMD_LOWER=$(printf '%s' "$COMMAND" | tr '[:upper:]' '[:lower:]')

# === SSRF: cloud metadata endpoints ===
if [[ "$COMMAND" =~ (curl|wget)[[:space:]] ]]; then
  if [[ "$CMD_LOWER" =~ 169\.254\.169\.254 ]] || \
     [[ "$CMD_LOWER" =~ metadata\.google\.internal ]] || \
     [[ "$CMD_LOWER" =~ 169\.254\.169\.250 ]] || \
     [[ "$CMD_LOWER" =~ 100\.100\.100\.200 ]]; then
    deny "Blocked: targets cloud metadata endpoint. These expose instance credentials."
  fi

  # === SSRF: localhost/loopback ===
  if [[ "$CMD_LOWER" =~ (curl|wget)[[:space:]]+[^|]*https?://(localhost|127\.[0-9]|0\.0\.0\.0|\[::1\]) ]]; then
    deny "Blocked: targets localhost. Run this manually if needed."
  fi

  # === SSRF: private RFC1918 ranges ===
  if [[ "$CMD_LOWER" =~ (curl|wget)[[:space:]]+[^|]*https?://(10\.[0-9]|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]]; then
    deny "Blocked: targets private network address."
  fi
fi

# === Data exfiltration: curl with upload flags ===
if [[ "$COMMAND" =~ (^|[;&|[:space:]])curl[[:space:]] ]]; then
  if [[ "$COMMAND" =~ [[:space:]](-d[^[:space:]]*|--data(=|[[:space:]])|--data-binary(=|[[:space:]])|--data-raw(=|[[:space:]])|--data-urlencode(=|[[:space:]])|-F[^[:space:]]*|--form(=|[[:space:]])|--upload-file(=|[[:space:]])|-T[^[:space:]]*) ]]; then
    deny "Blocked: curl with data upload flags (-d/--data/-F/--form/-T). Run manually if needed."
  fi
fi

# === Data exfiltration: wget with POST ===
if [[ "$COMMAND" =~ (^|[;&|[:space:]])wget[[:space:]] ]] && [[ "$COMMAND" =~ --post-data|--post-file ]]; then
  deny "Blocked: wget with --post-data/--post-file. Run manually if needed."
fi

# === Raw sockets ===
if [[ "$COMMAND" =~ (^|[;&|[:space:]])(nc|ncat|netcat|socat)[[:space:]] ]]; then
  deny "Blocked: raw socket tool (${BASH_REMATCH[2]}). Use curl for HTTP."
fi

# === Network scanners ===
if [[ "$COMMAND" =~ (^|[;&|[:space:]])(nmap|masscan|zmap)[[:space:]] ]]; then
  deny "Blocked: network scanner (${BASH_REMATCH[2]})."
fi

exit 0
