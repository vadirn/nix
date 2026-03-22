---
name: nightshift
description: >
  Set up and run autonomous Claude Code sessions in Docker. Use when the user says "nightshift",
  "run overnight", "autonomous run", "run this unattended", "Docker Claude", "headless Claude",
  or wants to delegate a task to run without supervision. Also use when creating a project.md
  for nightshift, building a project-specific Dockerfile, checking nightshift progress, or
  setting up the Docker runner for the first time. Covers setup, project file creation,
  per-project dependencies, and launching runs.
---

# Nightshift

Autonomous Claude Code runner in Docker. Runs a task list iteratively with fresh context per iteration, coordinated via `project.md` (task spec) and `progress.txt` (cross-iteration state).

```
dir = skill base directory
command = user intent

// Check prerequisites
image_exists = Bash(docker images claude-runner -q)
volume_exists = Bash(docker volume ls -q -f name=claude-runner-home)
if not image_exists or not volume_exists:
    do("follow Setup procedure, then continue")

if "setup":
    do("follow Setup procedure")

elif "run" or wants to launch a nightshift:
    if no project.md in workspace:
        do("help user create project.md from template")
    do("determine flags: workspace, iterations, wait, model")
    if project needs extra tools (linters, runtimes, test frameworks):
        do("create per-project Dockerfile extending claude-runner")
    do("construct and show nightshift command, confirm before running")

elif "project" or wants to write a project.md:
    Read(dir/project.md)  // template
    do("fill template from user's task description")

elif "dockerfile" or needs per-project dependencies:
    do("create Dockerfile extending claude-runner with required packages")

elif "progress" or "status" or wants to check results:
    progress = Read(workspace/progress.txt)
    do("summarize what was done, what remains")

else:
    do("help user with their nightshift question")
```

## Reference

### Setup (one-time)

Three steps, each requires the previous:

All paths below use `{dir}` for the skill base directory. Resolve it before showing commands to the user.

```bash
# 1. Build the image
docker build -t claude-runner {dir}

# 2. Create persistent volume for auth + claude state
docker volume create claude-runner-home

# 3. Login (interactive, stores OAuth in volume)
docker run --rm -it -v claude-runner-home:/home/claude claude-runner bash -c "claude /login"
```

To verify: `docker run --rm -v claude-runner-home:/home/claude claude-runner --version`

### Running

```bash
{dir}/run.sh --workspace ~/projects/myapp
{dir}/run.sh --workspace . --model claude-opus-4-6[1m] --wait 60
{dir}/run.sh --workspace . --dockerfile ./Dockerfile.claude
```

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace` | (required) | Repo directory containing `project.md` |
| `--iterations` | 100 | Max iterations (stops early on NIGHTSHIFT_COMPLETE) |
| `--wait` | 300 | Seconds between iterations (5 min) |
| `--model` | claude-opus-4-6[1m] | Model for each iteration |
| `--dockerfile` | (none) | Per-project Dockerfile extending claude-runner |
| `--docker-image` | claude-runner | Base image name |
| `--docker-volume` | claude-runner-home | Named volume for `/home/claude` |

Ctrl+C stops gracefully after the current iteration. Press Ctrl+C again to force-kill immediately.

### project.md template

```markdown
# Task: [title]

## Objective

[One paragraph describing what should be accomplished]

## Deliverables

1. [Concrete deliverable 1]
2. [Concrete deliverable 2]

## Acceptance criteria

- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]

## Context

[Background, architectural constraints, links to docs]

## Files

[Key files to read or modify]
```

A good project.md is self-contained: the autonomous agent has no access to conversation history, only this file and the repo. Include enough context for a cold start.

### Per-project Dockerfile

When a project needs tools beyond bash/curl/git (linters, Node, Python, Rust, test frameworks):

```dockerfile
FROM claude-runner
USER root
RUN apt-get update && apt-get install -y nodejs npm python3
USER claude
```

Pass via `--dockerfile ./Dockerfile.claude`. The runner builds a tagged image from it before starting iterations.

### How it works

Each iteration runs `claude -p` in a fresh Docker container with `--dangerously-skip-permissions`. The prompt instructs claude to read `project.md` for the task and `progress.txt` for prior iteration state. Claude appends a summary to `progress.txt` before finishing, so the next iteration can continue. When all tasks are done, claude writes `NIGHTSHIFT_COMPLETE` as the last line of `progress.txt`, and the runner stops.

The Docker volume persists `~/.claude.json` (OAuth) and `~/.claude/` (MCP config, settings) across runs. The entrypoint self-heals stale claude symlinks when the volume outlives an image rebuild.

### Stopping

- **Automatic**: claude writes `NIGHTSHIFT_COMPLETE` to progress.txt when all tasks are done
- **Manual**: Ctrl+C stops gracefully after the current iteration. Ctrl+C again force-kills the running container
- **Iterations cap**: default 100, set lower with `--iterations` for shorter runs
