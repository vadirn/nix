#!/usr/bin/env bash
# Run mdformat's corpus checks over the vault-query-visible corpus: the same
# file list `vault-query lint` walks, since both call the shared `scan`.
# Replaces the ad-hoc shell pipeline that used to live in a scratchpad note.
#
# Two phases, both over the same file list:
#
#   partition     every file's top-level block spans partition its content
#                 bytes.
#   idempotence   `format` every file, then require every output to be in
#                 normal form — that is, `format(format(f)) == format(f)` over
#                 the whole corpus. A probe once measured this and found the
#                 second pass changed 0 files; nothing enforced it, so a
#                 regression that made the formatter oscillate would have shown
#                 up as a diff someone noticed by eye. Now it is a phase with
#                 the same accounting guard as the first.
#
# The check is `format --check` on the first pass's output rather than a
# byte-comparison of a second pass, because `check` runs every rule against the
# same input independently: every rule individually a no-op implies the
# pipeline is one, so it is the stronger of the two readings — and it is one
# batch of invocations instead of a second full formatting pass.
#
# Commutativity of the rules is deliberately not tested here. It was observed
# over this corpus, it is not guaranteed, and `src/format.rs` fixes the pipeline
# order at endings -> gaps -> tables -> markers on purpose. The endings rule's
# position is not a preference: it canonicalizes line endings, so running it
# first is what keeps a carriage return out of the other rules' inputs. This
# corpus cannot exercise it either way — 0 of these files hold one.
#
# The marker rule is expected to change 0 files here too, and for a different
# reason: a census found the vault unanimous on `-` bullets and `.` ordered
# delimiters, so the rule is preservative over today's corpus by design. A
# nonzero count is information about the census, not a failure of this script.
#
# Usage: mdformat/corpus.sh [--partition-only] [--no-ignore]
#                           [-- <extra vault-query files args>]
#   MDFORMAT_BIN   path to a built mdformat binary; skips the nix build.
#   VAULT_ROOT     vault root; defaults to `vault-query config`'s vault_root.
#
# Exit: 0 all phases pass, 4 at least one file failed a phase, 1 a run is
# unaccounted for and no verdict is claimed (see the guards; the stderr log is
# kept in that case), other nonzero codes bubble up from `nix build` or
# `vault-query`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
: "${TMPDIR:=/tmp}"

