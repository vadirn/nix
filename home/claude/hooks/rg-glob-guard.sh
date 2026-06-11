#!/bin/bash
# Block rg invocations that use a negated -g/--glob.
# The Claude Code Bash tool escapes every "!" in a command as "\!" (zsh
# history-expansion guard), even inside single quotes. rg then reads the glob
# as a literal-"!" match instead of a negation: the exclusion silently no-ops,
# and a glob set with no effective positive glob matches NOTHING, so the
# search returns empty with exit 1 and no error message.
# Verified 2026-06-11: `printf '%s' '!'` arrives as `\!`; rg handles negated
# globs correctly when the "!" is constructed at runtime (printf '\x21').
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Only inspect commands that invoke rg
[[ "$COMMAND" =~ (^|[[:space:]]|[\|\;\&\(/])rg[[:space:]] ]] || exit 0

# Collect -g/--glob arguments (quoted, bare, attached, or =-joined)
GLOBS=$(echo "$COMMAND" \
  | grep -oE -- "(-g|--glob)(=|[[:space:]]*)('[^']*'|\"[^\"]*\"|[^[:space:]]+)" \
  | sed -E "s/^(-g|--glob)(=|[[:space:]]*)//; s/^['\"]//; s/['\"]$//")

[[ -z "$GLOBS" ]] && exit 0

# Negation intent: leading "!" (raw) or "\!" (already escaped by the harness)
echo "$GLOBS" | grep -qE '^\\?!' || exit 0

jq -n '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked: the Bash tool escapes ! as \\! even inside quotes, so a negated rg glob reaches rg as a literal-! match. The exclusion silently no-ops; with no positive glob the search returns empty. Drop the glob (rg already skips .git and gitignored files by default), or construct the ! at runtime: -g \"$(printf '\''\\x21%s'\'' \"*.lock\")\"."
  }
}'

exit 0
