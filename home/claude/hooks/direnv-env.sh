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
#   - It never assigns PATH. The snapshot only ever prepends to the live $PATH,
#     so entries other hooks added survive whatever order the hooks ran in.
#   - It never fails a shell. Every exit is 0, the snapshot always parses, and
#     the source line tolerates a snapshot that is missing or unreadable.

set -uo pipefail

[[ -n "${CLAUDE_ENV_FILE:-}" ]] || exit 0
command -v direnv > /dev/null 2>&1 || exit 0
command -v jq > /dev/null 2>&1 || exit 0

# Hooks receive the working directory on stdin. Trust it over $PWD so worktree
# sessions started by `clw` read their own .envrc.
cwd=$(jq -r '.cwd // empty' 2> /dev/null || true)
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
      # direnv exports its own bookkeeping even for a config file it refused to
      # run. Those four say nothing about the project, and the next run unsets
      # them anyway, so they never reach the snapshot.
      | select(.key | startswith("DIRENV_") | not)
      | if .value == null then
          "unset \(.key)"
        elif .key == "PATH" then
          # direnv prepends, so its PATH is normally the live one with entries
          # in front. Strip that suffix and re-attach $PATH at run time. When
          # the suffix does not match, direnv reordered or dropped something:
          # prepend the whole value rather than assign it, so a PATH entry
          # another hook added still resolves.
          if .value == $base then empty
          elif .value | endswith(":" + $base) then
            "export PATH=\(.value[0:(.value | length) - ($base | length) - 1] | @sh)\":$PATH\""
          else
            "export PATH=\(.value | @sh)\":$PATH\""
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

if grep -q 'is blocked' "$errlog" 2> /dev/null; then
  echo "direnv-env: config in $PWD is not allowed - run: direnv allow" >&2
fi
rm -f "$errlog"
exit 0
