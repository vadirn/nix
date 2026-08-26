#!/bin/bash
# Tests for no-secrets-read.sh
SCRIPT="$(dirname "$0")/no-secrets-read.sh"
PASS=0
FAIL=0

assert_deny() {
  local desc="$1" input="$2"
  result=$(printf '%s' "$input" | bash "$SCRIPT")
  if echo "$result" | grep -q '"deny"'; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected deny): $desc"
    echo "  output: $result"
  fi
}

assert_allow() {
  local desc="$1" input="$2"
  result=$(printf '%s' "$input" | bash "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
    echo "  output: $result"
  fi
}

# --- Grep into a secret dir (the fix) ---
assert_deny  "Grep ~/.ssh (tilde)" \
  '{"tool_name":"Grep","tool_input":{"path":"~/.ssh"}}'
assert_deny  "Grep \$HOME/.aws (expanded)" \
  "{\"tool_name\":\"Grep\",\"tool_input\":{\"path\":\"$HOME/.aws\"}}"
assert_deny  "Grep under a secret dir" \
  "{\"tool_name\":\"Grep\",\"tool_input\":{\"path\":\"$HOME/.gnupg/private-keys-v1.d\"}}"
assert_deny  "Grep ~/.config/gh" \
  '{"tool_name":"Grep","tool_input":{"path":"~/.config/gh"}}'

# --- Grep into ordinary dirs stays allowed ---
assert_allow "Grep ~/nix" \
  '{"tool_name":"Grep","tool_input":{"path":"~/nix"}}'
assert_allow "Grep no path (cwd default)" \
  '{"tool_name":"Grep","tool_input":{"pattern":"foo"}}'
assert_allow "Grep sibling with shared prefix (~/.sshkeep)" \
  '{"tool_name":"Grep","tool_input":{"path":"~/.sshkeep"}}'

# --- Direct-file basename check (unchanged) ---
assert_deny  "Read ~/.aws/credentials" \
  "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$HOME/.aws/credentials\"}}"
assert_deny  "Read .env" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/.env"}}'
assert_deny  "Read id_rsa" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/id_rsa"}}'
assert_allow "Read src/main.ts" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/src/main.ts"}}'

# --- Source modules about credentials stay readable (the loosening) ---
assert_allow "Read src/credentials.ts" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/src/credentials.ts"}}'
assert_allow "Read src/credentials-store.ts" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/src/credentials-store.ts"}}'
assert_allow "Read src/secret-box.ts" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/src/secret-box.ts"}}'
assert_allow "Read src/secrets.ts" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/src/secrets.ts"}}'

# --- Real secret files still denied ---
assert_deny  "Read credentials.json" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/credentials.json"}}'
assert_deny  "Read secrets.yaml" \
  '{"tool_name":"Read","tool_input":{"file_path":"/some/repo/secrets.yaml"}}'
assert_deny  "Read bare secret file" \
  '{"tool_name":"Read","tool_input":{"file_path":"/run/secret"}}'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
