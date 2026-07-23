#!/usr/bin/env bash
# Same experiment, same cases, same scorer — Claude instead of GLM.
#
# Isolation comes from --safe-mode, which disables CLAUDE.md discovery, skills,
# plugins, hooks, and MCP while leaving auth working. Verified: the same probe
# answers "Yes" without the flag and "no" with it, so the global AGENTS.md is
# genuinely absent and each arm sees only its own condition file.
#
# Everything except the condition file is held fixed, so the single factor that
# differs between arms is the archetype text.
#
# Usage: CONDS="a-current c-slot" bash run-claude.sh [reps]
# Env: CLAUDE_MODEL (default: session default), PAR (default 4).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/config.sh"
cases="$here/${CASES:-cases.jsonl}"
outdir="$AGENTS_EVAL_DATA/corpus/${CORPUS:-claude}"
reps="${1:-3}"
par="${PAR:-4}"
model_args=()
[ -n "${CLAUDE_MODEL:-}" ] && model_args=(--model "$CLAUDE_MODEL")

if [ "${1:-}" = "--one" ]; then
  cond="$2"; id="$3"; rep="$4"
  out="$outdir/${cond}__${id}__${rep}.txt"
  [ -s "$out" ] && exit 0

  usr="$(jq -r --arg id "$id" 'select(.id==$id) | .prompt' "$cases")
Put your final answer between <answer> and </answer> tags."

  # cwd is a scratch dir with no CLAUDE.md, belt-and-braces alongside --safe-mode.
  # bash 3.2 treats an empty array as unbound under set -u; guard the expansion.
  content="$(cd "$here/sandbox" && claude -p --safe-mode ${model_args[@]+"${model_args[@]}"} \
    --append-system-prompt-file "$here/conditions/${cond}.md" "$usr" 2>/dev/null)" || true

  answer="$(python3 -c 'import re,sys
t=sys.stdin.read()
b=re.findall(r"<answer>(.*?)</answer>", t, re.S)
print(max(b, key=len).strip() if b else t.strip())' <<<"$content")"

  if [ "$(wc -w <<<"$answer" | tr -d ' ')" -lt 40 ]; then
    echo "SHORT ${cond}/${id}/${rep}" >&2
    exit 1
  fi
  mkdir -p "$outdir"
  printf '%s\n' "$answer" > "$out"
  echo "ok ${cond}/${id}/${rep}"
  exit 0
fi

mkdir -p "$outdir" "$here/sandbox"

# Unique per invocation, so two arms can run concurrently without clobbering
# each other's queue. CORPUS distinguishes them in the filename.
jobs="$here/.jobs-claude.${CORPUS:-claude}.$$"
trap 'rm -f "$jobs"' EXIT
for cond in ${CONDS:-a-current b-proposed c-slot}; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id="$(jq -r '.id' <<<"$line")"
    for r in $(seq 1 "$reps"); do printf '%s %s %s\n' "$cond" "$id" "$r"; done
  done <"$cases"
done >"$jobs"

echo "arms: ${CONDS:-a-current b-proposed c-slot} | cells: $(wc -l <"$jobs") | concurrency $par"
xargs -P "$par" -n 3 bash -c 'bash "$0" --one "$@" || echo "FAILED $*" >&2' "$here/run-claude.sh" <"$jobs"
echo "outputs: $outdir ($(find "$outdir" -name '*.txt' | wc -l | tr -d ' ') files)"
