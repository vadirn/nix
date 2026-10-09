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
# The hook records blocked turns under TMPDIR.
export TMPDIR="$WORK"
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
[ -z "${FAKE_SECURITY_SLEEP:-}" ] || exec sleep "$FAKE_SECURITY_SLEEP"
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
compaction() {
  jq -nc '{type: "system", subtype: "compact_boundary"}'
  jq -nc '{type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: {role: "user", content: "This session is being continued from a previous conversation."}}'
}

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
    | bash "$HOOKS/stop-remind.sh" 2>"$WORK/stderr"
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
check "cut-off tail keeps the last complete line" '[ "$(jq -r .state.answer "$WORK/curl.body")" = "The parser is fixed." ]'

# A compaction summary mid-turn never becomes the prompt
COMP="$WORK/compact.jsonl"
{
  prompt "ship the fix"
  tool "mcp__crux__add_note" '{"goal": "g", "body": "b"}'
  result "ok"
  compaction
  tool "Edit" '{"file_path": "/repo/a.ts"}'
  result "ok"
} >"$COMP"
run "$COMP" "x" >/dev/null
check "skips compaction summaries" '[ "$(jq -r .state.request "$WORK/curl.body")" = "ship the fix" ]'
check "keeps crux writes from before a mid-turn compaction" '! jq -e ".questions.crux" "$WORK/curl.body" >/dev/null'

# A prompt with a pasted image starts the turn
IMG="$WORK/image.jsonl"
{
  prompt "old question"
  tool "mcp__crux__add_note" '{"goal": "g", "body": "b"}'
  result "ok"
  jq -nc '{type: "user", message: {role: "user", content: [{type: "image", source: {type: "base64", data: "IMAGEDATA"}}, {type: "text", text: "fix this layout"}]}}'
  tool "Edit" '{"file_path": "/repo/a.css"}'
  result "ok"
} >"$IMG"
run "$IMG" "x" >/dev/null
check "an image prompt starts the turn" '[ "$(jq -r .state.request "$WORK/curl.body")" = "fix this layout" ]'
check "an image prompt leaves earlier crux writes out" 'jq -e ".questions.crux" "$WORK/curl.body" >/dev/null'
check "never sends image data" '! grep -qF "IMAGEDATA" "$WORK/curl.body"'

# A slash command sends its name, arguments and expanded text
CMD="$WORK/command.jsonl"
{
  prompt "<command-message>code-review is running…</command-message>
<command-name>/code-review</command-name>
<command-args>high</command-args>"
  jq -nc '{type: "user", isMeta: true, message: {role: "user", content: [{type: "text", text: "Review the current diff."}]}}'
  tool "Bash" '{"command": "git diff", "description": "Show the diff"}'
  result "diff"
} >"$CMD"
run "$CMD" "x" >/dev/null
check "expands a slash command prompt" \
  'jq -e ".state.request == \"/code-review high\nReview the current diff.\"" "$WORK/curl.body" >/dev/null'
prompt "Fix the case where Jev gets <command-name>/code-review</command-name> alone." >"$CMD"
run "$CMD" "x" >/dev/null
check "a prompt quoting command tags stays as typed" \
  '[ "$(jq -r .state.request "$WORK/curl.body")" = "Fix the case where Jev gets <command-name>/code-review</command-name> alone." ]'

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
  tool "mcp__57b9e6ea-d0af-4b63-844c-6a0a98964d71__record_decision" '{"goal": "g"}'
  result "ok"
} >"$T3"
run "$T3" "Use a state table." >/dev/null
check "asks only the ungated question" \
  '[ "$(jq -c ".questions | keys" "$WORK/curl.body")" = "[\"confidence\"]" ]'

OUT=$(run "$T3" "Use a state table. Confidence: 8/10.")
check "every gate met emits nothing" '[ -z "$OUT" ]'
check "every gate met makes no call" '[ ! -f "$WORK/curl.args" ]'

run "$T3" "Step 3/10 failed, so use a state table." >/dev/null
check "a bare fraction is not a grade" \
  '[ "$(jq -c ".questions | keys" "$WORK/curl.body")" = "[\"confidence\"]" ]'

# The crux gate takes any crux write, and only crux's
CX="$WORK/crux.jsonl"
{
  prompt "tick the condition"
  tool "mcp__crux__set_done_condition" '{"condition": "c"}'
  result "ok"
} >"$CX"
run "$CX" "x" >/dev/null
check "any crux write meets the crux gate" '! jq -e ".questions.crux" "$WORK/curl.body" >/dev/null'
{
  prompt "file a ticket"
  tool "mcp__linear__create_item" '{"title": "t"}'
  result "ok"
} >"$CX"
run "$CX" "x" >/dev/null
check "another server's write does not" 'jq -e ".questions.crux" "$WORK/curl.body" >/dev/null'

