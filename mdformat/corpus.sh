#!/usr/bin/env bash
# Run mdformat's fixpoint (partition) oracle over the vault-query-visible
# corpus: the same file list `vault-query lint` walks, since both call the
# shared `scan`. Replaces the ad-hoc shell pipeline that used to live in a
# scratchpad note.
#
# Usage: mdformat/corpus.sh [--no-ignore] [-- <extra vault-query files args>]
#   MDFORMAT_BIN   path to a built mdformat binary; skips the nix build.
#   VAULT_ROOT     vault root; defaults to `vault-query config`'s vault_root.
#
# Exit: 0 all files pass, 4 at least one file failed the oracle, 1 the run is
# unaccounted for and no verdict is claimed (see the guard at the foot; the
# stderr log is kept in that case), other nonzero codes bubble up from `nix
# build` or `vault-query`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TMPDIR:=/tmp}"

VAULT_ROOT="${VAULT_ROOT:-$(vault-query config | sed -n 's/.*"vault_root": *"\(.*\)".*/\1/p')}"
if [ -z "$VAULT_ROOT" ]; then
  echo "corpus.sh: could not resolve vault_root from \`vault-query config\`" >&2
  exit 1
fi

BIN="${MDFORMAT_BIN:-}"
if [ -z "$BIN" ]; then
  echo "corpus.sh: building mdformat via nix..." >&2
  OUT_LINK="$(mktemp -d "$TMPDIR/mdformat-corpus-bin.XXXXXX")/result"
  nix build "$REPO_ROOT#mdformat" -o "$OUT_LINK"
  BIN="$OUT_LINK/bin/mdformat"
fi

FILELIST="$(mktemp "$TMPDIR/mdformat-corpus-files.XXXXXX")"
vault-query files "$@" | awk -v root="$VAULT_ROOT" '{print root "/" $0}' >"$FILELIST"

total=$(wc -l <"$FILELIST" | tr -d ' ')
if [ "$total" -eq 0 ]; then
  echo "corpus.sh: vault-query files returned no paths" >&2
  exit 1
fi

STDERR_LOG="$(mktemp "$TMPDIR/mdformat-corpus-stderr.XXXXXX")"
set +e
tr '\n' '\0' <"$FILELIST" | xargs -0 "$BIN" fixpoint 2>"$STDERR_LOG"
BIN_EXIT=$?
set -e

# Failures: one or more FAIL lines per file, keyed by path; print path once
# per file followed by its reason(s).
FAILED_PATHS="$(grep -E '^mdformat: .*: FAIL: ' "$STDERR_LOG" | sed -E 's/^mdformat: (.*): FAIL: .*/\1/' | sort -u || true)"
failed=0
if [ -n "$FAILED_PATHS" ]; then
  failed=$(printf '%s\n' "$FAILED_PATHS" | wc -l | tr -d ' ')
  while IFS= read -r path; do
    echo "FAIL: $path"
    grep -F "mdformat: $path: FAIL: " "$STDERR_LOG" | sed -E "s/^mdformat: .*: FAIL: /  - /"
  done <<<"$FAILED_PATHS"
fi

# Any other errors (I/O, non-UTF-8, sourcepos) also count as failures for the
# summary, keyed by path, so nothing silently drops off the count.
OTHER_ERR_PATHS="$(grep -E '^mdformat: .*: (SOURCEPOS ERROR|.*: No such file|input is not valid UTF-8)' "$STDERR_LOG" | sed -E 's/^mdformat: ([^:]+): .*/\1/' | sort -u || true)"
if [ -n "$OTHER_ERR_PATHS" ]; then
  while IFS= read -r path; do
    if ! printf '%s\n' "$FAILED_PATHS" | grep -qxF "$path"; then
      echo "FAIL: $path"
      grep -F "mdformat: $path:" "$STDERR_LOG" | sed -E "s/^mdformat: [^:]+: /  - /"
      failed=$((failed + 1))
    fi
  done <<<"$OTHER_ERR_PATHS"
fi

# Guard the green path. A clean report is the only one whose meaning is in
# doubt: when `failed` is nonzero the script already exits 4 and misleads
# nobody, but "N passed / 0 failed" is asserted, not observed — it is
# `total` minus a count parsed out of stderr, so a run that never happened
# reports the same thing as a run that passed. Pointing MDFORMAT_BIN at a
# nonexistent path printed "4 files checked / 4 passed / 0 failed" and exited
# 0. So before claiming a pass, require the binary to have exited 0 and to have
# counted every file itself: it prints one `mdformat fixpoint: OK/CHECKED files
# pass` summary per xargs batch, and those CHECKED values must sum to `total`.
# That catches a binary that could not exec, an xargs batch that never ran, and
# a process killed mid-corpus. `BIN_EXIT` comes from xargs, which collapses any
# child failure to 1, so it can flag a bad run but never grade one — the
# per-file verdict stays with the FAIL lines above.
CHECKED=$(awk '/^mdformat fixpoint: [0-9]+\/[0-9]+ files pass/ {
  split($3, a, "/"); n += a[2]
} END { print n + 0 }' "$STDERR_LOG")

if [ "$failed" -eq 0 ] && { [ "$BIN_EXIT" -ne 0 ] || [ "$CHECKED" -ne "$total" ]; }; then
  echo "corpus.sh: refusing to report a pass — the run is unaccounted for." >&2
  echo "corpus.sh: mdformat checked $CHECKED of $total files; xargs exited $BIN_EXIT." >&2
  echo "corpus.sh: last lines of $STDERR_LOG:" >&2
  tail -n 20 "$STDERR_LOG" >&2
  rm -f "$FILELIST"
  exit 1
fi

passed=$((total - failed))
echo "mdformat corpus: $total files checked / $passed passed / $failed failed"

rm -f "$FILELIST" "$STDERR_LOG"

if [ "$failed" -gt 0 ]; then
  exit 4
fi
exit 0
