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

# --- a project that replaces PATH outright ----------------------------------

# direnv's value then shares no suffix with the live PATH, which is the case
# that used to produce a bare assignment and wipe other hooks' entries.
mkdir -p "$TMPROOT/override"
printf 'export PATH=/usr/bin:/bin\n' > "$TMPROOT/override/.envrc"
(cd "$TMPROOT/override" && direnv allow) 2> /dev/null

run_hook override "$TMPROOT/override" env
check "override: exit 0" "$RC" "0"
check "override: prepends, never assigns" \
  "$(grep -c "^export PATH='.*\":\$PATH\"$" "$SNAP")" "1"
check "override: project entry comes first" \
  "$(grep -c "^export PATH='/usr/bin:/bin'" "$SNAP")" "1"
got=$(
  PATH="/sentinel/bin:$PATH"
  . "$ENVFILE" > /dev/null 2>&1
  case ":$PATH:" in *:/sentinel/bin:*) echo kept ;; *) echo lost ;; esac
)
check "override: earlier PATH entry survives" "$got" "kept"

# --- NIX_PATH missing, as under the desktop app -----------------------------

# Desktop-app hooks inherit launchd's environment, which lacks nix-darwin's
# NIX_PATH. Fake zsh and direnv check the hand-off without a nix evaluation.
mkdir -p "$TMPROOT/nozsh" "$TMPROOT/fakezsh" "$TMPROOT/emptyzsh"
for tool in env grep jq mv rm; do
  ln -sf "$(command -v "$tool")" "$TMPROOT/nozsh/$tool"
done
cat > "$TMPROOT/nozsh/direnv" << 'EOF'
#!/bin/bash
# Exports the NIX_PATH it inherited, or "unset" when it inherited none.
printf '{"SEEN_NIX_PATH":"%s"}\n' "${NIX_PATH-unset}"
EOF
cat > "$TMPROOT/fakezsh/zsh" << 'EOF'
#!/bin/bash
# Like /etc/zshenv, yields NIX_PATH only while nix-darwin's guard is unset.
echo called >> "${0%/*}/calls"
[ -n "${__NIX_DARWIN_SET_ENVIRONMENT_DONE:-}" ] || echo 'nixpkgs=/fake/nixpkgs'
EOF
printf '#!/bin/bash\n' > "$TMPROOT/emptyzsh/zsh"
chmod +x "$TMPROOT/nozsh/direnv" "$TMPROOT/fakezsh/zsh" "$TMPROOT/emptyzsh/zsh"

seen() { grep -c "^export SEEN_NIX_PATH='$1'$" "$SNAP"; }
parses() { bash -n "$SNAP" 2> /dev/null && echo yes || echo no; }
no_nix=(env -u NIX_PATH -u __NIX_DARWIN_SET_ENVIRONMENT_DONE)

run_hook nixset "$TMPROOT/plain" env NIX_PATH=/from/parent \
  PATH="$TMPROOT/fakezsh:$TMPROOT/nozsh"
check "NIX_PATH set: exit 0" "$RC" "0"
check "NIX_PATH set: direnv gets it unchanged" "$(seen /from/parent)" "1"
check "NIX_PATH set: zsh never runs" "$(lines "$TMPROOT/fakezsh/calls")" "missing"

run_hook nixzsh "$TMPROOT/plain" "${no_nix[@]}" \
  PATH="$TMPROOT/fakezsh:$TMPROOT/nozsh"
check "no NIX_PATH: exit 0" "$RC" "0"
check "no NIX_PATH: direnv gets zsh's value" "$(seen nixpkgs=/fake/nixpkgs)" "1"

# A parent can export the guard without NIX_PATH. zsh would then skip
# nix-darwin's script, so the hook must drop the guard before asking.
run_hook nixguard "$TMPROOT/plain" env -u NIX_PATH \
  __NIX_DARWIN_SET_ENVIRONMENT_DONE=1 PATH="$TMPROOT/fakezsh:$TMPROOT/nozsh"
check "guard inherited: direnv gets zsh's value" \
  "$(seen nixpkgs=/fake/nixpkgs)" "1"

run_hook nixempty "$TMPROOT/plain" "${no_nix[@]}" \
  PATH="$TMPROOT/emptyzsh:$TMPROOT/nozsh"
check "zsh yields nothing: exit 0" "$RC" "0"
check "zsh yields nothing: NIX_PATH stays unset" "$(seen unset)" "1"
check "zsh yields nothing: snapshot parses" "$(parses)" "yes"

run_hook nixnozsh "$TMPROOT/plain" "${no_nix[@]}" PATH="$TMPROOT/nozsh"
check "no zsh: exit 0" "$RC" "0"
check "no zsh: NIX_PATH stays unset" "$(seen unset)" "1"
check "no zsh: snapshot parses" "$(parses)" "yes"
check "no zsh: stderr stays quiet" "$(cat "$TMPROOT/err")" ""

# --- no residue -------------------------------------------------------------

check "no stray temp files" \
  "$(ls "$TMPROOT" | grep -c -e '\.err$' -e '\.new$')" "0"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
