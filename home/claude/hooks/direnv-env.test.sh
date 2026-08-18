#!/bin/bash
# Tests for direnv-env.sh
SCRIPT="$(dirname "$0")/direnv-env.sh"
PASS=0
FAIL=0

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# direnv keeps its allow list under XDG_DATA_HOME. Scoping it to this run means
# the `direnv allow` below never touches the real one.
export XDG_DATA_HOME="$TMPROOT/data"

pass() { PASS=$((PASS + 1)); }
fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
}

check() { # desc, actual, expected
  if [ "$2" = "$3" ]; then pass; else fail "$1 (got '$2', want '$3')"; fi
}

check_match() { # desc, actual, pattern
  case "$2" in
    *$3*) pass ;;
    *) fail "$1 (got '$2', want match '$3')" ;;
  esac
}

# Seeds a fresh env file with one foreign line, then runs the hook against <cwd>.
# Sets ENVFILE, SNAP, RC, and writes stderr to $TMPROOT/err.
run_hook() { # label, cwd, [env prefix words...]
  local label="$1" cwd="$2"
  shift 2
  ENVFILE="$TMPROOT/env-$label.sh"
  SNAP="$ENVFILE.direnv"
  echo 'export FOREIGN_HOOK_LINE=1' > "$ENVFILE"
  printf '{"cwd":"%s"}' "$cwd" |
    CLAUDE_ENV_FILE="$ENVFILE" "$@" /bin/bash "$SCRIPT" 2> "$TMPROOT/err"
  RC=$?
}

lines() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo missing; }

# --- fixtures ---------------------------------------------------------------

mkdir -p "$TMPROOT/plain" "$TMPROOT/blocked" "$TMPROOT/loaded/bin"
echo 'export MARKER_BLOCKED=1' > "$TMPROOT/blocked/.envrc"
{
  echo 'export MARKER_LOADED=hello'
  echo 'PATH_add "$PWD/bin"'
} > "$TMPROOT/loaded/.envrc"
(cd "$TMPROOT/loaded" && direnv allow) 2> /dev/null

# A PATH holding direnv but no jq, to exercise the jq guard.
mkdir -p "$TMPROOT/nojq"
ln -sf "$(command -v direnv)" "$TMPROOT/nojq/direnv"

# --- guards: the hook must write nothing at all -----------------------------

printf '{}' | /bin/bash "$SCRIPT" > /dev/null 2>&1
check "no CLAUDE_ENV_FILE exits clean" "$?" "0"

run_hook nodirenv "$TMPROOT/plain" env PATH=/usr/bin:/bin
check "no direnv: exit 0" "$RC" "0"
check "no direnv: env file untouched" "$(lines "$ENVFILE")" "1"
check "no direnv: no snapshot" "$(lines "$SNAP")" "missing"

run_hook nojq "$TMPROOT/plain" env PATH="$TMPROOT/nojq"
check "no jq: exit 0" "$RC" "0"
check "no jq: env file untouched" "$(lines "$ENVFILE")" "1"
check "no jq: no snapshot" "$(lines "$SNAP")" "missing"

# --- no project environment applies -----------------------------------------

run_hook plain "$TMPROOT/plain" env
check "no config: exit 0" "$RC" "0"
check "no config: snapshot is a no-op" "$(cat "$SNAP")" "true"
check "no config: foreign line kept" \
  "$(grep -c FOREIGN_HOOK_LINE "$ENVFILE")" "1"

# --- a config file the user has not allowed ---------------------------------

run_hook blocked "$TMPROOT/blocked" env
check "blocked: exit 0" "$RC" "0"
check "blocked: snapshot is a no-op" "$(cat "$SNAP")" "true"
check "blocked: no variable escaped" "$(grep -c MARKER_BLOCKED "$SNAP")" "0"
check "blocked: no direnv bookkeeping" "$(grep -c DIRENV_ "$SNAP")" "0"
check_match "blocked: warns the user" "$(cat "$TMPROOT/err")" "direnv allow"

# --- a config file the user has allowed -------------------------------------

run_hook loaded "$TMPROOT/loaded" env
check "loaded: exit 0" "$RC" "0"
check "loaded: variable exported" \
  "$(grep -c "^export MARKER_LOADED=" "$SNAP")" "1"
check "loaded: no direnv bookkeeping" "$(grep -c DIRENV_ "$SNAP")" "0"
# The PATH line must stay relative. An absolute assignment would erase entries
# that other hooks prepended, whatever order the hooks ran in.
check "loaded: PATH line closes with the live PATH" \
  "$(grep -c "^export PATH='.*\":\$PATH\"$" "$SNAP")" "1"
# The added prefix must be just the project entry, not a whole copy of the
# hook's own PATH pasted in front of it.
check "loaded: PATH line adds one entry" \
  "$(grep "^export PATH='" "$SNAP" | tr ':' '\n' | wc -l | tr -d ' ')" "2"

# Sourcing must keep a PATH entry that an earlier hook added.
got=$(
  PATH="/sentinel/bin:$PATH"
  . "$ENVFILE" > /dev/null 2>&1
  case ":$PATH:" in *:/sentinel/bin:*) echo kept ;; *) echo lost ;; esac
)
check "loaded: earlier PATH entry survives" "$got" "kept"

got=$(
  . "$ENVFILE" > /dev/null 2>&1
  echo "$MARKER_LOADED"
)
check "loaded: value reaches the shell" "$got" "hello"

# --- idempotence and unloading ----------------------------------------------

printf '{"cwd":"%s"}' "$TMPROOT/loaded" |
  CLAUDE_ENV_FILE="$ENVFILE" /bin/bash "$SCRIPT" 2> /dev/null
check "second run adds no line" "$(lines "$ENVFILE")" "2"

printf '{"cwd":"%s"}' "$TMPROOT/plain" |
  CLAUDE_ENV_FILE="$ENVFILE" /bin/bash "$SCRIPT" 2> /dev/null
check "leaving the project empties the snapshot" "$(cat "$SNAP")" "true"
got=$(
  . "$ENVFILE" > /dev/null 2>&1
  echo "${MARKER_LOADED:-unset}"
)
check "leaving the project drops the value" "$got" "unset"

# --- a snapshot deleted under a live session --------------------------------

rm -f "$SNAP"
err=$(
  . "$ENVFILE" 2>&1 > /dev/null
  echo "rc=$?"
)
check "deleted snapshot sources silently" "$err" "rc=0"

# --- no residue -------------------------------------------------------------

check "no stray temp files" \
  "$(ls "$TMPROOT" | grep -c -e '\.err$' -e '\.new$')" "0"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
