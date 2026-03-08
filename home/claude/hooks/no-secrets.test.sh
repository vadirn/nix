#!/bin/bash
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

# Known false positives (intentionally paranoid)
assert_deny  "jq .key (false positive)"   "jq .key file.json"
assert_deny  "cat secret-santa (false positive)" "cat secret-santa.txt"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
