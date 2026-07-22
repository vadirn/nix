# Sourced by every script here. Resolves where run data lives.
#
# Model answers stay out of this repo: it is public, and the answers are
# private. They live in the vault sidecar for the experiment that owns them,
# which is also what gets backed up. Override with AGENTS_EVAL_DATA to point a
# run at a different corpus.

: "${AGENTS_EVAL_DATA:=$HOME/Documents/vault/35 experiments/2026-07-22-agentsmd-archetype-arms.files}"
export AGENTS_EVAL_DATA
