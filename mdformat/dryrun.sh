#!/usr/bin/env bash
# Dry-run harness: copies the vault-query-visible corpus (the same file list
# corpus.sh walks) into a throwaway git repo under $TMPDIR, applies an
# mdformat transformation to the copy in place, and leaves a reviewable diff.
# The real vault is read-only input here — nothing under it is ever written.
#
# Usage: mdformat/dryrun.sh [RULE] [-- <extra vault-query files args>]
#   RULE           one rewriting rule to dry-run, named as mdformat's reports
#                  tag it: endings, gaps, tables, markers. Pass `all` to run
#                  the whole normal form. Default: gaps.
#   MDFORMAT_BIN   path to a built mdformat binary; skips the nix build.
#   VAULT_ROOT     vault root; defaults to `vault-query config`'s vault_root.
#
# This took an mdformat *verb* until the CLI had four of them; `normalize` and
# `pad` were the two that dry-ran a single rule, and `format --rule <name>`
# replaced both. The rule name is passed straight through, so mdformat decides
# what is a rule and this script never holds a list of them.
#
# One behavioural consequence, and it is the reason the cross-check below reads
# stderr rather than exit codes: `normalize --emit` exited 4 for a document
# whose rewrite failed its guard, and `format --rule` does not. A rule that
# declines yields its input, prints an EXEMPT line, and exits 0 — a
# declination is not a failure (see src/format.rs). So a refusal is counted
# here by reading it, not by catching it.
#
# What "the operative corpus" means: exactly the paths `vault-query files`
# returns (the same source corpus.sh uses), copied byte for byte, preserving
# their relative layout under a fresh $TMPDIR directory.
#
# Exit: 0 clean dry run — guards passed, and the cross-check against
# mdformat's own report agreed; 1 setup failure (vault-query/nix build/empty
# corpus/unknown rule name); 2 the tracked-file guard failed — the base commit
# does not track exactly as many files as were copied, the false-green trap
# this harness is most prone to; 3 the harness's own diff disagrees with
# mdformat's batch report, or the per-file emit pass silently dropped a file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TMPDIR:=/tmp}"

