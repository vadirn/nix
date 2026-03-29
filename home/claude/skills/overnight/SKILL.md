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

Two actor types: GP (general purpose) does work, skeptic reviews it. Docker Compose handles infrastructure. pipeline.yaml handles orchestration. The runner bridges them.

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
    do("help user define steps with prompts and roles (gp/skeptic)")
    do("write pipeline.yaml to the pipeline directory")

elif "dockerfile" or needs per-project dependencies:
    do("create Dockerfile extending claude-runner with required packages")

elif "progress" or "status" or wants to check results:
    checkpoints = Bash(ls {target_dir}/checkpoint-*)
    latest = do("pick most recent checkpoint by name")
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
uv run --with pyyaml {dir}/run.py --workspace ~/projects/myapp --dir .overnight
uv run --with pyyaml {dir}/run.py --workspace . --dir pipelines/auth-refactor
```

| Flag          | Default    | Description                                          |
| ------------- | ---------- | ---------------------------------------------------- |
| `--workspace` | (required) | Repo directory                                       |
| `--dir`       | (required) | Pipeline directory (pipeline.yaml, Dockerfile)          |

The runner is launched by Claude via the Bash tool. It ignores signals and runs until the pipeline completes or a stop mechanism is used (see Stopping section).

### pipeline.yaml

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

Top-level fields:

| Field      | Default     | Description                                |
| ---------- | ----------- | ------------------------------------------ |
| `name`     | `overnight` | Pipeline identifier                        |
| `skills`   | `[]`        | Skills to copy from canonical paths at launch |
| `defaults` | (see below) | Default values for step fields             |

Step fields:

| Field        | Default       | Description                             |
| ------------ | ------------- | --------------------------------------- |
| `name`       | (required)    | Step identifier                         |
| `prompt`     | (required)    | Task (GP) or review criteria (skeptic)  |
| `role`       | `gp`          | `gp` or `skeptic`                      |
| `model`      | from defaults | Model override for this step            |
| `max_rounds` | from defaults | GP-skeptic iterations for this pair     |
| `verify_cmd` | (none)        | Shell command run by runner before skeptic. Output passed as context |

Default values: `model: claude-opus-4-6[1m]`, `max_rounds: 5`, `wait: 30`.

### GP-skeptic workflow

Steps are paired by adjacency: a skeptic step always reviews the preceding GP step.

1. Runner runs the GP step. GP does work, writes a checkpoint.
2. Runner runs the skeptic step. Skeptic receives the GP checkpoint and a git diff of changes.
3. If skeptic writes STEP_COMPLETE: the pair is done. Move to the next GP step.
4. If skeptic writes STEP_IN_PROGRESS: runner feeds the skeptic's feedback back to the GP. GP re-runs, addressing each feedback item.
5. Repeat until skeptic approves or max_rounds is reached.

`max_rounds` on the skeptic step controls how many GP-skeptic iterations are allowed. A standalone GP (no following skeptic) can self-complete.

STEP_FAILED from either actor aborts the pipeline immediately.

Between pairs, the next GP receives both the previous GP's work summary and the skeptic's verdict as context.

### Per-project Dockerfile

When a project needs tools beyond bash/curl/git:

```dockerfile
FROM claude-runner
COPY skills/ /workspace/.claude/skills/
USER root
RUN apt-get update && apt-get install -y nodejs npm python3
USER claude
```

Per-project Dockerfiles COPY `skills/` from the build context. These are assembled by the overnight skill at launch from canonical paths.

### Checkpoint format

Each round writes a checkpoint with YAML frontmatter + markdown body:

```markdown
---
status: STEP_IN_PROGRESS
step: implement
round: 3
---

## Done
...

## Decisions
...

## Frictions
...

## Next
...

## Open questions
...
```

Status values: `STEP_COMPLETE`, `STEP_IN_PROGRESS`, `STEP_FAILED`.

Filename: `checkpoint-{step}-{timestamp}-{seq}.md`.

### Pipeline directory layout

Versioned configs (tracked in git):

```
home/claude/pipelines/
  auth-refactor/
    pipeline.yaml
    Dockerfile
```

Runtime artifacts (generated by runner, excluded from commits):

```
docker-compose.yml            # generated from pipeline.yaml step names
skills/                       # assembled at launch
checkpoint-*.md
tool-calls.jsonl
STOP
```

Suggested .gitignore for pipeline directories:
```
docker-compose.yml
skills/
checkpoint-*.md
tool-calls.jsonl
STOP
```

### How it works

The runner (`run.py`) reads `pipeline.yaml`, generates `docker-compose.yml` from the step names, and builds all images via `docker compose build`. Then it executes steps:

1. For a GP step: builds a prompt with the task and previous state, runs `docker compose run {step}` with the prompt
2. Commits workspace changes outside Docker
3. If a skeptic follows: builds a review prompt with the GP checkpoint and git diff, runs `docker compose run {skeptic}`
4. If skeptic says IN_PROGRESS: loops back to GP with feedback
5. If skeptic says COMPLETE: advances to the next pair

Git is mounted read-only inside Docker to prevent `.git/config` corruption.

The Docker volume persists `~/.claude.json` (OAuth) and `~/.claude/` (settings) across runs. The entrypoint self-heals stale claude symlinks when the volume outlives an image rebuild.

### Stopping

- **Stop file**: `touch {dir}/STOP` stops after the current round (works from any terminal or Claude session)
- **Immediate kill**: `docker kill overnight-{step}-{round}` kills the current round's container
- **Kill everything**: `docker kill $(docker ps -q -f name=overnight) 2>/dev/null; pkill -f "run.py --workspace"` kills all overnight containers and the runner process
- **Automatic**: skeptic writes STEP_COMPLETE for the final pair
- **Max rounds**: each GP-skeptic pair has a configurable iteration limit
- **Pipeline abort**: STEP_FAILED from any actor aborts the pipeline
