#!/bin/bash
# Tests for the nc shim.
#
# The shim ends in `exec`, so a test observes which branch ran rather than the
# shim's own exit. A stub stands in for ncat and records that it was reached.
# The fall-through branch reaches the real /usr/bin/nc, so every proxy-shaped
# case points at 127.0.0.1:1 — a closed loopback port refuses at once and no
# traffic leaves the host.
SCRIPT="$(dirname "$0")/nc"
PASS=0
FAIL=0

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# A stray ALL_PROXY in the caller's environment would decide these cases.
unset ALL_PROXY
unset NC_SHIM_CANDIDATES

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

check_no_match() { # desc, actual, pattern
  case "$2" in
    *$3*) fail "$1 (got '$2', want no match '$3')" ;;
    *) pass ;;
  esac
}

STUBDIR="$TMPROOT/stub"
mkdir -p "$STUBDIR"
export MARKER="$TMPROOT/invoked"

# Records the argv and credentials the shim handed over, then stops. Quoted
# heredoc: $MARKER and $NCAT_PROXY_AUTH resolve when the stub runs, not now.
cat > "$STUBDIR/ncat" << 'STUB'
#!/bin/bash
{
  echo "auth=${NCAT_PROXY_AUTH:-}"
  echo "argv=$*"
} > "$MARKER"
STUB
chmod +x "$STUBDIR/ncat"

# Runs the shim with a scrubbed PATH. Sets STUBBED (yes/no), AUTH, ARGV, ERR.
# Extra leading `VAR=value` words become environment for the run.
run_shim() { # [env words...] -- args...
  local envwords=()
  while [ "$1" != "--" ]; do
    envwords+=("$1")
    shift
  done
  shift
  rm -f "$MARKER"
  env -i "PATH=$PATH_UNDER_TEST" "MARKER=$MARKER" "${envwords[@]}" \
    /bin/bash "$SCRIPT" "$@" > /dev/null 2> "$TMPROOT/err"
  ERR=$(cat "$TMPROOT/err")
  if [ -f "$MARKER" ]; then
    STUBBED=yes
    AUTH=$(sed -n 's/^auth=//p' "$MARKER")
    ARGV=$(sed -n 's/^argv=//p' "$MARKER")
  else
    STUBBED=no
    AUTH=""
    ARGV=""
  fi
}

PROXY='socks5://user:secret@127.0.0.1:1'

# --- the proxied shape reaches ncat -----------------------------------------

PATH_UNDER_TEST="$STUBDIR:/usr/bin:/bin"
run_shim "ALL_PROXY=$PROXY" -- -X 5 -x 127.0.0.1:1 example.invalid 22
check "proxied shape reaches the helper" "$STUBBED" "yes"
check "credentials are passed out of ALL_PROXY" "$AUTH" "user:secret"
check "helper is aimed at the loopback proxy" "$ARGV" \
  "--proxy-type socks5 --proxy 127.0.0.1:1 example.invalid 22"

# ssh may insert its own flags between the proxy and the target. The target is
# taken from the tail, so those extra words must not change the handover.
run_shim "ALL_PROXY=$PROXY" -- -X 5 -x 127.0.0.1:1 -w 10 example.invalid 22
check "extra flags keep the shape" "$STUBBED" "yes"
check_match "target still comes from the tail" "$ARGV" "example.invalid 22"

# --- the regression: PATH lost the helper's directory ------------------------

# A devshell that rewrites PATH drops /opt/homebrew/bin. Before the absolute
# fallback, this silently ran /usr/bin/nc and failed as "connection refused".
PATH_UNDER_TEST="/usr/bin:/bin"
run_shim "ALL_PROXY=$PROXY" "NC_SHIM_CANDIDATES=$STUBDIR/ncat" -- \
  -X 5 -x 127.0.0.1:1 example.invalid 22
check "absolute fallback recovers a lost PATH" "$STUBBED" "yes"
check "fallback still passes credentials" "$AUTH" "user:secret"
check "fallback stays quiet" "$ERR" ""

# --- the helper is genuinely missing ----------------------------------------

run_shim "ALL_PROXY=$PROXY" "NC_SHIM_CANDIDATES=/nonexistent/ncat" -- \
  -X 5 -x 127.0.0.1:1 example.invalid 22
check "missing helper does not reach the stub" "$STUBBED" "no"
check_match "missing helper names itself on stderr" "$ERR" "ncat not found"

# --- shapes that must pass straight through ---------------------------------

PATH_UNDER_TEST="$STUBDIR:/usr/bin:/bin"

# The real nc answers -h with its usage text, which is what passing through
# looks like. The shim must add nothing of its own to that.
run_shim -- -h
check "ordinary use never reaches the helper" "$STUBBED" "no"
check_match "ordinary use reaches the real nc" "$ERR" "usage: nc"
check_no_match "ordinary use adds no shim noise" "$ERR" "shim:"

# No credentials in ALL_PROXY means /usr/bin/nc can do the job unaided.
run_shim "ALL_PROXY=socks5://127.0.0.1:1" -- -X 5 -x 127.0.0.1:1 example.invalid 22
check "unauthenticated proxy passes through" "$STUBBED" "no"

# A proxy argument the shim cannot vouch for is left alone.
run_shim "ALL_PROXY=socks5://user:secret@127.0.0.1:2" -- \
  -X 5 -x 127.0.0.1:1 example.invalid 22
check "mismatched proxy host passes through" "$STUBBED" "no"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
