#!/usr/bin/env bash
# PreToolUse hook: gate `gh pr create` on the /git pr skill's body artifact.
# The skill writes <artifact_dir>/pr.md and invokes `gh pr create --body-file <artifact_dir>/pr.md`,
# where <artifact_dir> is /tmp/claude/<session id>/<worktree hash> (see the git skill's commit-hook.md).
# The hook refuses the command unless --body-file names a pr.md in this session's directory and the file exists.
# Because gh reads the body directly from the file, the artifact IS the body — no separate
# content comparison is needed. Manual `gh pr create` from a real terminal bypasses this hook
# entirely (hooks only fire inside Claude Code).
set -euo pipefail

# Gate: only enforce when running inside Claude Code (PreToolUse already implies this; this is parity with commit-msg).
[[ "${CLAUDECODE:-}" == "1" ]] || exit 0

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command')

# Match only commands that START with `gh pr create` (after optional leading whitespace) — single-command scope; substring mentions in `echo`, `grep`, etc. are passed through.
if ! printf '%s' "$COMMAND" | grep -Eq '^[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
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

# The session id is the same one Claude Code exports to Bash as CLAUDE_CODE_SESSION_ID.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
if [[ -z "$SESSION_ID" ]]; then
  deny "gh pr create blocked: the hook input carries no session_id, so the body file cannot be checked. To bypass once: SKIP_PR_GATE=1 gh pr create ..."
fi
ARTIFACT="/tmp/claude/${SESSION_ID}/<worktree hash>/pr.md"

# Extract the --body-file argument (supports both `--body-file PATH` and `--body-file=PATH`), returning the LAST match to mirror gh's last-wins flag semantics.
BODY_FILE=$(printf '%s' "$COMMAND" | perl -ne '
  while (/--body-file[= ]("([^"]*)"|'"'"'([^'"'"']*)'"'"'|(\S+))/g) {
    $last = $2 // $3 // $4;
  }
  END { print $last if defined $last; }
')

if [[ -z "$BODY_FILE" ]]; then
  # Refuse --body "..." (mangles `!` via zsh history expansion) and bodyless creates.
  deny "gh pr create blocked: must pass --body-file ${ARTIFACT} (the /git pr skill writes it). For a manual run, execute gh pr create outside Claude Code."
fi

# The worktree hash is 12 hex digits; only the session part must match exactly.
if [[ ! "$BODY_FILE" =~ ^/tmp/claude/"$SESSION_ID"/[0-9a-f]{12}/pr\.md$ ]]; then
  deny "gh pr create blocked: --body-file is '${BODY_FILE}', expected '${ARTIFACT}'. Run the /git pr skill, which writes the canonical body file."
fi

if [[ ! -f "$BODY_FILE" ]]; then
  deny "gh pr create blocked: ${BODY_FILE} does not exist. Run the /git pr skill to draft and write the body before invoking gh pr create. To bypass once: SKIP_PR_GATE=1 gh pr create ..."
fi

# Artifact is present and wired to --body-file. Allow.
# Do NOT delete the artifact here — gh pr create still needs to read it.
# The /git pr skill removes the body file after the gh invocation returns.
exit 0
