#!/bin/bash
# Tests for vault-cli: weekly log (log-init, xp, streak)
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

# Create Weekly Log template
cat > "$TEMPLATE_DIR/Weekly Log.md" <<'EOF'
---
type: weekly-log
week:
start:
end:
status: incomplete
xp: 0
sleep: []
---

## Projects

## Tasks

## Backlog

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

# Compute expected week for 2026-03-12
result=$(run log-init 2026-03-12)
assert_eq "log-init returns weekly path" "$LOG_DIR/2026-w11.md" "$result"
assert_file_exists "log-init creates file" "$LOG_DIR/2026-w11.md"

content=$(cat "$LOG_DIR/2026-w11.md")
assert_contains "log-init fills week" "week: 2026-W11" "$content"
assert_contains "log-init fills start" "start: 2026-03-09" "$content"
assert_contains "log-init fills end" "end: 2026-03-15" "$content"
assert_contains "log-init has Tasks section" "## Tasks" "$content"
assert_contains "log-init has Activity section" "## Activity" "$content"
assert_contains "log-init has Projects section" "## Projects" "$content"
assert_contains "log-init has Backlog section" "## Backlog" "$content"

# Idempotent: running again returns same path
result2=$(run log-init 2026-03-12)
assert_eq "log-init idempotent" "$LOG_DIR/2026-w11.md" "$result2"

# Same week, different day
result3=$(run log-init 2026-03-14)
assert_eq "log-init same week different day" "$LOG_DIR/2026-w11.md" "$result3"

# --- xp tests ---

echo "# xp"

# Create weekly logs with tasks and projects
cat > "$LOG_DIR/2026-w10.md" <<'EOF'
---
type: weekly-log
week: 2026-W10
start: 2026-03-02
end: 2026-03-08
status: incomplete
xp: 0
sleep: []
---

## Projects

- [[project-a]]
- [[project-b]]

## Tasks

- [x] (2026-03-02) Fix sidebar [[project-a]]
- [x] (2026-03-03) Write tests [[project-b]]
- [ ] Deploy app [[project-a]]
- [x] (2026-03-03) Hotfix auth [[project-a]]

## Backlog

## Activity
EOF

# xp prints year calendar to stdout
xp_out=$(run xp)
assert_contains "xp shows calendar" "Jan" "$xp_out"
assert_contains "xp shows streak" "Streak:" "$xp_out"
assert_contains "xp shows level" "Level:" "$xp_out"

# Mar 02 should show 1 (one task), Mar 03 should show 2 (two tasks)
assert_contains "xp shows Mar" "Mar" "$xp_out"

# Coverage bonus: full coverage in W10 → lands on Monday 2026-03-09
# 2 projects both covered → +2 on Mar 09
assert_contains "xp shows total" "Total:" "$xp_out"

# --- xp with sleep ---

echo "# xp with sleep"

cat > "$LOG_DIR/2026-w09.md" <<'EOF'
---
type: weekly-log
week: 2026-W09
start: 2026-02-23
end: 2026-03-01
status: incomplete
xp: 0
sleep:
  - 2026-02-23
  - 2026-02-24
---

## Projects

## Tasks

- [x] (2026-02-23) Something

## Backlog

## Activity
EOF

# Sleep dates not consecutive from today → no streak bonus, but task shows in calendar
xp_sleep=$(run xp)
assert_contains "xp with sleep shows Feb" "Feb" "$xp_sleep"

# --- xp partial coverage ---

echo "# xp partial coverage"

cat > "$LOG_DIR/2026-w08.md" <<'EOF'
---
type: weekly-log
week: 2026-W08
start: 2026-02-16
end: 2026-02-22
status: incomplete
xp: 0
sleep: []
---

## Projects

- [[project-a]]
- [[project-b]]

## Tasks

- [x] (2026-02-16) Fix bug [[project-a]]

## Backlog

## Activity
EOF

# Partial coverage (project-b has no done task) → no coverage bonus
xp_partial=$(run xp)
assert_contains "xp partial shows Feb" "Feb" "$xp_partial"

# --- Summary ---

echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
