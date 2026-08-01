#!/usr/bin/env bash
# Dry-run harness: copies the vault-query-visible corpus (the same file list
# corpus.sh walks) into a throwaway git repo under $TMPDIR, applies an
# mdformat transformation to the copy in place, and leaves a reviewable diff.
# The real vault is read-only input here — nothing under it is ever written.
#
# Usage: mdformat/dryrun.sh [SUBCOMMAND] [-- <extra vault-query files args>]
#   SUBCOMMAND     mdformat verb to dry-run; must implement `--emit`.
#                  Default: normalize.
#   MDFORMAT_BIN   path to a built mdformat binary; skips the nix build.
#   VAULT_ROOT     vault root; defaults to `vault-query config`'s vault_root.
#
# What "the operative corpus" means: exactly the paths `vault-query files`
# returns (the same source corpus.sh uses), copied byte for byte, preserving
# their relative layout under a fresh $TMPDIR directory.
#
# Exit: 0 clean dry run — guards passed, and the cross-check against
# mdformat's own report agreed (or was not applicable to this subcommand's
# report shape); 1 setup failure (vault-query/nix build/empty corpus/binary
# missing --emit); 2 the tracked-file guard failed — the base commit does not
# track exactly as many files as were copied, the false-green trap this
# harness is most prone to; 3 the harness's own diff disagrees with
# mdformat's batch report, or the per-file emit pass silently dropped a file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TMPDIR:=/tmp}"

