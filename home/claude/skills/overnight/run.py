#!/usr/bin/env python3
"""Overnight pipeline runner v2.

Invoked via: uv run --with pyyaml run.py --workspace DIR --dir DIR

Two actor types: GP (general purpose) does work, skeptic reviews it.
Docker Compose handles infrastructure. pipeline.yaml handles orchestration.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from string import Template

import yaml

# ---------------------------------------------------------------------------
# Section 1: Data model
# ---------------------------------------------------------------------------

COMPLETE = "STEP_COMPLETE"
IN_PROGRESS = "STEP_IN_PROGRESS"
FAILED = "STEP_FAILED"

DEFAULTS = {
    "model": "claude-opus-4-6[1m]",
    "max_rounds": 5,
    "wait": 30,
}


@dataclass
class StepConfig:
    name: str
    prompt: str
    role: str = "gp"
    model: str = ""
    max_rounds: int = 0
    verify_cmd: str = ""


@dataclass
class PipelineConfig:
    name: str
    skills: list[str] = field(default_factory=list)
    defaults: dict = field(default_factory=dict)
    steps: list[StepConfig] = field(default_factory=list)


def load_pipeline(path: str) -> PipelineConfig:
    """Parse pipeline.yaml and merge defaults into each step."""
    with open(path) as f:
        raw = yaml.safe_load(f)

    if not raw or "steps" not in raw:
        print("error: pipeline.yaml must have a 'steps' list", file=sys.stderr)
        sys.exit(1)

    defaults = {**DEFAULTS, **(raw.get("defaults") or {})}
    steps = []

    for i, s in enumerate(raw["steps"]):
        if "name" not in s or "prompt" not in s:
            print(f"error: step {i} must have 'name' and 'prompt'", file=sys.stderr)
            sys.exit(1)

        role = s.get("role", "gp")
        step = StepConfig(
            name=s["name"],
            prompt=s["prompt"],
            role=role,
            model=s.get("model", defaults["model"]),
            max_rounds=s.get("max_rounds", defaults["max_rounds"]),
            verify_cmd=s.get("verify_cmd", ""),
        )
        steps.append(step)

    return PipelineConfig(
        name=raw.get("name", "overnight"),
        skills=raw.get("skills", []),
        defaults=defaults,
        steps=steps,
    )


def validate_pipeline(pipeline: PipelineConfig) -> None:
    """Reject invalid step ordering."""
    for i, step in enumerate(pipeline.steps):
        if step.role not in ("gp", "skeptic"):
            print(f"error: step '{step.name}' has invalid role '{step.role}'",
                  file=sys.stderr)
            sys.exit(1)
        if step.role == "skeptic" and (i == 0 or pipeline.steps[i - 1].role != "gp"):
            print(f"error: skeptic step '{step.name}' must follow a gp step",
                  file=sys.stderr)
            sys.exit(1)
        if step.role == "gp" and step.verify_cmd:
            print(f"error: verify_cmd on gp step '{step.name}' has no effect",
                  file=sys.stderr)
            sys.exit(1)


# ---------------------------------------------------------------------------
# Section 2: Prompt templates
# ---------------------------------------------------------------------------

CHECKPOINT_FORMAT = """
## Checkpoint format

Write the checkpoint file with YAML frontmatter:

```
---
status: STEP_COMPLETE
step: {step_name}
round: {round_number}
---

## Done
What was accomplished.

## Next
What remains (if IN_PROGRESS).
```

Status must be exactly one of: STEP_COMPLETE, STEP_IN_PROGRESS, STEP_FAILED."""

GP_TEMPLATE = """\
You are running as an autonomous agent.
Step: "{step_name}", round {round_number}.

## Task
{prompt}

## Previous State
{prev_checkpoint}

## Instructions
- Work autonomously. Write checkpoint to {checkpoint_path}.
- Set status STEP_COMPLETE when your task is finished.
- Set status STEP_IN_PROGRESS with clear ## Next items when work remains.
- Set status STEP_FAILED when blocked and cannot proceed.
- The orchestrator handles git commits. Focus on code changes and checkpoint.
{checkpoint_format}"""

GP_AFTER_SKEPTIC_TEMPLATE = """\
You are running as an autonomous agent.
Step: "{step_name}", round {round_number}.

