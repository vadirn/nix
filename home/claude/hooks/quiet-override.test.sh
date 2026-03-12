#!/bin/bash
# Tests for quiet-override.sh
SCRIPT="$(dirname "$0")/quiet-override.sh"
PASS=0
FAIL=0

assert_rewrite() {
  local desc="$1" cmd="$2" expected="$3"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  actual=$(echo "$result" | jq -r '.hookSpecificOutput.updatedInput.command // empty')
  if [ "$actual" = "$expected" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected rewrite): $desc"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_unchanged() {
  local desc="$1" cmd="$2"
  result=$(echo '{"tool_input":{"command":"'"$cmd"'"}}' | bash "$SCRIPT")
  if [ -z "$result" ]; then
    ((PASS++))
  else
    ((FAIL++))
    echo "FAIL (expected unchanged): $desc"
    echo "  got: $result"
  fi
}

# git
assert_rewrite  "git commit"          "git commit -m test"        "git commit -q -m test"
assert_rewrite  "git clone"           "git clone https://x.git"   "git clone -q https://x.git"
assert_rewrite  "git fetch"           "git fetch origin"          "git fetch -q origin"
assert_rewrite  "git pull"            "git pull"                  "git pull -q"
assert_unchanged "git already -q"     "git commit -q -m test"
assert_unchanged "git already --quiet" "git clone --quiet url"
assert_unchanged "git status"         "git status"
assert_unchanged "git log"            "git log --oneline"

# npm
assert_rewrite  "npm install"         "npm install"               "npm install --silent"
assert_rewrite  "npm ci"              "npm ci"                    "npm ci --silent"
assert_rewrite  "npm i"               "npm i express"             "npm i --silent express"
assert_unchanged "npm already silent"  "npm install --silent"
assert_unchanged "npm with pipe"       "npm install | tee log"
assert_unchanged "npm run"             "npm run build"

# cargo
assert_rewrite  "cargo build"         "cargo build"               "cargo build -q"
assert_unchanged "cargo already -q"    "cargo build -q"
assert_unchanged "cargo test"          "cargo test"

# make
assert_rewrite  "make"                "make"                      "make -s"
assert_rewrite  "make target"         "make build"                "make -s build"
assert_unchanged "make already -s"     "make -s"
assert_unchanged "make with pipe"      "make | head"

# pip
assert_rewrite  "pip install"         "pip install requests"      "pip install -q requests"
assert_rewrite  "pip3 install"        "pip3 install flask"        "pip3 install -q flask"
assert_rewrite  "python -m pip"       "python3 -m pip install x"  "python3 -m pip install -q x"
assert_unchanged "pip already -q"      "pip install -q requests"

# wget
assert_rewrite  "wget"               "wget https://x.com/file"   "wget -q https://x.com/file"
assert_unchanged "wget already -q"    "wget -q https://x.com/f"
assert_unchanged "wget with -O"       "wget -O out.txt url"

# docker
assert_rewrite  "docker build"        "docker build ."            "docker build -q ."
assert_rewrite  "docker pull"         "docker pull nginx"         "docker pull -q nginx"
assert_unchanged "docker already -q"   "docker build -q ."
assert_unchanged "docker run"          "docker run nginx"

# ffmpeg
assert_rewrite  "ffmpeg"              "ffmpeg -i in.mp4 out.mp3"  "ffmpeg -nostats -loglevel error -i in.mp4 out.mp3"
assert_unchanged "ffmpeg already"      "ffmpeg -nostats -i in.mp4 out.mp3"

# unrelated commands
assert_unchanged "ls"                  "ls -la"
assert_unchanged "echo"                "echo hello"
assert_unchanged "cat"                 "cat file.txt"

echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
