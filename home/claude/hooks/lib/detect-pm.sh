#!/usr/bin/env bash
# Shared helper: detect the package manager for a project directory.
# Source this file; do not execute it directly.
#
# Usage: detect_pm <project_dir>
# Prints one of: bun, pnpm, yarn, npm — or nothing if no lockfile found.
# Returns 0 always; callers decide how to handle empty output.
#
# Lockfile precedence: bun.lock / bun.lockb > pnpm-lock.yaml > yarn.lock > package-lock.json

detect_pm() {
  local dir="$1"
  if [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then
    echo bun
  elif [ -f "$dir/pnpm-lock.yaml" ]; then
    echo pnpm
  elif [ -f "$dir/yarn.lock" ]; then
    echo yarn
  elif [ -f "$dir/package-lock.json" ]; then
    echo npm
  fi
}