RULE="gaps"
if [ $# -gt 0 ] && [ "$1" != "--" ]; then
  RULE="$1"
  shift
fi
if [ "${1:-}" = "--" ]; then
  shift
fi

# The rule as mdformat's flags spell it, and as its summary line will. `all`
# is this script's own word for "no restriction"; mdformat spells that by
# omitting the flag.
RULE_ARGS=(--rule "$RULE")
SCOPE=" --rule $RULE"
RULE_LABEL="the $RULE rule's normal form"
if [ "$RULE" = "all" ]; then
  RULE_ARGS=()
  SCOPE=""
  RULE_LABEL="normal form"
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

# Ask mdformat whether the name is a rule, rather than checking it here: the
# binary refuses an unknown `--rule` with exit 2, listing the names that exist.
# Fail fast on that, with mdformat's own message, instead of letting every file
# in the corpus degenerate into the same refusal one at a time.
if ! PROBE="$(printf '' | "$BIN" format --check "${RULE_ARGS[@]+"${RULE_ARGS[@]}"}" - 2>&1)"; then
  echo "dryrun.sh: mdformat refused --rule '$RULE':" >&2
  echo "$PROBE" >&2
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
# Run before the per-file emit loop mutates anything below, so this report
# describes the same untouched content the base commit just captured. This
# is the independent measurement the harness's own diff gets cross-checked
# against in the final section.
#
# `format --check` is the report half of what `normalize` and `pad` used to
# print by default. It counts files in normal form rather than files that
# would change, so the harness's expectation is the complement — and it counts
# one departure per changed line, which is what `normalize` called a rewritten
# gap.
REPORT_LOG="$(mktemp "$TMPDIR/mdformat-dryrun-report.XXXXXX")"
set +e
(cd "$COPY_DIR" && tr '\n' '\0' <"$FILELIST" |
  xargs -0 "$BIN" format --check "${RULE_ARGS[@]+"${RULE_ARGS[@]}"}") >/dev/null 2>"$REPORT_LOG"
set -e

# xargs may split a large file list into more than one batch, each printing
# its own summary line; sum across however many there are rather than assume
# one, the same defensive posture corpus.sh takes with its CHECKED counter.
MATCHLINES="$(mktemp "$TMPDIR/mdformat-dryrun-summary.XXXXXX")"
grep -E "^mdformat format --check${SCOPE}: [0-9]+/[0-9]+ files are in normal form " \
  "$REPORT_LOG" >"$MATCHLINES" || true

sum_field() {
  # $1: sed extraction expression; sums the captured group across all
  # matching lines, 0 if there are none.
  sed -E "$1" "$MATCHLINES" | awk '{s+=$1} END{print s+0}'
}
report_normal=$(sum_field 's#^mdformat format --check[^:]*: ([0-9]+)/[0-9]+ files are.*#\1#')
report_checked=$(sum_field 's#^mdformat format --check[^:]*: [0-9]+/([0-9]+) files are.*#\1#')
report_departures=$(sum_field 's#.*\(([0-9]+) departures.*#\1#')
report_declined=$(sum_field 's#.*, ([0-9]+) rule declinations.*#\1#')
report_exempt=$(sum_field 's#.*, ([0-9]+) exempt constructs.*#\1#')
report_would_change=$((report_checked - report_normal))

report_reliable=1
if [ "$report_checked" -ne "$copied" ]; then
  report_reliable=0
  echo "dryrun.sh: mdformat's own report accounted for $report_checked of $copied files" >&2
  echo "dryrun.sh: (a batch failed, or the summary line changed shape) — the cross-check" >&2
  echo "dryrun.sh: below is skipped as unreliable, not silently passed." >&2
else
  echo "dryrun.sh: mdformat's own report: $report_would_change/$report_checked files depart from $RULE_LABEL ($report_departures departures, $report_declined rule declinations, $report_exempt exempt constructs)"
fi

# --- apply the transformation in place, one file at a time -----------------
# `format --write` rewrites one named file, but it rewrites it to the *whole*
# normal form and refuses `--rule` for that reason. A single-rule dry run
# therefore still writes here, in the harness: `format --rule <name> <file>`
# prints that rule's bytes to stdout, one input at a time, and this loop moves
# them over the copy.
#
# A declining file is no longer distinguishable by exit code — the rule yields
# its input, so the mv is a no-op and the diff stays clean. It is counted by
# reading the EXEMPT line the run prints instead, which is why every run's
# stderr is kept rather than only the failing ones'.
EMIT_ERR_LOG="$(mktemp "$TMPDIR/mdformat-dryrun-emit-errors.XXXXXX")"
emitted_ok=0
emit_error=0

while IFS= read -r -d '' rel; do
  dst="$COPY_DIR/$rel"
  tmpout="$dst.dryrun-emit-tmp"
  set +e
  "$BIN" format "${RULE_ARGS[@]+"${RULE_ARGS[@]}"}" "$dst" >"$tmpout" 2>>"$EMIT_ERR_LOG"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    mv "$tmpout" "$dst"
    emitted_ok=$((emitted_ok + 1))
  else
    rm -f "$tmpout"
    emit_error=$((emit_error + 1))
    echo "dryrun.sh: ERROR: $rel (exit $code)" >&2
  fi
done < <(tr '\n' '\0' <"$FILELIST")

# Every rule that declined a whole document, across the per-file runs. This is
# what the old `REFUSED: <path> (exit 4)` count was, read off the report the
# binary prints unasked rather than off an exit code it no longer sets.
emit_declined=$(grep -c 'rule declined this document' "$EMIT_ERR_LOG" || true)

echo "dryrun.sh: emit pass: $emitted_ok ok, $emit_declined declined, $emit_error errored (of $copied)"
emit_accounted=$((emitted_ok + emit_error))
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
  if [ "$emit_declined" -ne "$report_declined" ]; then
    echo "dryrun.sh: CROSS-CHECK MISMATCH — the per-file emit pass saw $emit_declined declinations but the batch report counted $report_declined." >&2
    mismatch=1
  fi

  # gaps-specific: a gap holds only blank-line whitespace, so rewriting one is
  # always a single whole-line insertion or a single whole-line deletion, never
  # a same-line substitution. That makes insertions+deletions == departures a
  # provable identity for this rule specifically — the gap rule reports one
  # departure per rewritten gap — not a coincidence of today's corpus, so it is
  # asserted rather than merely reported. Another rule's diff shape may not owe
  # this relationship, and gets neither the assertion nor the claim: `tables`
  # substitutes within a line, so its departures and its diff lines count
  # differently.
  if [ "$RULE" = "gaps" ]; then
    diff_edits=$((diff_insertions + diff_deletions))
    if [ "$diff_edits" -ne "$report_departures" ]; then
      echo "dryrun.sh: CROSS-CHECK MISMATCH — the gaps rule rewrites exactly one whole line per departure, so insertions+deletions ($diff_edits) should equal departures ($report_departures)." >&2
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
