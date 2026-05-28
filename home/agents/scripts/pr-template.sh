#!/usr/bin/env bash
# Resolve the PR template for the current git repository.
#
# Output (always on stdout, first line is the mode marker):
#   MODE: single   — followed by the full contents of the repo's template
#   MODE: multi    — followed by one repo-relative .md path per line
#   MODE: default  — followed by the colocated default template's contents
#
# Exit codes:
#   0  on any of the three success modes
#   1  not in a git repo, or default template missing
#
# Resolution order mirrors GitHub's: multi-template directory beats single
# template; .github/ beats docs/ beats repo root; lowercase variant of each
# path is tried before the uppercase variant.

set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "pr-template: not in a git repository" >&2
  exit 1
}

# Multi-template: a directory whose .md files are the templates.
multi_dir=""
for dir in \
  "$root/.github/PULL_REQUEST_TEMPLATE" "$root/.github/pull_request_template" \
  "$root/docs/PULL_REQUEST_TEMPLATE"    "$root/docs/pull_request_template" \
  "$root/PULL_REQUEST_TEMPLATE"          "$root/pull_request_template"; do
  if [ -d "$dir" ]; then
    multi_dir="$dir"
    break
  fi
done

if [ -n "$multi_dir" ]; then
  files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$multi_dir" -maxdepth 1 -type f -name '*.md' -print0 | sort -z)
  if [ "${#files[@]}" -gt 0 ]; then
    echo "MODE: multi"
    for f in "${files[@]}"; do
      echo "${f#"$root/"}"
    done
    exit 0
  fi
fi

# Single template at a known path.
single=""
for path in \
  "$root/.github/pull_request_template.md" "$root/.github/PULL_REQUEST_TEMPLATE.md" \
  "$root/docs/pull_request_template.md"    "$root/docs/PULL_REQUEST_TEMPLATE.md" \
  "$root/pull_request_template.md"          "$root/PULL_REQUEST_TEMPLATE.md"; do
  if [ -f "$path" ]; then
    single="$path"
    break
  fi
done

if [ -n "$single" ]; then
  echo "MODE: single"
  cat "$single"
  exit 0
fi

# Default: colocated pr-template.md next to this script's source.
script_dir=$(dirname "$(readlink -f "$0")")
default="$script_dir/pr-template.md"
if [ ! -f "$default" ]; then
  echo "pr-template: default template missing at $default" >&2
  exit 1
fi
echo "MODE: default"
cat "$default"