## Task
{prompt}

## Your Previous Checkpoint
{gp_checkpoint}

## Reviewer Feedback
{skeptic_checkpoint}

## Instructions
- Address each item in the reviewer feedback before proceeding.
- Write checkpoint to {checkpoint_path}.
- Set status STEP_COMPLETE when your task is finished.
- Set status STEP_IN_PROGRESS with clear ## Next items when work remains.
- Set status STEP_FAILED when blocked and cannot proceed.
{checkpoint_format}"""

SKEPTIC_TEMPLATE = """\
You are a reviewer evaluating the previous step's work.
Step: "{step_name}", round {round_number}.

## Review Criteria
{prompt}

## Work Under Review
{gp_checkpoint}

## Changes Made
{git_diff}

## Instructions
- Write checkpoint to {checkpoint_path} with your verdict. This is required.
- Set STEP_COMPLETE if the work meets criteria.
- Set STEP_IN_PROGRESS with specific, actionable feedback if revisions needed.
- Set STEP_FAILED if the work has unrecoverable issues.
- Be concrete: name files, functions, specific issues.
{checkpoint_format}"""


# ---------------------------------------------------------------------------
# Section 3: Checkpoint parsing
# ---------------------------------------------------------------------------

def parse_checkpoint(path: str) -> dict:
    """Parse checkpoint YAML frontmatter. Returns dict with at least 'status'."""
    if not os.path.exists(path):
        return {"status": IN_PROGRESS}

    with open(path) as f:
        content = f.read()

    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        print("warning: checkpoint has no YAML frontmatter, assuming IN_PROGRESS", file=sys.stderr)
        return {"status": IN_PROGRESS}

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        print(f"warning: failed to parse checkpoint frontmatter: {e}", file=sys.stderr)
        return {"status": IN_PROGRESS}

    if not isinstance(frontmatter, dict) or "status" not in frontmatter:
        print("warning: checkpoint frontmatter missing 'status', assuming IN_PROGRESS", file=sys.stderr)
        return {"status": IN_PROGRESS}

    valid_statuses = {COMPLETE, IN_PROGRESS, FAILED}
    if frontmatter["status"] not in valid_statuses:
        print(f"warning: unknown status '{frontmatter['status']}', assuming IN_PROGRESS", file=sys.stderr)
        frontmatter["status"] = IN_PROGRESS

    return frontmatter


def read_file(path: str) -> str:
    """Read file contents or return empty string if missing."""
    if not os.path.exists(path):
        return ""
    with open(path) as f:
        return f.read()


# ---------------------------------------------------------------------------
# Section 4: Round execution
# ---------------------------------------------------------------------------

def run_round(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    prompt: str,
    checkpoint_filename: str,
    round_number: int,
    compose_path: str,
) -> tuple[str, int]:
    """Run one claude -p invocation via docker compose. Returns (checkpoint_path, exit_code)."""
    # Write prompt to file to avoid OS argument length limits.
    # The file is placed in the pipeline dir (mounted into the container).
    prompt_filename = f"prompt-{step.name}-{round_number}.md"
    prompt_path = os.path.join(pipeline_dir, prompt_filename)
    with open(prompt_path, "w") as f:
        f.write(prompt)

    container_name = f"overnight-{step.name}-{round_number}"
    cmd = [
        "docker", "compose", "-f", compose_path,
        "run", "--rm", "--name", container_name,
        step.name,
        "-p", f"Follow the instructions in /workspace/{os.path.relpath(prompt_path, workspace)}",
        "--dangerously-skip-permissions",
        "--model", step.model,
        "--output-format", "stream-json",
        "--verbose",
    ]

    log_path = os.path.join(pipeline_dir, "tool-calls.jsonl")
    with open(log_path, "a") as log_file:
        marker = json.dumps({
            "type": "round_start",
            "step": step.name,
            "round": round_number,
            "role": step.role,
            "ts": datetime.now().isoformat(),
        })
        log_file.write(marker + "\n")
        log_file.flush()
        proc = subprocess.Popen(
            cmd, stdout=log_file, start_new_session=True,
            env={**os.environ, "WORKSPACE": workspace},
        )
        proc.wait()

    # Clean up prompt file
    try:
        os.unlink(prompt_path)
    except OSError:
        pass

    checkpoint_path = os.path.join(pipeline_dir, checkpoint_filename)

    if proc.returncode == 0 and not os.path.exists(checkpoint_path):
        print(f"warning: {step.name} round {round_number} exited 0 but wrote no checkpoint "
              f"(expected {checkpoint_filename}), creating synthetic STEP_COMPLETE",
              file=sys.stderr)
        with open(checkpoint_path, "w") as f:
            f.write(
                f"---\nstatus: {COMPLETE}\nstep: {step.name}\n"
                f"round: {round_number}\n---\n\n"
                "## Done\n\nAgent completed without writing checkpoint. "
                "Synthetic STEP_COMPLETE created by runner.\n"
            )

    return checkpoint_path, proc.returncode


# ---------------------------------------------------------------------------
# Section 5: Git helpers
# ---------------------------------------------------------------------------

def get_commit_hash(workspace: str) -> str:
    """Get current HEAD commit hash."""
    result = subprocess.run(
        ["git", "-C", workspace, "rev-parse", "HEAD"],
        capture_output=True, text=True,
    )
    return result.stdout.strip()


MAX_DIFF_LINES = 500


def get_diff_since(workspace: str, commit_hash: str) -> str:
    """Get diff from commit_hash to current working state.

    If the diff exceeds MAX_DIFF_LINES, returns a stat summary instead
    to avoid overwhelming the agent's context window.
    Uses --shortstat first to decide whether to fetch the full diff.
    """
    shortstat = subprocess.run(
        ["git", "-C", workspace, "diff", "--shortstat", commit_hash],
        capture_output=True, text=True,
    )
    # Parse "N files changed, M insertions(+), K deletions(-)"
    # Use insertions + deletions as a line count estimate
    nums = re.findall(r"(\d+)", shortstat.stdout)
    estimated_lines = sum(int(n) for n in nums[1:]) if len(nums) > 1 else 0

    if estimated_lines <= MAX_DIFF_LINES:
        result = subprocess.run(
            ["git", "-C", workspace, "diff", commit_hash],
            capture_output=True, text=True,
        )
        return result.stdout

    # Diff too large: use stat summary instead
    stat = subprocess.run(
        ["git", "-C", workspace, "diff", "--stat", commit_hash],
        capture_output=True, text=True,
    )
    return (
        f"[Diff truncated: ~{estimated_lines} changed lines exceeds {MAX_DIFF_LINES} limit. "
        f"Showing --stat summary. Read individual files for detail.]\n\n"
        + stat.stdout
    )


def commit_round(
    workspace: str, step_name: str, iteration: int, pipeline_dir: str,
) -> None:
    """Commit workspace changes, excluding pipeline runtime artifacts."""
    result = subprocess.run(
        ["git", "-C", workspace, "status", "--porcelain"],
        capture_output=True, text=True,
    )
    if not result.stdout.strip():
        return

    # Stage everything except pipeline runtime artifacts
    rel_dir = os.path.relpath(pipeline_dir, workspace)
    excludes = [
        f":!{rel_dir}/checkpoint-*.md",
        f":!{rel_dir}/tool-calls.jsonl",
        f":!{rel_dir}/prompt-*.md",
        f":!{rel_dir}/STOP",
        f":!{rel_dir}/skills",
    ]

    subprocess.run(
        ["git", "-C", workspace, "add", "-A", "--"] + excludes,
        capture_output=True,
    )

    # Check if anything is staged
    result = subprocess.run(
        ["git", "-C", workspace, "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode == 0:
        return

    subprocess.run(
        ["git", "-C", workspace, "commit", "-m",
         f"overnight: {step_name} iteration {iteration}"],
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Section 6: Prompt builders
# ---------------------------------------------------------------------------

def run_verify_cmd(
    step: StepConfig,
    workspace: str,
    compose_path: str,
) -> tuple[str, int]:
    """Run verify_cmd inside Docker and return (stdout, exit_code)."""
    cmd = [
        "docker", "compose", "-f", compose_path,
        "run", "--rm", step.name,
        "bash", "-c", step.verify_cmd,
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        env={**os.environ, "WORKSPACE": workspace},
    )
    return result.stdout + result.stderr, result.returncode


def docker_checkpoint_path(workspace: str, pipeline_dir: str, checkpoint_filename: str) -> str:
    """Compute the checkpoint path as seen inside Docker (/workspace/...)."""
    rel = os.path.relpath(os.path.join(pipeline_dir, checkpoint_filename), workspace)
    return f"/workspace/{rel}"


def make_gp_prompt(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    prev_checkpoint: str,
    checkpoint_filename: str,
    round_number: int,
) -> str:
    return GP_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.prompt,
        prev_checkpoint=prev_checkpoint or "First round. No prior state.",
        checkpoint_path=docker_checkpoint_path(workspace, pipeline_dir, checkpoint_filename),
        checkpoint_format=CHECKPOINT_FORMAT.format(step_name=step.name, round_number=round_number),
    )


def make_gp_after_skeptic_prompt(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    gp_checkpoint: str,
    skeptic_checkpoint: str,
    checkpoint_filename: str,
    round_number: int,
) -> str:
    return GP_AFTER_SKEPTIC_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.prompt,
        gp_checkpoint=gp_checkpoint,
        skeptic_checkpoint=skeptic_checkpoint,
        checkpoint_path=docker_checkpoint_path(workspace, pipeline_dir, checkpoint_filename),
        checkpoint_format=CHECKPOINT_FORMAT.format(step_name=step.name, round_number=round_number),
    )


def make_skeptic_prompt(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    gp_checkpoint: str,
    git_diff: str,
    checkpoint_filename: str,
    round_number: int,
) -> str:
    return SKEPTIC_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.prompt,
        gp_checkpoint=gp_checkpoint,
        git_diff=git_diff or "No changes detected.",
        checkpoint_path=docker_checkpoint_path(workspace, pipeline_dir, checkpoint_filename),
        checkpoint_format=CHECKPOINT_FORMAT.format(step_name=step.name, round_number=round_number),
    )


# ---------------------------------------------------------------------------
# Section 7: Pipeline runner
# ---------------------------------------------------------------------------

def make_checkpoint_filename(step_name: str, round_number: int) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    return f"checkpoint-{step_name}-{timestamp}-{round_number:03d}.md"


COMPOSE_TEMPLATE = Template("""\
x-common: &common
  build: .
  volumes:
    - $${WORKSPACE}:/workspace
    - $${WORKSPACE}/.git:/workspace/.git:ro
    - claude-home:/home/claude

