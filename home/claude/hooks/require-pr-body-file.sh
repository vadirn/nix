#!/usr/bin/env bash
# PreToolUse hook: gate `gh pr create` on the /pr skill's body artifact.
# The skill writes /tmp/claude/pr.md and invokes `gh pr create --body-file /tmp/claude/pr.md`.
# The hook refuses the command unless it points --body-file at that artifact and the file exists.
# Because gh reads the body directly from the file, the artifact IS the body — no separate
# content comparison is needed. Manual `gh pr create` from a real terminal bypasses this hook
# entirely (hooks only fire inside Claude Code).
set -euo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command')

# Pass through anything that is not a gh pr create invocation.
if ! printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:];|&])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  exit 0
fi

# Kill-switch: per-invocation bypass.
[[ "${SKIP_PR_GATE:-}" == "1" ]] && exit 0

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

ARTIFACT="/tmp/claude/pr.md"

# Extract the --body-file argument (supports both `--body-file PATH` and `--body-file=PATH`).
BODY_FILE=$(printf '%s' "$COMMAND" | perl -ne '
  if (/--body-file[= ]("([^"]*)"|'"'"'([^'"'"']*)'"'"'|(\S+))/) {
    print $2 // $3 // $4;
    exit;
  }
')

if [[ -z "$BODY_FILE" ]]; then
  # Refuse --body "..." (mangles `!` via zsh history expansion) and bodyless creates.
  deny "gh pr create blocked: must pass --body-file ${ARTIFACT} (the /pr skill writes it). For a manual run, execute gh pr create outside Claude Code."
fi

if [[ "$BODY_FILE" != "$ARTIFACT" ]]; then
  deny "gh pr create blocked: --body-file is '${BODY_FILE}', expected '${ARTIFACT}'. Run the /pr skill, which writes the canonical body file."
fi

if [[ ! -f "$ARTIFACT" ]]; then
  deny "gh pr create blocked: ${ARTIFACT} does not exist. Run the /pr skill to draft and write the body before invoking gh pr create. To bypass once: SKIP_PR_GATE=1 gh pr create ..."
fi

# Artifact is present and wired to --body-file. Allow.
# Do NOT delete the artifact here — gh pr create still needs to read it.
# The /pr skill removes /tmp/claude/pr.md after the gh invocation returns.
exit 0
