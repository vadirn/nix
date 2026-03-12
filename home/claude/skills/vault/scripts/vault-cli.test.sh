#!/bin/bash
# Tests for vault-cli: cmd_xp, cmd_log_init, get_current_streak
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/vault-cli"
PASS=0
FAIL=0

# --- Setup temp vault ---
TMPVAULT=$(mktemp -d)
trap 'rm -rf "$TMPVAULT"' EXIT

LOG_DIR="$TMPVAULT/41 projects/block-buster"
TEMPLATE_DIR="$TMPVAULT/templates"
mkdir -p "$LOG_DIR" "$TEMPLATE_DIR"

# Create Daily Log template (matches real vault template)
cat > "$TEMPLATE_DIR/Daily Log.md" <<'EOF'
---
type: daily-log
date:
status: incomplete
xp: 0
---

## Plan

## Result

## Activity
EOF

# Create a working directory with vault config pointing to temp vault
WORKDIR=$(mktemp -d)
trap 'rm -rf "$TMPVAULT" "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/.claude"
cat > "$WORKDIR/.claude/.vault.config.json" <<EOF
{
  "vault_root": "$TMPVAULT",
  "project_path": "$TMPVAULT/41 projects/block-buster"
}
EOF

# Also create schema files that vault-cli expects
SCHEMA_SRC="$(cd "$(dirname "$0")/../schemas" && pwd)"

run() {
  cd "$WORKDIR" && bash "$SCRIPT" "$@"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL: $desc"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL: $desc"
    echo "  expected to contain: $needle"
    echo "  actual: $haystack"
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [[ -f "$path" ]]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL: $desc — file not found: $path"
  fi
}

# --- log-init tests ---

echo "# log-init"

result=$(run log-init 2025-01-15)
assert_eq "log-init returns path" "$LOG_DIR/log-2025-01-15.md" "$result"
assert_file_exists "log-init creates file" "$LOG_DIR/log-2025-01-15.md"
assert_contains "log-init fills date" "date: 2025-01-15" "$(cat "$LOG_DIR/log-2025-01-15.md")"
assert_contains "log-init has Plan section" "## Plan" "$(cat "$LOG_DIR/log-2025-01-15.md")"
assert_contains "log-init has Activity section" "## Activity" "$(cat "$LOG_DIR/log-2025-01-15.md")"

# Idempotent: running again returns same path, doesn't error
result2=$(run log-init 2025-01-15)
assert_eq "log-init idempotent" "$LOG_DIR/log-2025-01-15.md" "$result2"

# --- xp tests ---

echo "# xp"

# Create a log with plan items and results
cat > "$LOG_DIR/log-2025-01-20.md" <<'EOF'
---
type: daily-log
date: 2025-01-20
status: incomplete
xp: 0
---

## Plan

- write tests
- fix sidebar
- deploy app

## Result

- ✓ write tests
- ✓ fix sidebar
- ✗ deploy app
- ✓ hotfix auth (unplanned)

## Activity
EOF

# No streak (no prior complete days), no sleep
xp_total=$(run xp 2025-01-20 2>/dev/null)
# plan_bonus=3 (3 items planned) + planned_done=2×2=4 + unplanned=1×1=1 + streak=0 + sleep=0 = 8
assert_eq "xp basic: 3+4+1+0+0=8" "8" "$xp_total"

# With --sleep
xp_sleep=$(run xp --sleep 2025-01-20 2>/dev/null)
# 8 + 3 = 11
assert_eq "xp with sleep: 8+3=11" "11" "$xp_sleep"

# Breakdown printed to stderr
xp_stderr=$(run xp 2025-01-20 2>&1 >/dev/null)
assert_contains "stderr shows plan bonus" "Plan bonus:" "$xp_stderr"
assert_contains "stderr shows planned done" "Planned done:" "$xp_stderr"
assert_contains "stderr shows streak" "Streak bonus:" "$xp_stderr"

# --- xp with no plan ---

cat > "$LOG_DIR/log-2025-01-21.md" <<'EOF'
---
type: daily-log
date: 2025-01-21
status: incomplete
xp: 0
---

## Plan

## Result

- ✓ emergency fix (unplanned)

## Activity
EOF

xp_noplan=$(run xp 2025-01-21 2>/dev/null)
# plan_bonus=0 + planned=0 + unplanned=1 + streak=0 + sleep=0 = 1
assert_eq "xp no plan: 0+0+1+0+0=1" "1" "$xp_noplan"

# --- xp with streak ---

echo "# xp with streak"

# Create consecutive complete days before today
# We'll use a fixed "today" by creating logs for a sequence
# Streak counts backward from yesterday relative to today's date
today=$(date +%Y-%m-%d)
day1=$(date -d "$today - 1 days" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
day2=$(date -d "$today - 2 days" +%Y-%m-%d 2>/dev/null || date -v-2d +%Y-%m-%d)
day3=$(date -d "$today - 3 days" +%Y-%m-%d 2>/dev/null || date -v-3d +%Y-%m-%d)

for d in "$day1" "$day2" "$day3"; do
  cat > "$LOG_DIR/log-${d}.md" <<EOF
---
type: daily-log
date: ${d}
status: complete
xp: 5
---

## Plan

## Result

## Activity
EOF
done

# Create today's log with a plan
cat > "$LOG_DIR/log-${today}.md" <<EOF
---
type: daily-log
date: ${today}
status: incomplete
xp: 0
---

## Plan

- test streak

## Result

- ✓ test streak

## Activity
EOF

xp_streak=$(run xp "$today" 2>/dev/null)
# plan_bonus=3 + planned=1×2=2 + unplanned=0 + streak=3 + sleep=0 = 8
assert_eq "xp with 3-day streak: 3+2+0+3+0=8" "8" "$xp_streak"

# --- xp missing log ---

echo "# xp error cases"

xp_err=$(run xp 1999-01-01 2>&1 || true)
assert_contains "xp missing log errors" "no log for 1999-01-01" "$xp_err"

# --- streak command still works ---

echo "# streak"

streak_out=$(run streak 2>&1)
assert_contains "streak shows streak count" "streak:" "$streak_out"
assert_contains "streak shows level" "Level" "$streak_out"

# --- Summary ---

echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
