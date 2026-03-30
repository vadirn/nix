#!/usr/bin/env python3
"""Overnight pipeline runner.

Invoked via: uv run --with pyyaml run.py --workspace DIR --dir DIR

Each step is a GP-skeptic pair. GP does work, skeptic reviews it.
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
from string import Template

import yaml

# ---------------------------------------------------------------------------
# Data model
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
    review: str
    model: str = ""
    review_model: str = ""
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
        if "name" not in s or "prompt" not in s or "review" not in s:
            print(f"error: step {i} must have 'name', 'prompt', and 'review'",
                  file=sys.stderr)
            sys.exit(1)

        default_model = defaults["model"]
        step = StepConfig(
            name=s["name"],
            prompt=s["prompt"],
            review=s["review"],
            model=s.get("model", default_model),
            review_model=s.get("review_model", s.get("model", default_model)),
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


# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

GP_TEMPLATE = """\
You are an autonomous agent.
Step: "{step_name}", round {round_number}.

## Task
{prompt}

## Previous State
{prev_state_ref}

## Instructions
- Work autonomously. Write checkpoint to {checkpoint_path}.
- Always set status STEP_IN_PROGRESS. The reviewer decides completion.
- If you read ## Feedback in the review file, address each item before proceeding.
- The orchestrator handles git commits. Focus on code changes and checkpoint.

{checkpoint_format}"""

SKEPTIC_TEMPLATE = """\
You are a reviewer.
Step: "{step_name}", round {round_number}.

## Review Criteria
{prompt}

{verify_output}

## Instructions
- Read the GP's checkpoint at {checkpoint_path}.
- Write your review to {review_path}.
- Include ## Feedback with specific, actionable items.
- Set STEP_COMPLETE if work meets criteria.
- Set STEP_IN_PROGRESS with concrete feedback if revisions needed.
- Set STEP_FAILED if unrecoverable issues.
- Be concrete: name files, functions, specific issues.