SUBCOMMAND="normalize"
if [ $# -gt 0 ] && [ "$1" != "--" ]; then
  SUBCOMMAND="$1"
  shift
fi
if [ "${1:-}" = "--" ]; then
  shift
fi

VAULT_ROOT="${VAULT_ROOT:-$(vault-query config | jq -r '.vault_root')}"
if [ -z "$VAULT_ROOT" ] || [ "$VAULT_ROOT" = "null" ]; then
  echo "dryrun.sh: could not resolve vault_root from \`vault-query config\`" >&2
  exit 1
fi

BIN="${MDFORMAT_BIN:-}"
if [ -z "$BIN" ]; then
  echo "dryrun.sh: building mdformat via nix..." >&2
  OUT_LINK="$(mktemp -d "$TMPDIR/mdformat-dryrun-bin.XXXXXX")/result"
  nix build "$REPO_ROOT#mdformat" -o "$OUT_LINK"
  BIN="$OUT_LINK/bin/mdformat"
fi
if [ ! -x "$BIN" ]; then
  echo "dryrun.sh: mdformat binary not found or not executable at $BIN" >&2
  exit 1
fi

# This harness writes by looping `--emit` over the copy; the binary itself
# has no in-place write path (see src/bin/mdformat.rs). Fail fast, with a
# clear reason, if the chosen subcommand has no `--emit` to loop over —
# rather than let every file degenerate into a clap argument-parsing error.
if ! "$BIN" "$SUBCOMMAND" --help 2>/dev/null | grep -q -- '--emit'; then
  echo "dryrun.sh: mdformat subcommand '$SUBCOMMAND' does not support --emit;" >&2
  echo "dryrun.sh: this harness needs a per-file write path to dry-run a transformation." >&2
  exit 1
fi

# --- corpus file list, relative paths, same source corpus.sh uses ---------
FILELIST="$(mktemp "$TMPDIR/mdformat-dryrun-files.XXXXXX")"
vault-query files "$@" >"$FILELIST"

total=$(wc -l <"$FILELIST" | tr -d ' ')
if [ "$total" -eq 0 ]; then
  echo "dryrun.sh: vault-query files returned no paths" >&2
  exit 1
fi
echo "dryrun.sh: corpus file list: $total files" >&2

# --- materialize the copy ---------------------------------------------------
COPY_DIR="$(mktemp -d "$TMPDIR/mdformat-dryrun.XXXXXX")"
case "$COPY_DIR" in
"$TMPDIR"/*) ;;
*)
  echo "dryrun.sh: refusing to run — copy dir $COPY_DIR is not under \$TMPDIR" >&2
  exit 1
  ;;
esac
case "$COPY_DIR" in
"$VAULT_ROOT" | "$VAULT_ROOT"/*)
  echo "dryrun.sh: refusing to run — copy dir $COPY_DIR is under the vault" >&2
  exit 1
  ;;
esac
echo "dryrun.sh: copy: $COPY_DIR"

copied=0
while IFS= read -r -d '' rel; do
  src="$VAULT_ROOT/$rel"
  dst="$COPY_DIR/$rel"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  copied=$((copied + 1))
done < <(tr '\n' '\0' <"$FILELIST")

echo "dryrun.sh: copied $copied files (of $total listed) into $COPY_DIR"
if [ "$copied" -ne "$total" ]; then
  echo "dryrun.sh: copy accounting mismatch: listed $total, copied $copied" >&2
  exit 1
fi

# --- base commit, with the false-green guard --------------------------------
# A repo-scoped hooks override, not global config: the machine's git hooks
# (core.hooksPath, set globally) include a post-commit hook that appends to a
# real vault file on every commit anywhere on this machine. Pointing
# core.hooksPath at an empty directory for these invocations only turns every
# hook — including that one — into a no-op, so this throwaway commit can
# never write to the vault. Scoped with -c, never written to any git config.
NULL_HOOKS_DIR="$(mktemp -d "$TMPDIR/mdformat-dryrun-nohooks.XXXXXX")"

(
  cd "$COPY_DIR"
  git -c core.hooksPath="$NULL_HOOKS_DIR" init -q
  git -c core.hooksPath="$NULL_HOOKS_DIR" add -A
)

# The guard this harness is most prone to: the vault's own .gitignore is
# deny-all (`*`, re-admitting ~10 paths). It is never part of the corpus file
# list `vault-query files` returns, so a per-file copy driven by that list
# should never carry it into the copy — but that is a property of the copy
# step, not something this script gets to assume. Assert the invariant
# directly: the index must stage exactly as many files as were copied. If a
# stray .gitignore (or any other ignore mechanism) kept files out, staged
# will fall short of copied, and the diff below would otherwise silently
# read as "no changes" instead of "nothing was ever tracked".
staged=$(cd "$COPY_DIR" && git -c core.hooksPath="$NULL_HOOKS_DIR" ls-files | wc -l | tr -d ' ')
echo "dryrun.sh: base commit stages $staged files (copied $copied)"
if [ "$staged" -ne "$copied" ]; then
  echo "dryrun.sh: GUARD FAILED — the index stages $staged files but $copied were copied." >&2
  echo "dryrun.sh: this is the false-green trap: some ignore mechanism kept files out of" >&2
  echo "dryrun.sh: the base commit, so the post-transformation diff would misreport." >&2
  exit 2
fi

(
  cd "$COPY_DIR"
  git -c core.hooksPath="$NULL_HOOKS_DIR" \
    -c user.email="dryrun@localhost" -c user.name="mdformat dryrun harness" \
    commit -q -m "base: $staged files from the vault corpus (mdformat dryrun harness)"
)

base_tracked=$(cd "$COPY_DIR" && git -c core.hooksPath="$NULL_HOOKS_DIR" ls-tree -r HEAD --name-only | wc -l | tr -d ' ')
echo "dryrun.sh: base commit HEAD tracks $base_tracked files"
if [ "$base_tracked" -ne "$copied" ]; then
  echo "dryrun.sh: GUARD FAILED — HEAD tracks $base_tracked files but $copied were copied." >&2
  exit 2
fi

# --- mdformat's own aggregate report over the pristine copy -----------------
# Run before the per-file --emit loop mutates anything below, so this report
# describes the same untouched content the base commit just captured. This
# is the independent measurement the harness's own diff gets cross-checked
# against in the final section.
REPORT_LOG="$(mktemp "$TMPDIR/mdformat-dryrun-report.XXXXXX")"
set +e
(cd "$COPY_DIR" && tr '\n' '\0' <"$FILELIST" | xargs -0 "$BIN" "$SUBCOMMAND") >/dev/null 2>"$REPORT_LOG"
set -e

# xargs may split a large file list into more than one batch, each printing
# its own summary line; sum across however many there are rather than assume
# one, the same defensive posture corpus.sh takes with its CHECKED counter.
MATCH_RE="^mdformat ${SUBCOMMAND}: [0-9]+/[0-9]+ files would change "
MATCHLINES="$(mktemp "$TMPDIR/mdformat-dryrun-summary.XXXXXX")"
grep -E "$MATCH_RE" "$REPORT_LOG" >"$MATCHLINES" || true

sum_field() {
  # $1: sed extraction expression; sums the captured group across all
  # matching lines, 0 if there are none.
  sed -E "$1" "$MATCHLINES" | awk '{s+=$1} END{print s+0}'
}
report_would_change=$(sum_field 's#^mdformat [a-z]+: ([0-9]+)/[0-9]+ files would change.*#\1#')
report_checked=$(sum_field 's#^mdformat [a-z]+: [0-9]+/([0-9]+) files would change.*#\1#')
report_refused=$(sum_field 's#.*\(([0-9]+) refused.*#\1#')
report_skipped=$(sum_field 's#.*, ([0-9]+) skipped.*#\1#')
report_gaps_changed=$(sum_field 's#.*, ([0-9]+)/[0-9]+ gaps rewritten.*#\1#')
report_gaps_considered=$(sum_field 's#.*, [0-9]+/([0-9]+) gaps rewritten.*#\1#')

report_reliable=1
if [ "$report_checked" -ne "$copied" ]; then
  report_reliable=0
  echo "dryrun.sh: mdformat's own report accounted for $report_checked of $copied files" >&2
  echo "dryrun.sh: (subcommand '$SUBCOMMAND' may not emit a parseable summary line, or a" >&2
  echo "dryrun.sh: batch failed) — the cross-check below is skipped as unreliable, not silently passed." >&2
else
  echo "dryrun.sh: mdformat's own report: $report_would_change/$report_checked files would change ($report_refused refused, $report_skipped skipped, $report_gaps_changed/$report_gaps_considered gaps rewritten)"
fi

# --- apply the transformation in place, one file at a time -----------------
# The binary deliberately has no in-place write path: `--emit` prints one
# input's bytes to stdout and refuses more than one input. So the writing
# happens here, in the harness, via this per-file loop — never inside the
# binary.
EMIT_ERR_LOG="$(mktemp "$TMPDIR/mdformat-dryrun-emit-errors.XXXXXX")"
emitted_ok=0
emit_refused=0
emit_error=0

while IFS= read -r -d '' rel; do
  dst="$COPY_DIR/$rel"
  tmpout="$dst.dryrun-emit-tmp"
  set +e
  "$BIN" "$SUBCOMMAND" --emit "$dst" >"$tmpout" 2>>"$EMIT_ERR_LOG"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    mv "$tmpout" "$dst"
    emitted_ok=$((emitted_ok + 1))
  elif [ "$code" -eq 4 ]; then
    # A refusal is a reportable outcome, not a crash: the input failed the
    # partition oracle or its rewrite failed the re-parse guard. Leave the
    # copy's file untouched and keep going.
    rm -f "$tmpout"
    emit_refused=$((emit_refused + 1))
    echo "dryrun.sh: REFUSED: $rel (exit 4)" >&2
  else
    rm -f "$tmpout"
    emit_error=$((emit_error + 1))
    echo "dryrun.sh: ERROR: $rel (exit $code)" >&2
  fi
done < <(tr '\n' '\0' <"$FILELIST")

echo "dryrun.sh: emit pass: $emitted_ok ok, $emit_refused refused, $emit_error errored (of $copied)"
emit_accounted=$((emitted_ok + emit_refused + emit_error))
if [ "$emit_accounted" -ne "$copied" ]; then
  echo "dryrun.sh: GUARD FAILED — emit pass accounted for $emit_accounted of $copied files." >&2
  exit 3
fi

# --- the diff ----------------------------------------------------------------
DIFF_NUMSTAT="$(cd "$COPY_DIR" && git -c core.hooksPath="$NULL_HOOKS_DIR" diff --numstat)"
if [ -z "$DIFF_NUMSTAT" ]; then
  diff_files_changed=0
  diff_insertions=0
  diff_deletions=0
else
  read -r diff_files_changed diff_insertions diff_deletions <<STATS
$(printf '%s\n' "$DIFF_NUMSTAT" | awk -F'\t' '{f++; ins+=($1+0); del+=($2+0)} END{print f+0, ins+0, del+0}')
STATS
fi

echo ""
echo "dryrun.sh: full diff"
(cd "$COPY_DIR" && git -c core.hooksPath="$NULL_HOOKS_DIR" diff)

# --- cross-check the harness against mdformat's own reporting ---------------
# Two independent measurements: mdformat's own batch pass over the pristine
# copy (above) and this harness's own per-file emit-and-diff pipeline. If
# they disagree, that disagreement is reported, not reconciled — see the
# module doc for why.
mismatch=0
if [ "$report_reliable" -eq 1 ]; then
  echo "dryrun.sh: harness's own diff:    $diff_files_changed files changed, $diff_insertions insertions(+), $diff_deletions deletions(-)"

  if [ "$diff_files_changed" -ne "$report_would_change" ]; then
    echo "dryrun.sh: CROSS-CHECK MISMATCH — diff touched $diff_files_changed files but mdformat's report expected $report_would_change." >&2
    mismatch=1
  fi
  if [ "$emit_refused" -ne "$report_refused" ]; then
    echo "dryrun.sh: CROSS-CHECK MISMATCH — the per-file emit pass refused $emit_refused files but the batch report counted $report_refused refused." >&2
    mismatch=1
  fi

  # normalize-specific: a gap holds only blank-line whitespace, so rewriting
  # one is always a single whole-line insertion or a single whole-line
  # deletion, never a same-line substitution. That makes
  # insertions+deletions == gaps rewritten a provable identity for this verb
  # specifically, not a coincidence of today's corpus — so it's asserted,
  # not just reported. A future subcommand's diff shape may not owe this
  # relationship, and gets neither the assertion nor the corresponding claim.
  if [ "$SUBCOMMAND" = "normalize" ]; then
    diff_edits=$((diff_insertions + diff_deletions))
    if [ "$diff_edits" -ne "$report_gaps_changed" ]; then
      echo "dryrun.sh: CROSS-CHECK MISMATCH — normalize rewrites exactly one whole line per changed gap, so insertions+deletions ($diff_edits) should equal gaps rewritten ($report_gaps_changed)." >&2
      mismatch=1
    fi
  fi
fi

# --- close out: repo path + --stat summary, repo left intact ----------------
echo ""
echo "dryrun.sh: --stat summary"
(cd "$COPY_DIR" && git -c core.hooksPath="$NULL_HOOKS_DIR" diff --stat)
echo ""
echo "dryrun.sh: repo path: $COPY_DIR"

rm -f "$FILELIST" "$MATCHLINES" "$REPORT_LOG" "$EMIT_ERR_LOG"

if [ "$mismatch" -ne 0 ]; then
  echo "dryrun.sh: cross-check disagreement recorded above — repo left intact at $COPY_DIR for inspection." >&2
  exit 3
fi

exit 0
