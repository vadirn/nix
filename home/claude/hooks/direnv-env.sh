#!/usr/bin/env bash
# Load a project's direnv environment for Claude's Bash tool.
#
# Claude runs Bash non-interactively, so direnv's prompt hook never fires. The
# shell snapshot Claude sources before every command also ends with a frozen
# `export PATH`, which buries anything ~/.zshrc did. CLAUDE_ENV_FILE is sourced
# after that snapshot, so it is the only place a PATH change survives.
#
# Three things this does NOT do, all deliberate:
#
#   - It never overwrites CLAUDE_ENV_FILE. Every hook in the session shares that
#     file, so truncating it would drop sandbox-nc-path.sh's entry. It appends
#     one source line and rewrites its own snapshot instead.
#   - It never writes direnv's absolute PATH while a relative one will do. The
#     snapshot emits `export PATH='<added>':"$PATH"`, so entries other hooks
#     prepended survive whatever order the hooks ran in. Only a project that
#     removes an existing PATH entry forces the absolute form, and that warns.
#   - It never fails a shell. Every exit is 0, the snapshot always parses, and
#     the source line tolerates a snapshot that is missing or unreadable.

set -uo pipefail

[[ -n "${CLAUDE_ENV_FILE:-}" ]] || exit 0
command -v direnv > /dev/null 2>&1 || exit 0
command -v jq > /dev/null 2>&1 || exit 0

# Hooks receive the working directory on stdin. Trust it over $PWD so worktree
# sessions started by `clw` read their own .envrc.
input=$(cat 2> /dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2> /dev/null || true)
[[ -n "$cwd" && -d "$cwd" ]] && cd "$cwd"

snapshot="${CLAUDE_ENV_FILE}.direnv"
# Sits beside CLAUDE_ENV_FILE, which we already know is writable. mktemp would
# aim at $TMPDIR, which a sandboxed session can refuse.
errlog="${snapshot}.err"

# direnv reports "already loaded" and prints nothing when DIRENV_DIFF is set,
# which Claude inherits whenever it was launched from a loaded shell. Drop the
# bookkeeping so every run is a full export.
exported=$(
  env -u DIRENV_DIFF -u DIRENV_WATCHES -u DIRENV_DIR -u DIRENV_FILE \
    -u IN_NIX_SHELL direnv export json 2> "$errlog"
)

# Rebuild the snapshot from scratch. An empty export means no project env
# applies here, so the snapshot empties too and the next command runs unmodified.
{
  if [[ -n "$exported" && "$exported" != "{}" ]]; then
    printf '%s' "$exported" | jq -r --arg base "$PATH" '
      to_entries[]
      | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$"))
      # direnv exports its own bookkeeping even for a config file it
      # refused to run. Those four say nothing about the project, and the
      # next run unsets them anyway, so they never reach the snapshot.
      | select(.key | startswith("DIRENV_") | not)
      | if .value == null then
          "unset \(.key)"
        elif .key == "PATH" then
          # PATH is emitted relative to the live $PATH, never as an
          # absolute assignment, so entries other hooks prepended survive.
          # A plain suffix test is not enough: PATH_add also removes
          # duplicates, so direnvs tail is the base minus its repeats.
          # Compare entry sets instead, and take the leading run that the
          # base does not already contain as the added prefix.
          ($base | split(":")) as $b
          | (.value | split(":")) as $n
          # Bind the index explicitly. Writing `$n[.]` after a pipe would
          # read `.` as that pipes input, not as the loop counter.
          | ([range(0; $n | length) as $i
              | select(($b | index($n[$i])) != null)
              | $i] | first) as $cut
          | if (($b - $n) | length) > 0 then
              # direnv dropped an entry the base had. No relative form can
              # say that, so fall back and let the caller see the warning.
              "export PATH=\(.value | @sh)"
            else
              ($cut // ($n | length)) as $k
              | if $k == 0 then empty
                else "export PATH=\($n[0:$k] | join(":") | @sh)\":$PATH\""
                end
            end
        else
          "export \(.key)=\(.value | @sh)"
        end
    '
  fi
  # Some Claude versions join this file into command strings with `&&`, and a
  # trailing `;` would make `; &&` a syntax error. Keep the last token valid.
  echo 'true'
} > "${snapshot}.new"

# A cold nix evaluation can outrun the hook timeout, and the kill lands mid-write.
# Renaming within one directory is atomic, so a killed run leaves the previous
# snapshot whole rather than truncating it to half a line.
mv -f "${snapshot}.new" "$snapshot"

# Written after the snapshot exists, and guarded anyway: a stale line pointing at
# a deleted snapshot must not print an error before every command, nor return
# non-zero to whatever sources this file.
if ! grep -qF "$snapshot" "$CLAUDE_ENV_FILE" 2> /dev/null; then
  printf '[ -r %q ] && . %q || true\n' "$snapshot" "$snapshot" >> "$CLAUDE_ENV_FILE"
fi

# Anchored on the single quote that @sh emits. A nix shellHook is itself a
# multi-line value holding `export PATH="..."` lines, and those start a line too.
# Both of our forms open with `export PATH='`, so the ending tells them apart: a
# relative line closes with the live $PATH, an absolute one closes at the quote.
if grep -q "^export PATH='" "$snapshot" 2> /dev/null &&
  ! grep -q '^export PATH=.*":\$PATH"$' "$snapshot" 2> /dev/null; then
  echo "direnv-env: $PWD removes PATH entries, so PATH is set absolutely here" >&2
  echo "direnv-env: entries added by other hooks may not survive in this project" >&2
fi

if grep -q 'is blocked' "$errlog" 2> /dev/null; then
  echo "direnv-env: config in $PWD is not allowed - run: direnv allow" >&2
fi
rm -f "$errlog"
exit 0