{checkpoint_format}"""


# ---------------------------------------------------------------------------
# Checkpoint parsing
# ---------------------------------------------------------------------------

def parse_checkpoint(path: str) -> dict:
    """Parse checkpoint YAML frontmatter. Returns dict with at least 'status'."""
    if not os.path.exists(path):
        return {"status": IN_PROGRESS}

    with open(path) as f:
        content = f.read()

    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        print("warning: checkpoint has no YAML frontmatter, assuming IN_PROGRESS",
              file=sys.stderr)
        return {"status": IN_PROGRESS}

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        print(f"warning: failed to parse checkpoint frontmatter: {e}",
              file=sys.stderr)
        return {"status": IN_PROGRESS}

    if not isinstance(frontmatter, dict) or "status" not in frontmatter:
        print("warning: checkpoint frontmatter missing 'status', assuming IN_PROGRESS",
              file=sys.stderr)
        return {"status": IN_PROGRESS}

    valid_statuses = {COMPLETE, IN_PROGRESS, FAILED}
    if frontmatter["status"] not in valid_statuses:
        print(f"warning: unknown status '{frontmatter['status']}', assuming IN_PROGRESS",
              file=sys.stderr)
        frontmatter["status"] = IN_PROGRESS

    return frontmatter


def read_file(path: str) -> str:
    """Read file contents or return empty string if missing."""
    if not os.path.exists(path):
        return ""
    with open(path) as f:
        return f.read()


# ---------------------------------------------------------------------------
# Round execution
# ---------------------------------------------------------------------------

def run_round(
    step_name: str,
    model: str,
    role: str,
    workspace: str,
    pipeline_dir: str,
    prompt: str,
    round_number: int,
    compose_path: str,
) -> int:
    """Run one claude -p invocation via docker compose. Returns exit_code."""
    prompt_filename = f"prompt-{step_name}-{role}-{round_number}.md"
    prompt_path = os.path.join(pipeline_dir, prompt_filename)
    with open(prompt_path, "w") as f:
        f.write(prompt)

    container_name = f"overnight-{step_name}-{role}"
    cmd = [
        "docker", "compose", "-f", compose_path,
        "run", "--rm", "--name", container_name,
        step_name,
        "-p", f"Follow the instructions in /workspace/{os.path.relpath(prompt_path, workspace)}",
        "--dangerously-skip-permissions",
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
    ]

    log_path = os.path.join(pipeline_dir, "tool-calls.jsonl")
    with open(log_path, "a") as log_file:
        marker = json.dumps({
            "type": "round_start",
            "step": step_name,
            "round": round_number,
            "role": role,
            "ts": datetime.now().isoformat(),
        })
        log_file.write(marker + "\n")
        log_file.flush()
        proc = subprocess.Popen(
            cmd, stdout=log_file, start_new_session=True,
            env={**os.environ, "WORKSPACE": workspace},
        )
        proc.wait()

    try:
        os.unlink(prompt_path)
    except OSError:
        pass

    return proc.returncode


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

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

    rel_dir = os.path.relpath(pipeline_dir, workspace)
    excludes = [
        f":!{rel_dir}/checkpoint-*.md",
        f":!{rel_dir}/review-*.md",
        f":!{rel_dir}/tool-calls.jsonl",
        f":!{rel_dir}/prompt-*.md",
        f":!{rel_dir}/STOP",
        f":!{rel_dir}/skills",
    ]

    subprocess.run(
        ["git", "-C", workspace, "add", "-A", "--"] + excludes,
        capture_output=True,
    )

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
# Prompt builders
# ---------------------------------------------------------------------------

def run_verify_cmd(
    step_name: str,
    verify_cmd: str,
    workspace: str,
    compose_path: str,
) -> tuple[str, int]:
    """Run verify_cmd inside Docker and return (stdout, exit_code)."""
    cmd = [
        "docker", "compose", "-f", compose_path,
        "run", "--rm", step_name,
        "bash", "-c", verify_cmd,
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        env={**os.environ, "WORKSPACE": workspace},
    )
    return result.stdout + result.stderr, result.returncode


def docker_path(workspace: str, pipeline_dir: str, filename: str) -> str:
    """Compute a file path as seen inside Docker (/workspace/...)."""
    rel = os.path.relpath(os.path.join(pipeline_dir, filename), workspace)
    return f"/workspace/{rel}"


def make_gp_prompt(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    prev_cp: str,
    prev_review: str,
    checkpoint_filename: str,
    round_number: int,
    checkpoint_format: str,
) -> str:
    if prev_cp:
        lines = [f"Read your previous checkpoint at {docker_path(workspace, pipeline_dir, prev_cp)}."]
        if prev_review:
            lines.append(f"Read the reviewer's feedback at {docker_path(workspace, pipeline_dir, prev_review)}.")
        ref = "\n".join(lines)
    else:
        ref = "First round. No prior state."

    return GP_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.prompt,
        prev_state_ref=ref,
        checkpoint_path=docker_path(workspace, pipeline_dir, checkpoint_filename),
        checkpoint_format=checkpoint_format,
    )


def make_skeptic_prompt(
    step: StepConfig,
    workspace: str,
    pipeline_dir: str,
    verify_output: str,
    checkpoint_filename: str,
    review_filename: str,
    round_number: int,
    checkpoint_format: str,
) -> str:
    return SKEPTIC_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.review,
        verify_output=verify_output,
        checkpoint_path=docker_path(workspace, pipeline_dir, checkpoint_filename),
        review_path=docker_path(workspace, pipeline_dir, review_filename),
        checkpoint_format=checkpoint_format,
    )


# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------

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


def run_pipeline(workspace: str, pipeline_dir: str) -> None:
    """Execute pipeline steps. Each step is a GP-skeptic pair."""
    pipeline = load_pipeline(os.path.join(pipeline_dir, "pipeline.yaml"))
    compose_path = os.path.join(pipeline_dir, "docker-compose.yml")
    generate_compose(pipeline, compose_path)

    # Load external checkpoint format
    checkpoint_format_path = os.path.join(
        os.path.dirname(__file__), "checkpoint.md",
    )
    checkpoint_format = read_file(checkpoint_format_path)
    if not checkpoint_format:
        print("error: checkpoint.md not found", file=sys.stderr)
        sys.exit(1)

    # Build images
    print("overnight: building images...")
    result = subprocess.run(
        ["docker", "compose", "-f", compose_path, "build"],
        env={**os.environ, "WORKSPACE": workspace},
    )
    if result.returncode != 0:
        print("error: docker compose build failed", file=sys.stderr)
        sys.exit(1)

    print(f"overnight: pipeline '{pipeline.name}' — {len(pipeline.steps)} steps")
    print(f"overnight: workspace={workspace}")
    print(f"overnight: dir={pipeline_dir}")
    print(f"overnight: stop with: touch {pipeline_dir}/STOP")
    print()

    stop_path = os.path.join(pipeline_dir, "STOP")
    seq = 0
    prev_cp = ""
    prev_review = ""

    for step in pipeline.steps:
        print(f"\n{'=' * 60}")
        print(f"overnight: step '{step.name}'")
        print(f"{'=' * 60}")

        for rnd in range(1, step.max_rounds + 1):
            if os.path.exists(stop_path):
                print("overnight: stopped")
                return

            # --- GP round ---
            seq += 1
            cp_file = f"checkpoint-{seq:03d}.md"
            rv_file = f"review-{seq:03d}.md"
            cp_path = os.path.join(pipeline_dir, cp_file)
            rv_path = os.path.join(pipeline_dir, rv_file)

            prompt = make_gp_prompt(
                step, workspace, pipeline_dir, prev_cp, prev_review,
                cp_file, rnd, checkpoint_format,
            )

            print(f"\n=== {step.name} round {rnd} (gp) ===")
            exit_code = run_round(
                step.name, step.model, "gp",
                workspace, pipeline_dir, prompt,
                rnd, compose_path,
            )
            print(f"=== gp complete (exit={exit_code}) ===")
            commit_round(workspace, step.name, rnd, pipeline_dir)

            if not os.path.exists(cp_path):
                print(f"overnight: '{step.name}' gp produced no checkpoint "
                      f"(exit={exit_code})", file=sys.stderr)
                sys.exit(1)

            if os.path.exists(stop_path):
                print("overnight: stopped")
                return

            # --- Skeptic round ---
            verify_output = ""
            if step.verify_cmd:
                print(f"overnight: running verify_cmd for '{step.name}'")
                output, verify_exit = run_verify_cmd(
                    step.name, step.verify_cmd, workspace, compose_path,
                )
                print(f"overnight: verify_cmd exit={verify_exit}")
                verify_output = (
                    f"## Verification Output (exit {verify_exit})\n"
                    f"```\n{output.strip()}\n```\n"
                )

            prompt = make_skeptic_prompt(
                step, workspace, pipeline_dir, verify_output,
                cp_file, rv_file, rnd, checkpoint_format,
            )

            print(f"\n=== {step.name} round {rnd} (skeptic) ===")
            exit_code = run_round(
                step.name, step.review_model, "skeptic",
                workspace, pipeline_dir, prompt,
                rnd, compose_path,
            )
            print(f"=== skeptic complete (exit={exit_code}) ===")
            commit_round(workspace, step.name, rnd, pipeline_dir)

            # Skeptic crash: no review file → treat as IN_PROGRESS
            if not os.path.exists(rv_path):
                print(f"warning: skeptic produced no review (exit={exit_code}), "
                      f"retrying", file=sys.stderr)
                prev_cp = cp_file
                prev_review = ""
                wait = pipeline.defaults.get("wait", DEFAULTS["wait"])
                print(f"overnight: waiting {wait}s")
                time.sleep(wait)
                continue

            status = parse_checkpoint(rv_path)["status"]
            prev_cp = cp_file
            prev_review = rv_file

            if status == COMPLETE:
                print(f"overnight: step '{step.name}' complete")
                break
            if status == FAILED:
                print(f"overnight: step '{step.name}' failed", file=sys.stderr)
                sys.exit(1)

            # IN_PROGRESS: loop back
            wait = pipeline.defaults.get("wait", DEFAULTS["wait"])
            print(f"overnight: waiting {wait}s")
            time.sleep(wait)
        else:
            print(f"overnight: step '{step.name}' reached max rounds "
                  f"({step.max_rounds})", file=sys.stderr)
            sys.exit(1)

    print(f"\novernight: pipeline '{pipeline.name}' complete")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    parser = argparse.ArgumentParser(description="Overnight pipeline runner")
    parser.add_argument("--workspace", required=True, help="Repo directory")
    parser.add_argument("--dir", required=True,
                        help="Pipeline directory (contains pipeline.yaml)")
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace)
    pipeline_dir = os.path.abspath(args.dir)

    if not os.path.isdir(workspace):
        print(f"error: workspace not found: {workspace}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isdir(pipeline_dir):
        print(f"error: pipeline directory not found: {pipeline_dir}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(os.path.join(pipeline_dir, "pipeline.yaml")):
        print(f"error: pipeline.yaml not found in {pipeline_dir}", file=sys.stderr)
        sys.exit(1)

    run_pipeline(workspace, pipeline_dir)


if __name__ == "__main__":
    main()
