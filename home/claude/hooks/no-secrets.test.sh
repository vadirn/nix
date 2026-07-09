#!/usr/bin/env bash
# Tests for no-secrets.sh
SCRIPT="$(dirname "$0")/no-secrets.sh"
PASS=0
FAIL=0

assert_deny() {
  local desc="$1" cmd="$2"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  if echo "$result" | grep -q '"deny"'; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected deny): $desc"
  fi
}

assert_allow() {
  local desc="$1" cmd="$2"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected allow): $desc"
  fi
}

# Should deny: reader + sensitive file
assert_deny  "cat .env"                    "cat .env"
assert_deny  "cat .env.local"             "cat .env.local"
assert_deny  "head ~/.ssh/id_rsa"         "head ~/.ssh/id_rsa"
assert_deny  "tail id_ed25519"            "tail id_ed25519"
assert_deny  "grep password .env"         "grep password .env"
assert_deny  "jq . secrets.json"          "jq . secrets.json"
assert_deny  "cat credentials.json"       "cat credentials.json"
assert_deny  "bat server.pem"             "bat server.pem"
assert_deny  "cat token.json"             "cat token.json"
assert_deny  "cat .npmrc"                 "cat .npmrc"
assert_deny  "rg API_KEY .env"            "rg API_KEY .env"
assert_deny  "sed -i s/x/y/ .env"        "sed -i s/x/y/ .env"

# Should allow: reader but no sensitive file
assert_allow "cat README.md"              "cat README.md"
assert_allow "grep TODO src/main.py"      "grep TODO src/main.py"
assert_allow "jq .name package.json"      "jq .name package.json"
assert_allow "head -20 index.ts"          "head -20 index.ts"

# Should allow: sensitive file but no reader command
assert_allow "ls .env"                    "ls .env"
assert_allow "rm .env"                    "rm .env"
assert_allow "cp .env .env.bak"           "cp .env .env.bak"
assert_allow "file credentials.json"      "file credentials.json"

# Edge cases
assert_allow "echo environment"           "echo environment"
assert_allow "cat .envrc"                 "cat .envrc"

# Fixed false positives: accessors, search terms, and word-bearing filenames
assert_allow "jq .key accessor"           "jq .key file.json"
assert_allow "jq to_entries .key"         "jq 'to_entries[] | .key' package.json"
assert_allow "jq nested .key"             "jq .data.key config.json"
assert_allow "jq .pem_config"             "jq .pem_config config.json"
assert_allow "cat secret-santa"           "cat secret-santa.txt"
assert_allow "grep credentials in source" "grep credentials src/auth.ts"
assert_allow "aws secretsmanager pipe jq" "aws secretsmanager get-secret-value | jq ."
assert_allow "jq .credentials accessor"   "jq .credentials.files settings.json"
assert_allow "jq .secrets accessor"       "jq .secrets config.json"

# Closed bypasses: unlisted readers and the command-substitution anchor gap
assert_deny  "base64 of private key"      "base64 id_rsa"
assert_deny  "source .env"                "source .env"
assert_deny  "cmd-subst cat .env"         "echo \$(cat .env)"
assert_deny  "cat .git-credentials"       "cat .git-credentials"
assert_deny  "cat aws credentials path"   "cat ~/.aws/credentials"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
