# Sourced by every script here. Resolves where run data lives.
#
# Model answers stay out of this repo: it is public, and the answers are
# private. They sit in ~/Documents/agent-calibration, outside the vault so the
# note tooling never walks 280 files of raw model prose. Override with
# AGENTS_EVAL_DATA to point a run at a different corpus.

: "${AGENTS_EVAL_DATA:=$HOME/Documents/agent-calibration}"
export AGENTS_EVAL_DATA