services:
$services
volumes:
  claude-home:
    external: true
    name: claude-runner-home
""")


def generate_compose(pipeline: PipelineConfig, output_path: str) -> None:
    """Generate docker-compose.yml from pipeline step names."""
    seen = set()
    services = []
    for step in pipeline.steps:
        if step.name not in seen:
            services.append(f"  {step.name}:\n    <<: *common")
            seen.add(step.name)
    content = COMPOSE_TEMPLATE.substitute(services="\n".join(services))
    with open(output_path, "w") as f:
        f.write(content)


def run_pipeline(workspace: str, pipeline_dir_arg: str) -> None:
    """Load pipeline. Execute steps with GP-skeptic loop."""
    pipeline_dir = Path(pipeline_dir_arg)
    pipeline_dir_str = pipeline_dir_str
    pipeline = load_pipeline(str(pipeline_dir / "pipeline.yaml"))
    compose_path = str(pipeline_dir / "docker-compose.yml")
    validate_pipeline(pipeline)

    # Generate docker-compose.yml from pipeline step names
    generate_compose(pipeline, compose_path)

    # Build all images
    print("overnight: building images...")
    result = subprocess.run(
        ["docker", "compose", "-f", compose_path, "build"],
        env={**os.environ, "WORKSPACE": workspace},
    )
    if result.returncode != 0:
        print("error: docker compose build failed", file=sys.stderr)
        sys.exit(1)

    print(f"overnight: pipeline '{pipeline.name}' with {len(pipeline.steps)} steps")
    print(f"overnight: workspace={workspace}")
    print(f"overnight: dir={pipeline_dir}")
    print(f"overnight: stop with: touch {pipeline_dir}/STOP")
    print()

    prev_checkpoint_content = ""
    i = 0

    while i < len(pipeline.steps):
        if (pipeline_dir / "STOP").exists():
            print("overnight: stopped")
            return

        step = pipeline.steps[i]
        next_step = pipeline.steps[i + 1] if i + 1 < len(pipeline.steps) else None
        is_paired = next_step is not None and next_step.role == "skeptic"

        print(f"\n{'=' * 60}")
        print(f"overnight: step '{step.name}'" +
              (f" + '{next_step.name}'" if is_paired else ""))
        print(f"{'=' * 60}")

        # First GP run
        pre_gp_commit = get_commit_hash(workspace)
        cp_filename = make_checkpoint_filename(step.name, 1)
        prompt = make_gp_prompt(
            step, workspace, pipeline_dir_str, prev_checkpoint_content, cp_filename, 1,
        )

        print(f"\n=== {step.name} round 1 (gp) ===")
        gp_path, exit_code = run_round(
            step, workspace, pipeline_dir_str, prompt, cp_filename, 1, compose_path,
        )
        print(f"=== round complete (exit={exit_code}) ===")
        commit_round(workspace, step.name, 1, pipeline_dir_str)

        gp_status = parse_checkpoint(gp_path)["status"]
        if gp_status == FAILED:
            print(f"overnight: step '{step.name}' failed", file=sys.stderr)
            sys.exit(1)

        # Standalone GP (no skeptic following)
        if not is_paired:
            if gp_status == COMPLETE:
                prev_checkpoint_content = read_file(gp_path)
                print(f"overnight: step '{step.name}' complete")
                i += 1
                continue

            # Standalone GP with IN_PROGRESS: loop within its own max_rounds
            gp_content = read_file(gp_path)
            for rnd in range(2, step.max_rounds + 1):
                if (pipeline_dir / "STOP").exists():
                    return

                wait = pipeline.defaults.get("wait", DEFAULTS["wait"])
                print(f"overnight: waiting {wait}s")
                time.sleep(wait)

                cp_filename = make_checkpoint_filename(step.name, rnd)
                prompt = make_gp_prompt(
                    step, workspace, pipeline_dir_str, gp_content, cp_filename, rnd,
                )

                print(f"\n=== {step.name} round {rnd} (gp) ===")
                gp_path, exit_code = run_round(
                    step, workspace, pipeline_dir_str, prompt,
                    cp_filename, rnd, compose_path,
                )
                print(f"=== round complete (exit={exit_code}) ===")
                commit_round(workspace, step.name, rnd, pipeline_dir_str)

                gp_status = parse_checkpoint(gp_path)["status"]
                gp_content = read_file(gp_path)

                if gp_status == COMPLETE:
                    prev_checkpoint_content = gp_content
                    print(f"overnight: step '{step.name}' complete")
                    break
                if gp_status == FAILED:
                    print(f"overnight: step '{step.name}' failed", file=sys.stderr)
                    sys.exit(1)
            else:
                print(f"overnight: step '{step.name}' reached max rounds "
                      f"({step.max_rounds})", file=sys.stderr)
                sys.exit(1)

            i += 1
            continue

        # Paired: GP-skeptic loop
        gp_content = read_file(gp_path)
        max_iter = next_step.max_rounds or pipeline.defaults.get(
            "max_rounds", DEFAULTS["max_rounds"],
        )

        for iteration in range(max_iter):
            if (pipeline_dir / "STOP").exists():
                return

            # Skeptic reviews
            git_diff = get_diff_since(workspace, pre_gp_commit)

            # Run verify_cmd if present: execute script, include output
            verify_output = ""
            if next_step.verify_cmd:
                print(f"overnight: running verify_cmd for '{next_step.name}'")
                verify_output, verify_exit = run_verify_cmd(
                    next_step, workspace, compose_path,
                )
                print(f"overnight: verify_cmd exit={verify_exit}")
                git_diff = (
                    f"## Verification Script Output (exit code {verify_exit})\n"
                    f"```\n{verify_output.strip()}\n```\n\n"
                    f"## Git Diff\n{git_diff}"
                )

            cp_filename = make_checkpoint_filename(next_step.name, iteration + 1)
            prompt = make_skeptic_prompt(
                next_step, workspace, pipeline_dir_str, gp_content, git_diff,
                cp_filename, iteration + 1,
            )

            print(f"\n=== {next_step.name} round {iteration + 1} (skeptic) ===")
            skeptic_path, exit_code = run_round(
                next_step, workspace, pipeline_dir_str, prompt,
                cp_filename, iteration + 1, compose_path,
            )
            print(f"=== round complete (exit={exit_code}) ===")

            skeptic_status = parse_checkpoint(skeptic_path)["status"]

            if skeptic_status == COMPLETE:
                skeptic_content = read_file(skeptic_path)
                prev_checkpoint_content = (
                    "## Previous Work\n" + gp_content +
                    "\n\n## Review Verdict\n" + skeptic_content
                )
                print(f"overnight: pair '{step.name}'/'{next_step.name}' complete")
                i += 2
                break

            if skeptic_status == FAILED:
                print(f"overnight: '{next_step.name}' failed", file=sys.stderr)
                sys.exit(1)

            # IN_PROGRESS: loop back to GP with feedback
            skeptic_content = read_file(skeptic_path)
            pre_gp_commit = get_commit_hash(workspace)

            wait = pipeline.defaults.get("wait", DEFAULTS["wait"])
            print(f"overnight: waiting {wait}s")
            time.sleep(wait)

            cp_filename = make_checkpoint_filename(step.name, iteration + 2)
            prompt = make_gp_after_skeptic_prompt(
                step, workspace, pipeline_dir_str, gp_content, skeptic_content,
                cp_filename, iteration + 2,
            )

            print(f"\n=== {step.name} round {iteration + 2} (gp, addressing feedback) ===")
            gp_path, exit_code = run_round(
                step, workspace, pipeline_dir_str, prompt,
                cp_filename, iteration + 2, compose_path,
            )
            print(f"=== round complete (exit={exit_code}) ===")
            commit_round(workspace, step.name, iteration + 2, pipeline_dir_str)

            gp_status = parse_checkpoint(gp_path)["status"]
            if gp_status == FAILED:
                print(f"overnight: step '{step.name}' failed", file=sys.stderr)
                sys.exit(1)

            gp_content = read_file(gp_path)
        else:
            print(f"overnight: pair '{step.name}'/'{next_step.name}' "
                  f"reached max iterations ({max_iter})", file=sys.stderr)
            sys.exit(1)

    print(f"\novernight: pipeline '{pipeline.name}' complete")


# ---------------------------------------------------------------------------
# Section 8: CLI
# ---------------------------------------------------------------------------

def main():
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    parser = argparse.ArgumentParser(description="Overnight pipeline runner v2")
    parser.add_argument("--workspace", required=True, help="Repo directory")
    parser.add_argument("--dir", required=True,
                        help="Pipeline directory (contains pipeline.yaml, docker-compose.yml)")
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace)
    pipeline_dir = os.path.abspath(args.dir)

    if not os.path.isdir(workspace):
        print(f"error: workspace not found: {workspace}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isdir(pipeline_dir):
        print(f"error: pipeline directory not found: {pipeline_dir}", file=sys.stderr)
        sys.exit(1)

    pipeline_yaml = os.path.join(pipeline_dir, "pipeline.yaml")
    if not os.path.isfile(pipeline_yaml):
        print(f"error: pipeline.yaml not found: {pipeline_yaml}", file=sys.stderr)
        sys.exit(1)

    run_pipeline(workspace, pipeline_dir)


if __name__ == "__main__":
    main()
