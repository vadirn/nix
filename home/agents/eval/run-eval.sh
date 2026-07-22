#!/usr/bin/env bash
# Archetype A/B runner.
#
# Two conditions differ only by the §Reasoning block delivered as the system
# prompt: conditions/a-current.md (AGENTS.md:3-42 on main) versus
# conditions/b-proposed.md (diagnostician / ponytail / witness / lexicographer).
# Everything else — model, prompts, temperature, seed policy — is held fixed,
# so the single factor that differs between the arms is the archetype text.
#
# Runs against GLM on Fireworks. GLM returns reasoning_content separately from
# content; only content is written out, matching the archetype's own split
# between thinking and shipped answer.
#
# Usage:
#   doppler run --no-fallback --project claude-code --config std -- \
#     bash run-eval.sh [reps]
#
# Env: MODEL overrides the default GLM id. PAR overrides concurrency.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
reps="${1:-5}"
model="${MODEL:-accounts/fireworks/models/glm-5p2}"
par="${PAR:-6}"
: "${FIREWORKS_API_KEY:?wrap the call in: doppler run --no-fallback --project claude-code --config std --}"

# Worker: one API call, one output file. Self-dispatch keeps this a single file.
if [ "${1:-}" = "--one" ]; then
  cond="$2"; id="$3"; rep="$4"
  out="$AGENTS_EVAL_DATA/corpus/glm/${cond}__${id}__${rep}.txt"
  [ -s "$out" ] && exit 0   # resumable: never re-bill a completed cell

  sys="$(cat "$here/conditions/${cond}.md")"
  # The answer tag is appended identically in both arms, so it cannot confound
  # them. It exists because GLM leaks chain-of-thought into `content` under a
  # long system prompt, and condition A's own text ("the full analysis runs in
  # the thinking") invites exactly that. Scoring unseparated output would
  # measure how much reasoning each arm provoked instead of its shipped prose.
  usr="$(jq -r --arg id "$id" 'select(.id==$id) | .prompt' "$here/cases.jsonl")
Put your final answer between <answer> and </answer> tags."

  body="$(jq -n --arg m "$model" --arg s "$sys" --arg u "$usr" \
    '{model:$m, max_tokens:4500, temperature:1,
      messages:[{role:"system",content:$s},{role:"user",content:$u}]}')"
  # 4500: GLM intermittently fails to open its reasoning channel and spends the
  # whole budget deliberating inside `content`. A tight budget would then drop
  # exactly the cells where an arm deliberated most, which is a biased loss.

  resp="$(curl -sS --max-time 180 \
    -H "Authorization: Bearer $FIREWORKS_API_KEY" \
    -H "Content-Type: application/json" \
    -X POST https://api.fireworks.ai/inference/v1/chat/completions \
    -d "$body")"

  mkdir -p "$AGENTS_EVAL_DATA/raw"
  printf '%s' "$resp" > "$AGENTS_EVAL_DATA/raw/${cond}__${id}__${rep}.json"

  content="$(jq -r '.choices[0].message.content // empty' <<<"$resp")"
  if [ -z "$content" ]; then
    echo "ERROR $(jq -rc '.error // .' <<<"$resp")" >&2
    exit 1
  fi

  # Keep only what the model shipped. A cell with no tag is dropped rather than
  # scored on leaked reasoning; score.sh counts the gaps.
  # Longest complete block, never the first: models restate the instruction
  # ("between <answer> and </answer> tags") while deliberating, and a
  # first-match reader returns the word "and" from that echo. Requiring the
  # closing tag also keeps a truncated answer from scoring as short and clean.
  answer="$(python3 -c 'import re,sys
b=re.findall(r"<answer>(.*?)</answer>", sys.stdin.read(), re.S)
print(max(b, key=len).strip() if b else "")' <<<"$content")"
  if [ "$(wc -w <<<"$answer" | tr -d ' ')" -lt 40 ]; then
    echo "NOTAG ${cond}/${id}/${rep}" >&2
    printf '%s\n' "$content" > "$AGENTS_EVAL_DATA/raw/${cond}__${id}__${rep}.notag.txt"
    exit 1
  fi
  printf '%s\n' "$answer" > "$out"
  echo "ok ${cond}/${id}/${rep}"
  exit 0
fi

mkdir -p "$AGENTS_EVAL_DATA/corpus/glm"

jobs="$here/.jobs"
trap 'rm -f "$jobs"' EXIT
for cond in ${CONDS:-a-current b-proposed}; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id="$(jq -r '.id' <<<"$line")"
    for r in $(seq 1 "$reps"); do
      printf '%s %s %s\n' "$cond" "$id" "$r"
    done
  done <"$here/cases.jsonl"
done >"$jobs"

total=$(wc -l <"$jobs")
echo "model: $model"
echo "cells: $total (2 conditions x $(wc -l <"$here/cases.jsonl") cases x $reps reps), concurrency $par"

# shellcheck disable=SC2016
xargs -P "$par" -n 3 bash -c 'bash "$0" --one "$@" || echo "FAILED $*" >&2' "$here/run-eval.sh" <"$jobs"

echo
echo "outputs: $AGENTS_EVAL_DATA/corpus/glm ($(find "$AGENTS_EVAL_DATA/corpus/glm" -name '*.txt' | wc -l | tr -d ' ') files)"
