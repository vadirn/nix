#!/usr/bin/env bash
# Consult eval runner.
#
# Usage: run-eval.sh <vault-query-binary>
#
# Runs every case in consult-eval.jsonl against the live vault (the binary
# resolves it from .vault.config.json walk-up or ~/.config/vault/config.json)
# and classifies each outcome by exit code first, then — for positives — by
# membership of expected_path in docs[].path or pointers[].path per expected_in.
#
# The deployed on-PATH binary may be stale; pass a fresh build:
#   bash vault-query/eval/run-eval.sh vault-query/target/release/vault-query
#
# Cases are content-coupled to the live vault. The pointer case targets
# "30 notes/Project as a skill.md" (over the consult per-doc cap); if that note
# is ever split by concept, the case flips to docs — update it then.
set -euo pipefail

bin="${1:?usage: run-eval.sh <vault-query-binary>}"
cases="$(dirname "$0")/consult-eval.jsonl"

pass=0
fail=0

while IFS= read -r line; do
  [ -z "$line" ] && continue

  id=$(jq -r '.id' <<<"$line")
  query=$(jq -r '.query' <<<"$line")
  expected_exit=$(jq -r '.expected_exit' <<<"$line")
  expected_path=$(jq -r '.expected_path // empty' <<<"$line")
  expected_in=$(jq -r '.expected_in // empty' <<<"$line")

  # Capture exit code without tripping set -e (sentinel pattern).
  rc=0
  out=$("$bin" consult "$query" --format json --no-log --types card,note,experiment) || rc=$?

  if [ "$rc" -ne "$expected_exit" ]; then
    echo "FAIL $id: exit $rc, expected $expected_exit (query: $query)"
    fail=$((fail + 1))
    continue
  fi

  if [ -n "$expected_path" ]; then
    found=$(jq -r --arg p "$expected_path" --arg w "$expected_in" \
      '.[$w] // [] | map(.path) | index($p) != null' <<<"$out")
    if [ "$found" != "true" ]; then
      echo "FAIL $id: '$expected_path' not in $expected_in (query: $query)"
      fail=$((fail + 1))
      continue
    fi
  fi

  echo "PASS $id"
  pass=$((pass + 1))
done <"$cases"

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