# Our own flags come off the front; everything left is forwarded to
# `vault-query files`, which is what selects the corpus. `--` ends our own
# parsing, so an argument bound for `vault-query` is never eaten here.
RUN_IDEMPOTENCE=1
ARGS=()
passthrough=0
for arg in "$@"; do
  if [ "$passthrough" -eq 1 ]; then
    ARGS+=("$arg")
    continue
  fi
  case "$arg" in
  --partition-only) RUN_IDEMPOTENCE=0 ;;
  --)
    passthrough=1
    ARGS+=("$arg")
    ;;
  *) ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

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
tr '\n' '\0' <"$FILELIST" | xargs -0 "$BIN" partition 2>"$STDERR_LOG"
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
# counted every file itself: it prints one `mdformat partition: OK/CHECKED files
# pass` summary per xargs batch, and those CHECKED values must sum to `total`.
# That catches a binary that could not exec, an xargs batch that never ran, and
# a process killed mid-corpus. `BIN_EXIT` comes from xargs, which collapses any
# child failure to 1, so it can flag a bad run but never grade one — the
# per-file verdict stays with the FAIL lines above.
CHECKED=$(awk '/^mdformat partition: [0-9]+\/[0-9]+ files pass/ {
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
echo "mdformat corpus partition: $total files checked / $passed passed / $failed failed"

# ---------------------------------------------------------------- phase 2 --
# Idempotence over the corpus: format every file once, then require every
# output to be in normal form.
idem_failed=0
pass1_failed=0
not_normal=0
if [ "$RUN_IDEMPOTENCE" -eq 1 ]; then
  OUTDIR="$(mktemp -d "$TMPDIR/mdformat-corpus-pass1.XXXXXX")"
  PASS1_LOG="$(mktemp "$TMPDIR/mdformat-corpus-pass1.XXXXXX.log")"

  # One invocation per file, because `format` takes exactly one input unless
  # `--check` is given — it prints bytes, and concatenating the corpus onto one
  # stdout would lose the file boundaries. Outputs are named by their 1-based
  # line in FILELIST, so a failure below can be reported against the vault path
  # it came from rather than against a temp file nobody can act on.
  emitted=0
  n=0
  while IFS= read -r path; do
    n=$((n + 1))
    out="$OUTDIR/$(printf '%06d' "$n").md"
    if "$BIN" format "$path" >"$out" 2>>"$PASS1_LOG"; then
      emitted=$((emitted + 1))
    else
      # A non-zero exit here is an I/O, UTF-8 or sourcepos error — never a
      # declination, which `format` reports without setting an exit code. The
      # partial output must go, or phase 2 would check bytes no run produced.
      rm -f "$out"
      echo "IDEMPOTENCE FAIL: $path"
      echo "  - the first pass did not complete"
      pass1_failed=$((pass1_failed + 1))
    fi
  done <"$FILELIST"

  IDEM_LOG="$(mktemp "$TMPDIR/mdformat-corpus-idempotence.XXXXXX.log")"
  IDEM_EXIT=0
  if [ "$emitted" -eq 0 ]; then
    # `mdformat` with no path arguments reads stdin, so an empty batch would
    # hang rather than check nothing. Never claim a pass from one.
    echo "corpus.sh: refusing to report an idempotence pass — no file formatted." >&2
    rm -rf "$OUTDIR"
    rm -f "$FILELIST"
    exit 1
  fi
  set +e
  find "$OUTDIR" -type f -name '*.md' -print0 | xargs -0 "$BIN" format --check 2>"$IDEM_LOG"
  IDEM_EXIT=$?
  set -e

  # `NOT NORMAL` names the temp file; map its index back to the vault path.
  NOT_NORMAL="$(grep -E '^mdformat: .*: NOT NORMAL ' "$IDEM_LOG" | sed -E 's|^mdformat: .*/0*([0-9]+)\.md: NOT NORMAL .*|\1|' | sort -un || true)"
  if [ -n "$NOT_NORMAL" ]; then
    while IFS= read -r idx; do
      src="$(sed -n "${idx}p" "$FILELIST")"
      echo "IDEMPOTENCE FAIL: $src"
      grep -E "/0*${idx}\.md:" "$IDEM_LOG" | sed -E 's/^mdformat: [^ ]*: /  - /'
      not_normal=$((not_normal + 1))
    done <<<"$NOT_NORMAL"
  fi
  idem_failed=$((pass1_failed + not_normal))

  # The same guard phase 1 carries, for the same reason: "N/N in normal form"
  # is parsed out of stderr, so a run that never happened reports what a run
  # that passed reports. Two counts have to line up — every file produced a
  # first-pass output, and `format --check` counted every one of those outputs
  # itself, summed over the xargs batches.
  IDEM_CHECKED=$(awk '/^mdformat format --check: [0-9]+\/[0-9]+ files are in normal form/ {
    split($4, a, "/"); n += a[2]
  } END { print n + 0 }' "$IDEM_LOG")

  if [ "$idem_failed" -eq 0 ] && { [ "$IDEM_EXIT" -ne 0 ] ||
    [ "$emitted" -ne "$total" ] || [ "$IDEM_CHECKED" -ne "$emitted" ]; }; then
    echo "corpus.sh: refusing to report an idempotence pass — the run is unaccounted for." >&2
    echo "corpus.sh: formatted $emitted of $total files; rechecked $IDEM_CHECKED of $emitted; xargs exited $IDEM_EXIT." >&2
    echo "corpus.sh: last lines of $IDEM_LOG:" >&2
    tail -n 20 "$IDEM_LOG" >&2
    rm -rf "$OUTDIR"
    rm -f "$FILELIST"
    exit 1
  fi

  idem_passed=$((emitted - not_normal))
  echo "mdformat corpus idempotence: $emitted of $total files formatted / $idem_passed second passes are no-ops / $idem_failed failed"
  rm -rf "$OUTDIR"
  rm -f "$PASS1_LOG" "$IDEM_LOG"
fi

rm -f "$FILELIST" "$STDERR_LOG"

if [ "$failed" -gt 0 ] || [ "$idem_failed" -gt 0 ]; then
  exit 4
fi
exit 0
