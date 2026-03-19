# Vault skill trigger evals

Tests whether the vault skill description triggers correctly for a set of queries.

## Setup (one-time)

```bash
# Build the eval Docker image
docker build -t claude-eval ~/.claude/evals/docker/

# Create persistent auth volume and log in
docker volume create claude-eval-home
docker run --rm -it -v claude-eval-home:/home/claude --entrypoint bash claude-eval -c "claude /login"
```

## Run evals

```bash
./run.sh                        # default: sonnet, 1 run/query
./run.sh claude-opus-4-6        # use opus
./run.sh claude-sonnet-4-6 3    # 3 runs/query for stability check
```

## Files

| File | Purpose |
|------|---------|
| `eval_set.json` | 27 queries: 17 should-trigger, 10 should-not-trigger |
| `run.sh` | Wrapper around `~/.claude/evals/run_eval.py` with Docker flags |
| `Dockerfile` | Copied to `~/.claude/evals/docker/` during setup |
| `entrypoint.sh` | Copied to `~/.claude/evals/docker/` during setup |

## How it works

Each query runs in its own Docker container with a temporary skill directory. Docker isolation ensures no host-installed skills shadow the test skill. The eval runner checks whether `claude -p` invokes the Skill tool for the test skill's unique name.

## Editing the eval set

Open `eval_set.json` directly, or use the HTML reviewer:

```bash
# From a Claude session:
# skill-creator generates an interactive HTML page for editing eval queries
# Export saves to ~/Downloads/eval_set.json
```
