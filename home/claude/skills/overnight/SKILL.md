---
name: overnight
description: >
  Set up and run autonomous Claude Code sessions in Docker. Use when the user says "overnight",
  "run overnight", "autonomous run", "run this unattended", "Docker Claude", "headless Claude",
  or wants to delegate a task to run without supervision. Also use when creating a pipeline.yaml
  for overnight, building a project-specific Dockerfile, checking overnight progress, or
  setting up the Docker runner for the first time. Covers setup, pipeline creation,
  per-project dependencies, and launching runs.
---

# Overnight

GP does work, skeptic reviews it. Steps come in (gp, skeptic) pairs. Docker Compose handles infrastructure. pipeline.yaml handles orchestration.

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

elif "run" or wants to launch an overnight run:
    // Determine pipeline directory
    if user specifies a directory:
        target_dir = user's directory
    elif existing pipeline.yaml found in workspace:
        target_dir = dirname of that pipeline.yaml
    else:
        pipelines = Glob("home/claude/pipelines/*/pipeline.yaml")
        if pipelines and len(pipelines) == 1:
            selected = pipelines[0]
        elif pipelines:
            selected = AskUserQuestion("Which pipeline?", options=pipeline names)
        else:
            do("help user create pipeline.yaml")
        target_dir = AskUserQuestion("Pipeline directory?", default=".overnight")
        Bash(mkdir -p {target_dir})
        Bash(cp -r {dirname(selected)}/* {target_dir}/)

    // Assemble skills from canonical paths
    skills_list = read {target_dir}/pipeline.yaml "skills" field
    Bash(mkdir -p {target_dir}/skills)
    for skill in skills_list:
        Bash(cp -r home/claude/skills/{skill} {target_dir}/skills/{skill})

    do("construct and show run command, confirm before running")
    // uv run --with pyyaml {dir}/run.py --workspace {workspace} --dir {target_dir}

elif "pipeline" or wants to write a pipeline.yaml:
    do("help user define (gp, skeptic) pairs with prompts")
    do("write pipeline.yaml to the pipeline directory")

elif "dockerfile" or needs per-project dependencies:
    do("create Dockerfile extending claude-runner with required packages")

elif "progress" or "status" or wants to check results:
    checkpoints = Bash(ls {target_dir}/checkpoint-*)
    latest = do("pick highest-numbered checkpoint")
    Read(latest)
    do("summarize what was done, what remains")
    AskUserQuestion("Continue watching, or stop the run?")
    if stop: Bash(touch {target_dir}/STOP)

elif "stop" or wants to stop a running overnight:
    Bash(touch {target_dir}/STOP)
    do("confirm stop file created")

else:
    do("help user with their overnight question")
```

## Reference

### Setup (one-time)

All paths below use `{dir}` for the skill base directory. Resolve it before showing commands.

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
uv run --with pyyaml {dir}/run.py --workspace ~/projects/myapp --dir .overnight
uv run --with pyyaml {dir}/run.py --workspace . --dir pipelines/auth-refactor
```

| Flag          | Default    | Description                              |
| ------------- | ---------- | ---------------------------------------- |
| `--workspace` | (required) | Repo directory                           |
| `--dir`       | (required) | Pipeline directory (pipeline.yaml, Dockerfile) |

### pipeline.yaml

Steps come in (gp, skeptic) pairs. Every GP step must be followed by a skeptic step.

```yaml
name: auth-refactor
skills: [tdd, probe]

defaults:
  model: claude-opus-4-6[1m]
  max_rounds: 5
  wait: 30

steps:
  - name: analyze
    prompt: |
      Analyze the auth module. Identify every file using session auth.
      Write a migration plan.

  - name: review-analysis
    role: skeptic
    prompt: |
      Verify the migration plan covers all auth entry points.
      Check for missing files and implicit dependencies.

  - name: implement
    prompt: |
      Replace session auth with JWT. Start with /api/login,
      then expand to remaining endpoints.

  - name: review-impl
    role: skeptic
    prompt: |
      Run the test suite. Verify no session-based imports remain.
      Check for hardcoded secrets and token expiry edge cases.
```

Step fields:

| Field        | Default       | Description                             |
| ------------ | ------------- | --------------------------------------- |
| `name`       | (required)    | Step identifier                         |
| `prompt`     | (required)    | Task (GP) or review criteria (skeptic)  |
| `role`       | `gp`          | `gp` or `skeptic`                      |
| `model`      | from defaults | Model override for this step            |
| `max_rounds` | from defaults | GP-skeptic iterations for this pair     |
| `verify_cmd` | (none)        | Shell command run before skeptic. Output passed as context |

Default values: `model: claude-opus-4-6[1m]`, `max_rounds: 5`, `wait: 30`.

### GP-skeptic workflow

1. Runner runs GP. GP writes checkpoint with ## Plan and ## Progress. GP always sets status STEP_IN_PROGRESS.
2. Runner backs up checkpoint, runs skeptic. Skeptic rewrites the checkpoint: preserves ## Plan and ## Progress, adds ## Feedback, sets final status.
3. Runner validates skeptic preserved GP sections (restores backup if corrupted).
4. If STEP_COMPLETE: pair done, advance to next pair.
5. If STEP_IN_PROGRESS: GP re-runs with the checkpoint (containing feedback) as context.
6. Repeat until skeptic approves or max_rounds reached.

STEP_FAILED from skeptic aborts the pipeline. GP crash (nonzero exit + no checkpoint) also aborts.

Checkpoint filename: `checkpoint-{NNN}.md` (global sequential counter). One file per GP-skeptic iteration, shared by both agents.

### Checkpoint format

Defined in `checkpoint.md` (loaded by runner, included in prompts). Sections:

- `## Plan`: what the agent intends to do
- `## Progress`: what was accomplished
- `## Feedback`: skeptic's review (added by skeptic)

YAML frontmatter: `status`, `step`, `round`.

### Per-project Dockerfile

```dockerfile
FROM claude-runner
COPY skills/ /workspace/.claude/skills/
USER root
RUN apt-get update && apt-get install -y nodejs npm python3
USER claude
```

### Pipeline directory layout

Versioned (tracked in git):

```
home/claude/pipelines/auth-refactor/
  pipeline.yaml
  Dockerfile
```

Runtime artifacts (excluded from commits):

```
docker-compose.yml
skills/
checkpoint-*.md
tool-calls.jsonl
STOP
```

### Stopping

- **Stop file**: `touch {dir}/STOP` stops after current round
- **Immediate kill**: `docker kill overnight-{step}-{round}`
- **Kill everything**: `docker kill $(docker ps -q -f name=overnight) 2>/dev/null; pkill -f "run.py --workspace"`
- **Max rounds**: configurable per pair
- **Pipeline abort**: STEP_FAILED from skeptic aborts
