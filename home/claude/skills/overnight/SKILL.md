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

Declarative pipeline runner for autonomous Claude Code sessions in Docker. Each step defines a task with its own skills, agent, model, and acceptance criteria. Each round runs `claude -p` in a fresh container with isolated context. Checkpoints provide structured state transfer between rounds.

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
    // Check for versioned pipelines
    pipelines = Glob("home/claude/pipelines/*/pipeline.yaml")
    if pipelines and no .overnight/pipeline.yaml in workspace:
        if len(pipelines) == 1:
            selected = pipelines[0]
        else:
            selected = AskUserQuestion("Which pipeline?", options=pipeline names)
        pipeline_dir = dirname(selected)
        // Copy all resources from versioned pipeline to .overnight/
        Bash(mkdir -p .overnight)
        Bash(cp -r <pipeline_dir>/* .overnight/)
        // Always copy built-in checkpoint skill (required by runner)
        Bash(cp -r <dir>/skills/checkpoint .overnight/skills/checkpoint)
    if no .overnight/pipeline.yaml in workspace:
        do("help user create .overnight/pipeline.yaml")
    if project needs extra tools (linters, runtimes, test frameworks):
        do("create .overnight/Dockerfile or .overnight/Dockerfile.<step> extending claude-runner")
    if project needs custom skills:
        do("create skills in .overnight/skills/")
    do("construct and show run command, confirm before running")
    // uv run --with pyyaml <dir>/run.py --workspace <workspace>

elif "pipeline" or wants to write a pipeline.yaml:
    do("help user define steps with prompts, acceptance criteria, skills")
    do("write to .overnight/pipeline.yaml")
    do("also save to home/claude/pipelines/<name>/ for version control")

elif "dockerfile" or needs per-project dependencies:
    do("create .overnight/Dockerfile extending claude-runner with required packages")

elif "progress" or "status" or wants to check results:
    checkpoints = Bash(ls workspace/.overnight/checkpoint-*)
    latest = do("pick most recent checkpoint by name")
    Read(latest)
    do("summarize what was done, what remains")
    AskUserQuestion("Continue watching, or stop the run?")
    if stop: Bash(touch workspace/.overnight/STOP)

elif "stop" or wants to stop a running overnight:
    Bash(touch workspace/.overnight/STOP)
    do("confirm stop file created")

else:
    do("help user with their overnight question")
```

## Reference

### Setup (one-time)

Three steps, each requires the previous:

All paths below use `<dir>` for the skill base directory. Resolve it before showing commands to the user.

```bash
# 1. Build the image
docker build -t claude-runner <dir>

# 2. Create persistent volume for auth + claude state
docker volume create claude-runner-home

# 3. Login (interactive, stores OAuth in volume)
docker run --rm -it -v claude-runner-home:/home/claude claude-runner bash -c "claude /login"
```

To verify: `docker run --rm -v claude-runner-home:/home/claude claude-runner --version`

### Running

```bash
uv run --with pyyaml <dir>/run.py --workspace ~/projects/myapp
uv run --with pyyaml <dir>/run.py --workspace . --docker-image claude-runner-custom
```

| Flag              | Default                    | Description                     |
| ----------------- | -------------------------- | ------------------------------- |
| `--workspace`     | (required)                 | Repo directory                  |
| `--pipeline`      | `.overnight/pipeline.yaml` | Pipeline definition file        |
| `--docker-image`  | `claude-runner`            | Base image name                 |
| `--docker-volume` | `claude-runner-home`       | Named volume for `/home/claude` |

The runner is launched by Claude via the Bash tool. It ignores signals and runs until the pipeline completes or a stop mechanism is used (see Stopping section).

### pipeline.yaml

```yaml
name: auth-refactor

defaults:
  model: claude-opus-4-6[1m] # model for work rounds
  image: claude-runner # default Docker image
  max_rounds: 50 # max rounds per step
  wait: 30 # seconds between rounds
  resolve_questions: true # spawn resolver for open questions
  explore_model: claude-haiku-4-5 # model for resolver agent

steps:
  - name: analyze
    prompt: |
      Analyze the auth module. Identify every file using session auth.
      Write a migration plan.
    skills: [explore]
    max_rounds: 30

  - name: implement
    prompt: |
      Replace session auth with JWT. Start with /api/login end-to-end,
      then expand to remaining endpoints.
    accept: |
      - no session-based auth imports remain
      - tests pass
    skills: [tracer-bullet, tdd]
    agent: api-developer
    image: .overnight/Dockerfile.implement
    max_rounds: 100

  - name: verify
    prompt: |
      Run full test suite. Fix any failures.
    accept: |
      - test suite passes
    verify: "cd /workspace && npm test"
    skills: [tdd]
    max_rounds: 30
    on_fail: retry
    max_retries: 2
```

Step fields:

| Field               | Default       | Description                                      |
| ------------------- | ------------- | ------------------------------------------------ |
| `name`              | (required)    | Step identifier                                  |
| `prompt`            | (required)    | Task description for the agent                   |
| `accept`            | (none)        | Acceptance criteria                              |
| `skills`            | `[]`          | Skills from `.overnight/skills/`                 |
| `agent`             | (none)        | Agent from `.overnight/agents/`                  |
| `image`             | from defaults | Docker image or Dockerfile path                  |
| `model`             | from defaults | Model override                                   |
| `max_rounds`        | from defaults | Max rounds for this step                         |
| `on_fail`           | `stop`        | `stop` or `retry`                                |
| `max_retries`       | `0`           | Retry count when `on_fail: retry`                |
| `resolve_questions` | from defaults | Spawn resolver for open questions                |
| `verify`            | (none)        | Shell command run inside Docker after each round |
| `depends_on`        | (none)        | Reserved for v2 DAG support                      |

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

Filename: `checkpoint-<timestamp>-<seq>.md` (e.g., `checkpoint-2026-03-24-11-45-58-001.md`).

### Per-project Dockerfile

When a project needs tools beyond bash/curl/git:

```dockerfile
FROM claude-runner
USER root
RUN apt-get update && apt-get install -y nodejs npm python3
USER claude
```

Place at `.overnight/Dockerfile` for all steps, or `.overnight/Dockerfile.<step-name>` for a specific step.

### Directory layout

Versioned configs (tracked in git):

```
home/claude/pipelines/
  eval-gen/                    # one directory per pipeline
    pipeline.yaml
    Dockerfile
    agents/
      eval-gen.md
  another-pipeline/
    pipeline.yaml
```

Runtime directory (gitignored, ephemeral):

```
.overnight/
  pipeline.yaml                # copied from versioned pipeline at launch
  Dockerfile
  skills/
    checkpoint/SKILL.md        # always injected (provided by overnight)
    tracer-bullet/SKILL.md     # methodology skills
  agents/
    resolver.md                # question resolver (provided by overnight)
  checkpoint-2026-03-24-11-45-58-001.md
  checkpoint-2026-03-24-11-50-12-002.md
  STOP
```

Add `.overnight` to `.gitignore`. Runtime artifacts are ephemeral. Pipeline configs live in `home/claude/pipelines/` and are copied to `.overnight/` at launch.

### How it works

The runner (`run.py`) reads `pipeline.yaml` and executes steps sequentially. Each step runs one or more rounds (a round is one `claude -p` invocation in Docker). Each round:

1. Builds a `claude -p` prompt with the step's task, acceptance criteria, and previous checkpoint
2. Mounts filtered skills (checkpoint + step-specific) and agents into the container
3. Runs `claude -p` inside Docker with `--dangerously-skip-permissions`
4. Commits workspace changes outside Docker (`git add -A -- ':!.overnight'`)
5. Parses the checkpoint's YAML frontmatter for status
6. Runs the `verify` command if configured (overrides status on failure)
7. Spawns a resolver agent (haiku) if open questions exist and `resolve_questions` is enabled

Git is mounted read-only inside Docker to prevent `.git/config` corruption. The agent has read-only access to git history.

The Docker volume persists `~/.claude.json` (OAuth) and `~/.claude/` (settings) across runs. The entrypoint self-heals stale claude symlinks when the volume outlives an image rebuild.

### Stopping

- **Stop file**: `touch .overnight/STOP` stops after the current round (works from any terminal or Claude session)
- **Immediate kill**: `docker kill overnight-<step>-<round>` kills the current round's container (container names are printed at round start)
- **Kill everything**: `docker kill $(docker ps -q -f name=overnight) 2>/dev/null; pkill -f "run.py --workspace"` kills all overnight containers and the runner process
- **Automatic**: step writes `STEP_COMPLETE` in checkpoint frontmatter
- **Max rounds**: each step has a configurable round limit
- **Pipeline abort**: a failed step with `on_fail: stop` aborts the entire pipeline

The stop file is the universal escape hatch. It works regardless of how the runner was launched.
