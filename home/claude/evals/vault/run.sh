#!/usr/bin/env bash
# Run vault skill trigger evals via Docker isolation
# Prerequisites: docker build -t claude-eval ~/.claude/evals/docker/
# Auth: docker run --rm -it -v claude-eval-home:/home/claude --entrypoint bash claude-eval -c "claude /login"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

python3 ~/.claude/evals/run_eval.py \
  --eval-set "$SCRIPT_DIR/eval_set.json" \
  --skill-path ~/.claude/skills/vault \
  --docker-image claude-eval \
  --docker-volume claude-eval-home \
  --model "${1:-claude-sonnet-4-6}" \
  --runs-per-query "${2:-1}" \
  --num-workers 5 \
  --timeout 60 \
  --verbose
