#!/bin/bash
# Tests for stop-remind.sh — the Stop hook that asks Jev whether the finished
# turn needs a crux, SDLC or confidence reminder. Requires jq. A fake curl and
# a fake security on PATH keep the suite offline.
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export FAKE="$WORK"
mkdir -p "$WORK/bin"

cat >"$WORK/bin/curl" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" >"$FAKE/curl.args"
cat >"$FAKE/curl.body"
for a in "$@"; do
  case "$a" in @/*) cat "${a#@}" >"$FAKE/curl.headers" ;; esac
done
[ "${FAKE_CURL_EXIT:-0}" -eq 0 ] || exit "$FAKE_CURL_EXIT"
cat "$FAKE/response.json"
EOF
cat >"$WORK/bin/security" <<'EOF'
#!/bin/bash
touch "$FAKE/security.called"
exit 44
EOF
chmod +x "$WORK/bin/curl" "$WORK/bin/security"
export PATH="$WORK/bin:$PATH"
export TYPESAFE_API_KEY="test-key-123"

prompt() { jq -nc --arg t "$1" '{type: "user", message: {role: "user", content: $t}}'; }
prompt_parts() {
  jq -nc --arg a "$1" --arg b "$2" \
    '{type: "user", message: {role: "user", content: [{type: "text", text: $a}, {type: "text", text: $b}]}}'
}
tool() {
  jq -nc --arg n "$1" --argjson i "$2" \
    '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", id: "t", name: $n, input: $i}]}}'
}
result() {
  jq -nc --arg c "$1" \
    '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: "t", content: $c}]}}'
}
say() { jq -nc --arg t "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "text", text: $t}]}}'; }

# respond <crux> <sdlc> <confidence> writes the fake Jev reply
respond() {
  jq -nc --arg m "${MODEL:-jev-1.13.0}" --argjson c "$1" --argjson s "$2" --argjson f "$3" \
    '{model: $m, answers: {crux: {type: "noul", noul: $c}, sdlc: {type: "noul", noul: $s}, confidence: {type: "noul", noul: $f}}}' \
    >"$WORK/response.json"
}

# run <transcript> <last message> [stop_hook_active]
run() {
  rm -f "$WORK"/curl.* "$WORK/security.called"
  jq -nc --arg p "$1" --arg m "$2" --argjson a "${3:-false}" \
    '{session_id: "s", transcript_path: $p, hook_event_name: "Stop", stop_hook_active: $a, last_assistant_message: $m}' \
    | bash "$HOOKS/stop-remind.sh"
}

check() {
  local desc="$1" cond="$2"
  if eval "$cond"; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL: $desc"
  fi
}

# A previous turn wrote crux and read nothing from the SDLC notes
T="$WORK/basic.jsonl"
{
  prompt_parts "<system-reminder>CLAUDE.md body</system-reminder>" "first question"
  tool "mcp__crux__add_note" '{"goal": "g", "body": "b"}'
  result "ok"
  say "done 1"
  prompt "fix the parser"
  jq -nc '{type: "user", isSidechain: true, message: {role: "user", content: "subagent prompt"}}'
  tool "Bash" '{"command": "echo sk-live-SECRET", "description": "Run the parser tests"}'
  result "3 passed"
  tool "Edit" '{"file_path": "/repo/src/parser.ts", "old_string": "a", "new_string": "b"}'
  result "ok"
  say "Fixed."
} >"$T"

respond 0.95 0.95 0.95
OUT=$(run "$T" "The parser is fixed.")
REASON=$(jq -r .reason <<<"$OUT")
BODY=$(cat "$WORK/curl.body")
check "blocks the stop" '[ "$(jq -r .decision <<<"$OUT")" = block ]'
check "reminds to update crux" 'grep -qF "Update crux" <<<"$REASON"'
check "reminds to check SDLC" 'grep -qF "vault-query get ~SDLC" <<<"$REASON"'
check "reminds to grade confidence" 'grep -qF "Grade your confidence" <<<"$REASON"'
check "pins the Jev model" '[ "$(jq -r .model <<<"$BODY")" = jev-1.13.0 ]'
check "asks all three questions" \
  '[ "$(jq -c ".questions | keys" <<<"$BODY")" = "[\"confidence\",\"crux\",\"sdlc\"]" ]'
check "sends the turn prompt, not a sidechain prompt" \
  '[ "$(jq -r .state.request <<<"$BODY")" = "fix the parser" ]'
check "sends this turn'\''s tools with one argument each" \
  '[ "$(jq -c .state.tools <<<"$BODY")" = "[{\"name\":\"Bash\",\"arg\":\"Run the parser tests\"},{\"name\":\"Edit\",\"arg\":\"/repo/src/parser.ts\"}]" ]'
check "never sends a Bash command" '! grep -qF "sk-live-SECRET" <<<"$BODY"'
check "never sends a tool result" '! grep -qF "3 passed" <<<"$BODY"'
check "sends the final answer from stdin" '[ "$(jq -r .state.answer <<<"$BODY")" = "The parser is fixed." ]'
check "keeps the key off argv" '! grep -qF "test-key-123" "$WORK/curl.args"'
check "sends the key as a bearer header" 'grep -qF "Authorization: Bearer test-key-123" "$WORK/curl.headers"'

# Without last_assistant_message the transcript's last text stands in
rm -f "$WORK"/curl.*
jq -nc --arg p "$T" '{transcript_path: $p, stop_hook_active: false}' | bash "$HOOKS/stop-remind.sh" >/dev/null
check "falls back to the transcript answer" '[ "$(jq -r .state.answer "$WORK/curl.body")" = "Fixed." ]'

# A half-written last line keeps every complete line before it
CUT="$WORK/cut.jsonl"
cp "$T" "$CUT"
printf '{"type":"assistant","message":{"role":"assis' >>"$CUT"
OUT=$(run "$CUT" "The parser is fixed.")
check "survives a cut-off transcript tail" '[ "$(jq -r .decision <<<"$OUT")" = block ]'
check "cut-off tail keeps the turn prompt" '[ "$(jq -r .state.request "$WORK/curl.body")" = "fix the parser" ]'

# A meta entry, such as a compaction summary, never becomes the prompt
META="$WORK/meta.jsonl"
cp "$T" "$META"
jq -nc '{type: "user", isMeta: true, message: {role: "user", content: "summary of earlier work"}}' >>"$META"
run "$META" "x" >/dev/null
check "skips meta entries" '[ "$(jq -r .state.request "$WORK/curl.body")" = "fix the parser" ]'

# System reminders never leave the machine
T2="$WORK/reminder.jsonl"
prompt_parts "<system-reminder>CLAUDE.md body</system-reminder>" "second question" >"$T2"
run "$T2" "An answer." >/dev/null
check "strips system-reminder blocks" '[ "$(jq -r .state.request "$WORK/curl.body")" = "second question" ]'

# Gates met in the transcript are never asked
T3="$WORK/partial.jsonl"
{
  prompt "plan the change"
  tool "Bash" '{"command": "vault-query consult x", "description": "Consult the vault"}'
  result "## ~SDLC (30 notes/SDLC/~SDLC.md)"
  tool "mcp__57b9e6ea__record_decision" '{"goal": "g"}'
  result "ok"
} >"$T3"
run "$T3" "Use a state table." >/dev/null
check "asks only the ungated question" \
  '[ "$(jq -c ".questions | keys" "$WORK/curl.body")" = "[\"confidence\"]" ]'

OUT=$(run "$T3" "Use a state table. Confidence: 8/10.")
check "every gate met emits nothing" '[ -z "$OUT" ]'
check "every gate met makes no call" '[ ! -f "$WORK/curl.args" ]'

# Thresholds
respond 0.2 0.5 0.79
check "below threshold emits nothing" '[ -z "$(run "$T" "x")" ]'
respond 0.9 0.1 0.1
OUT=$(run "$T" "x")
REASON=$(jq -r .reason <<<"$OUT")
check "lists only what fired" \
  'grep -qF "Update crux" <<<"$REASON" && ! grep -qF "SDLC" <<<"$REASON" && ! grep -qF "Grade" <<<"$REASON"'
respond 0.6 0.6 0.6
check "threshold is overridable" \
  '[ -n "$(STOP_REMIND_THRESHOLD=0.5 run "$T" "x")" ]'

# Loop guard
respond 0.95 0.95 0.95
check "stop_hook_active emits nothing" '[ -z "$(run "$T" "x" true)" ]'
check "stop_hook_active makes no call" '[ ! -f "$WORK/curl.args" ]'

# Fail open
check "missing transcript emits nothing" '[ -z "$(run "$WORK/gone.jsonl" "x")" ]'
MODEL=jev-latest respond 0.95 0.95 0.95
check "unexpected model emits nothing" '[ -z "$(run "$T" "x")" ]'
jq -nc '{model: "jev-1.13.0", answers: {crux: {type: "noul", noul: "high"}}}' >"$WORK/response.json"
check "malformed answer emits nothing" '[ -z "$(run "$T" "x")" ]'
jq -nc '{model: "jev-1.13.0", answers: {crux: {type: "noul", noul: 1.5}}}' >"$WORK/response.json"
check "out-of-range answer emits nothing" '[ -z "$(run "$T" "x")" ]'
respond 0.95 0.95 0.95
check "curl failure emits nothing" '[ -z "$(FAKE_CURL_EXIT=22 run "$T" "x")" ]'
FAKE_CURL_EXIT=28 run "$T" "x" >/dev/null
CODE=$?
check "curl failure exits 0" '[ "$CODE" -eq 0 ]'
OUT=$(TYPESAFE_API_KEY="" run "$T" "x")
check "missing key emits nothing" '[ -z "$OUT" ]'
check "missing key tries the keychain" '[ -f "$WORK/security.called" ]'
check "missing key makes no call" '[ ! -f "$WORK/curl.args" ]'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