# An SDLC note read before a compaction no longer counts
SD="$WORK/sdlc-compact.jsonl"
{
  prompt "read the process"
  tool "Read" '{"file_path": "/vault/30 notes/SDLC/~SDLC.md"}'
  result "process"
  say "ok"
  compaction
  prompt "implement it"
  tool "Edit" '{"file_path": "/repo/a.ts"}'
  result "ok"
} >"$SD"
run "$SD" "x" >/dev/null
check "SDLC notes before a compaction do not count" 'jq -e ".questions.sdlc" "$WORK/curl.body" >/dev/null'

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

# Loop guard: a turn this hook blocked passes its later stops
respond 0.95 0.95 0.95
run "$T" "x" >/dev/null
check "own block then stop_hook_active emits nothing" '[ -z "$(run "$T" "x" true)" ]'
check "own block then stop_hook_active makes no call" '[ ! -f "$WORK/curl.args" ]'
rm -f "$WORK/stop-remind.s"
check "another hook's block still gets reminders" '[ -n "$(run "$T" "x" true)" ]'

# A huge answer stays off argv and keeps its trailing grade
BIGANS="$WORK/big-answer.txt"
{
  head -c 2000000 /dev/zero | tr '\0' a
  printf ' Confidence: 8/10.'
} >"$BIGANS"
rm -f "$WORK"/curl.*
jq -nc --arg p "$T" --rawfile m "$BIGANS" '{transcript_path: $p, stop_hook_active: false, last_assistant_message: $m}' \
  | bash "$HOOKS/stop-remind.sh" >/dev/null 2>"$WORK/stderr"
check "a huge answer is cut to 8000 characters" '[ "$(jq -r ".state.answer | length" "$WORK/curl.body")" = 8000 ]'
check "a huge answer keeps its trailing grade" \
  '[ "$(jq -c ".questions | keys" "$WORK/curl.body")" = "[\"crux\",\"sdlc\"]" ]'

# Fail open, but visibly: exit 1 never blocks, and stderr says why
check "missing transcript emits nothing" '[ -z "$(run "$WORK/gone.jsonl" "x")" ]'
MODEL=jev-latest respond 0.95 0.95 0.95
check "unexpected model emits nothing" '[ -z "$(run "$T" "x")" ]'
check "unexpected model says so" 'grep -qF "unexpected model jev-latest" "$WORK/stderr"'
jq -nc '{model: "jev-1.13.0", answers: {crux: {type: "noul", noul: "high"}}}' >"$WORK/response.json"
check "malformed answer emits nothing" '[ -z "$(run "$T" "x")" ]'
jq -nc '{model: "jev-1.13.0", answers: {crux: {type: "noul", noul: 1.5}}}' >"$WORK/response.json"
check "out-of-range answer emits nothing" '[ -z "$(run "$T" "x")" ]'
check "out-of-range answer says so" 'grep -qF "invalid answer for crux" "$WORK/stderr"'
respond 0.95 0.95 0.95
check "curl failure emits nothing" '[ -z "$(FAKE_CURL_EXIT=22 run "$T" "x")" ]'
FAKE_CURL_EXIT=28 run "$T" "x" >/dev/null
CODE=$?
check "curl failure exits 1" '[ "$CODE" -eq 1 ]'
check "curl failure says so" 'grep -qF "TypeSafe request failed (curl exit 28)" "$WORK/stderr"'
OUT=$(TYPESAFE_API_KEY="" run "$T" "x")
check "missing key emits nothing" '[ -z "$OUT" ]'
check "missing key tries the keychain" '[ -f "$WORK/security.called" ]'
check "missing key makes no call" '[ ! -f "$WORK/curl.args" ]'
check "missing key says so" 'grep -qF "no TypeSafe key" "$WORK/stderr"'
START=$SECONDS
OUT=$(TYPESAFE_API_KEY="" FAKE_SECURITY_SLEEP=10 STOP_REMIND_KEYCHAIN_TIMEOUT=1 run "$T" "x")
ELAPSED=$((SECONDS - START))
check "a stuck keychain read gives up" '[ -z "$OUT" ] && [ "$ELAPSED" -lt 5 ]'

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
