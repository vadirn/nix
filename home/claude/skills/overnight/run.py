#!/usr/bin/env python3
"""Overnight pipeline runner.

Invoked via: uv run --with pyyaml run.py --workspace DIR

Orchestrates autonomous Claude Code sessions in Docker. Reads a pipeline.yaml
defining steps, runs each step as a series of rounds (claude -p invocations)
inside Docker containers, and manages checkpoints between rounds.
"""

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

# ---------------------------------------------------------------------------
# Section 1: Data model
# ---------------------------------------------------------------------------

DEFAULTS = {
    "model": "claude-opus-4-6[1m]",
    "image": "claude-runner",
    "max_rounds": 50,
    "wait": 30,
    "resolve_questions": True,
    "explore_model": "claude-haiku-4-5",
}


@dataclass
class StepConfig:
    name: str
    prompt: str
    accept: str = ""
    skills: list[str] = field(default_factory=list)
    agent: str = ""
    image: str = ""
    model: str = ""
    max_rounds: int = 0
    on_fail: str = "stop"
    max_retries: int = 0
    resolve_questions: bool = True
    verify: str = ""


@dataclass
class PipelineConfig:
    name: str
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

        step = StepConfig(
            name=s["name"],
            prompt=s["prompt"],
            accept=s.get("accept", ""),
            skills=s.get("skills", []),
            agent=s.get("agent", ""),
            image=s.get("image", defaults["image"]),
            model=s.get("model", defaults["model"]),
            max_rounds=s.get("max_rounds", defaults["max_rounds"]),
            on_fail=s.get("on_fail", "stop"),
            max_retries=s.get("max_retries", 0),
            resolve_questions=s.get("resolve_questions", defaults["resolve_questions"]),
            verify=s.get("verify", ""),
        )
        steps.append(step)

    return PipelineConfig(
        name=raw.get("name", "overnight"),
        defaults=defaults,
        steps=steps,
    )


# ---------------------------------------------------------------------------
# Section 2: Round execution
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE = """\
You are running as an autonomous agent.
Step: "{step_name}", round {round_number}.

## Task
{prompt}

## Acceptance Criteria
{accept}

## Previous Checkpoint
{prev_checkpoint}

## Instructions
- Read the codebase using git log, git diff, git status, and file reads.
- Write your checkpoint to .overnight/{checkpoint_filename} before finishing.
- Set status to STEP_COMPLETE when all acceptance criteria are met.
- Set status to STEP_IN_PROGRESS with clear ## Next items when work remains.
- Set status to STEP_FAILED when the task is blocked and cannot proceed.
- Record unknowns in ## Open questions.
- The orchestrator handles git commits. Focus on code changes and checkpoint.
- Work autonomously."""


def build_skills_dir(
    overnight_skills: Path, step_skills: list[str], tmpdir: str
) -> str:
    """Build a temp directory with checkpoint/ + step's listed skills."""
    skills_dir = os.path.join(tmpdir, "skills")
    os.makedirs(skills_dir)

    # Always include checkpoint skill
    checkpoint_src = overnight_skills / "checkpoint"
    if checkpoint_src.is_dir():
        shutil.copytree(str(checkpoint_src), os.path.join(skills_dir, "checkpoint"))

    # Copy step-specific skills
    for skill_name in step_skills:
        src = overnight_skills / skill_name
        if src.is_dir():
            shutil.copytree(str(src), os.path.join(skills_dir, skill_name))
        else:
            print(f"warning: skill '{skill_name}' not found at {src}", file=sys.stderr)

    return skills_dir


def run_round(
    step: StepConfig,
    workspace: str,
    prev_checkpoint_content: str,
    checkpoint_filename: str,
    round_number: int,
    docker_volume: str,
    overnight_dir: Path,
    tmpdir: str,
) -> tuple[str, int]:
    """Run one claude -p invocation inside Docker. Returns (checkpoint_path, exit_code)."""

    prompt = PROMPT_TEMPLATE.format(
        step_name=step.name,
        round_number=round_number,
        prompt=step.prompt,
        accept=step.accept or "Complete the task described above.",
        prev_checkpoint=prev_checkpoint_content or "First round. No prior state.",
        checkpoint_filename=checkpoint_filename,
    )

    # Build filtered skills directory
    skills_dir = build_skills_dir(
        overnight_dir / "skills", step.skills, tmpdir
    )

    agents_dir = overnight_dir / "agents"

    # Construct docker run command
    container_name = f"overnight-{step.name}-{round_number}"
    cmd = [
        "docker", "run", "--rm",
        "--name", container_name,
        "-v", f"{docker_volume}:/home/claude",
        "-v", f"{workspace}:/workspace",
        "-v", f"{workspace}/.git:/workspace/.git:ro",
        "-v", f"{skills_dir}:/workspace/.claude/skills:ro",
    ]

    if agents_dir.is_dir():
        cmd.extend(["-v", f"{agents_dir}:/workspace/.claude/agents:ro"])

    cmd.extend([
        step.image,
        "-p", prompt,
        "--dangerously-skip-permissions",
        "--model", step.model,
    ])

    if step.agent:
        cmd.extend(["--agent", step.agent])

    # Start container in its own process group so signals don't propagate.
    proc = subprocess.Popen(cmd, start_new_session=True)
    proc.wait()
    checkpoint_path = os.path.join(workspace, ".overnight", checkpoint_filename)

    return checkpoint_path, proc.returncode


# ---------------------------------------------------------------------------
# Section 3: Checkpoint parsing
# ---------------------------------------------------------------------------

def parse_checkpoint(path: str) -> dict:
    """Parse checkpoint YAML frontmatter. Returns dict with at least 'status'."""
    if not os.path.exists(path):
        return {"status": "STEP_IN_PROGRESS"}

    with open(path) as f:
        content = f.read()

    # Extract YAML frontmatter
    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        print("warning: checkpoint has no YAML frontmatter, assuming IN_PROGRESS", file=sys.stderr)
        return {"status": "STEP_IN_PROGRESS"}

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        print(f"warning: failed to parse checkpoint frontmatter: {e}", file=sys.stderr)
        return {"status": "STEP_IN_PROGRESS"}

    if not isinstance(frontmatter, dict) or "status" not in frontmatter:
        print("warning: checkpoint frontmatter missing 'status', assuming IN_PROGRESS", file=sys.stderr)
        return {"status": "STEP_IN_PROGRESS"}

    valid_statuses = {"STEP_COMPLETE", "STEP_IN_PROGRESS", "STEP_FAILED"}
    if frontmatter["status"] not in valid_statuses:
        print(f"warning: unknown status '{frontmatter['status']}', assuming IN_PROGRESS", file=sys.stderr)
        frontmatter["status"] = "STEP_IN_PROGRESS"

    return frontmatter


def has_open_questions(path: str) -> bool:
    """Check if checkpoint has non-empty ## Open questions section."""
    if not os.path.exists(path):
        return False

    with open(path) as f:
        content = f.read()

    match = re.search(r"## Open questions\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if not match:
        return False

    questions = match.group(1).strip()
    # Ignore empty sections or "None" / "N/A" type answers
    if not questions or questions.lower() in ("none", "none.", "n/a", "-"):
        return False

    return True


# ---------------------------------------------------------------------------
# Section 4: Question resolution
# ---------------------------------------------------------------------------

def resolve_questions(
    checkpoint_path: str,
    workspace: str,
    docker_volume: str,
    image: str,
    model: str,
    agents_dir: Path,
) -> None:
    """Spawn resolver agent to answer open questions in the checkpoint."""
    print("overnight: resolving open questions...")

    prompt = (
        f"Read the checkpoint file at /workspace/.overnight/{os.path.basename(checkpoint_path)}. "
        f"Find the ## Open questions section and answer each question. "
        f"Append a ## Answers section to the same file."
    )

    cmd = [
        "docker", "run", "--rm",
        "--name", "overnight-resolver",
        "-v", f"{docker_volume}:/home/claude",
        "-v", f"{workspace}:/workspace:ro",
        # Mount checkpoint read-write so resolver can append answers
        "-v", f"{checkpoint_path}:/workspace/.overnight/{os.path.basename(checkpoint_path)}",
    ]

    if agents_dir.is_dir():
        cmd.extend(["-v", f"{agents_dir}:/workspace/.claude/agents:ro"])

    cmd.extend([
        image,
        "-p", prompt,
        "--dangerously-skip-permissions",
        "--model", model,
        "--agent", "resolver",
    ])

    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"warning: resolver exited with code {result.returncode}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Section 5: Verification
# ---------------------------------------------------------------------------

def run_verify(step: StepConfig, workspace: str) -> bool:
    """Run verify command inside step's Docker image. Returns True if passed."""
    if not step.verify:
        return True

    print(f"overnight: verifying step '{step.name}'...")
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{workspace}:/workspace:ro",
        step.image,
        "sh", "-c", step.verify,
    ]

    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"overnight: verify failed (exit={result.returncode})", file=sys.stderr)
        return False

    print("overnight: verify passed")
    return True


# ---------------------------------------------------------------------------
# Section 6: Git commit (outside Docker)
# ---------------------------------------------------------------------------

def commit_round(workspace: str, timestamp: str) -> None:
    """Commit workspace changes, excluding .overnight/."""
    # Check if there are changes to commit
    result = subprocess.run(
        ["git", "-C", workspace, "status", "--porcelain"],
        capture_output=True, text=True,
    )
    # Filter out .overnight/ changes
    changes = [
        line for line in result.stdout.strip().split("\n")
        if line and not line.lstrip("? MADRC").lstrip().startswith(".overnight/")
    ]

    if not changes:
        return

    subprocess.run(["git", "-C", workspace, "add", "-A", "--", ":!.overnight"])
    subprocess.run(
        ["git", "-C", workspace, "commit", "-m", f"overnight: {timestamp}"],
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Section 7: Step runner
# ---------------------------------------------------------------------------

STOPPED = False


def run_step(
    step: StepConfig,
    workspace: str,
    pipeline: PipelineConfig,
    prev_step_checkpoint: str | None,
    docker_volume: str,
    overnight_dir: Path,
) -> str | None:
    """Run rounds within a step. Returns last checkpoint path, or None on failure."""
    global STOPPED

    prev_checkpoint_content = ""
    if prev_step_checkpoint and os.path.exists(prev_step_checkpoint):
        with open(prev_step_checkpoint) as f:
            prev_checkpoint_content = f.read()

    retries = 0

    for rnd in range(step.max_rounds):
        if STOPPED or os.path.exists(os.path.join(workspace, ".overnight", "STOP")):
            print(f"overnight: stopped during step '{step.name}'")
            return None

        seq = rnd + 1
        timestamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
        checkpoint_filename = f"checkpoint-{timestamp}-{seq:03d}.md"

        print(f"\n=== step '{step.name}', round {seq}/{step.max_rounds} ===")

        with tempfile.TemporaryDirectory() as tmpdir:
            checkpoint_path, exit_code = run_round(
                step=step,
                workspace=workspace,
                prev_checkpoint_content=prev_checkpoint_content,
                checkpoint_filename=checkpoint_filename,
                round_number=seq,
                docker_volume=docker_volume,
                overnight_dir=overnight_dir,
                tmpdir=tmpdir,
            )

        print(f"=== round {seq} complete (exit={exit_code}) ===")

        # Commit workspace changes
        commit_round(workspace, timestamp)

        # Parse checkpoint
        checkpoint = parse_checkpoint(checkpoint_path)
        status = checkpoint["status"]

        # Run verify if configured
        if status == "STEP_COMPLETE" and step.verify:
            if not run_verify(step, workspace):
                status = "STEP_IN_PROGRESS"
                print("overnight: verify failed, overriding status to IN_PROGRESS")

        # Handle status
        if status == "STEP_COMPLETE":
            print(f"overnight: step '{step.name}' complete")
            return checkpoint_path

        elif status == "STEP_FAILED":
            if step.on_fail == "retry" and retries < step.max_retries:
                retries += 1
                print(f"overnight: step failed, retrying ({retries}/{step.max_retries})")
                continue
            else:
                print(f"overnight: step '{step.name}' failed", file=sys.stderr)
                return None

        else:  # STEP_IN_PROGRESS
            # Resolve open questions if enabled
            if step.resolve_questions and has_open_questions(checkpoint_path):
                resolve_questions(
                    checkpoint_path=checkpoint_path,
                    workspace=workspace,
                    docker_volume=docker_volume,
                    image=step.image,
                    model=pipeline.defaults.get("explore_model", DEFAULTS["explore_model"]),
                    agents_dir=overnight_dir / "agents",
                )

            # Update prev checkpoint for next round
            if os.path.exists(checkpoint_path):
                with open(checkpoint_path) as f:
                    prev_checkpoint_content = f.read()

        # Wait between rounds
        wait = pipeline.defaults.get("wait", DEFAULTS["wait"])
        if rnd < step.max_rounds - 1 and not STOPPED:
            print(f"overnight: waiting {wait}s before next round")
            time.sleep(wait)

    print(f"overnight: step '{step.name}' reached max rounds ({step.max_rounds})", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Section 8: Pipeline runner
# ---------------------------------------------------------------------------

def preflight(pipeline: PipelineConfig, workspace: str, docker_volume: str, docker_image: str) -> None:
    """Validate prerequisites before running any steps. Exits on failure."""
    errors: list[str] = []

    # Check Docker volume exists
    result = subprocess.run(
        ["docker", "volume", "inspect", docker_volume],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        errors.append(f"Docker volume '{docker_volume}' not found. Run: docker volume create {docker_volume}")

    # Collect all images needed (resolve defaults and per-step Dockerfiles)
    images_to_check: dict[str, list[str]] = {}  # image -> [step names]
    for step in pipeline.steps:
        image = step.image if step.image != DEFAULTS["image"] else docker_image
        # Check if a per-step Dockerfile would override the image
        dockerfile = os.path.join(workspace, ".overnight", f"Dockerfile.{step.name}")
        if os.path.exists(dockerfile):
            image = f"claude-runner-{step.name}"  # will be built by build_image()
        images_to_check.setdefault(image, []).append(step.name)

    # Check each image exists (skip ones that will be built from Dockerfile.{step})
    for image, step_names in images_to_check.items():
        # If a Dockerfile.{step} exists, it will be built later — skip check
        has_dockerfile = any(
            os.path.exists(os.path.join(workspace, ".overnight", f"Dockerfile.{name}"))
            for name in step_names
        )
        if has_dockerfile:
            continue

        result = subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            errors.append(f"Docker image '{image}' not found (used by steps: {', '.join(step_names)})")

    # Check verify command tools exist in their respective images
    for step in pipeline.steps:
        if not step.verify:
            continue
        image = step.image if step.image != DEFAULTS["image"] else docker_image
        dockerfile = os.path.join(workspace, ".overnight", f"Dockerfile.{step.name}")
        if os.path.exists(dockerfile):
            image = f"claude-runner-{step.name}"
        # Skip tool check if image doesn't exist yet (already reported above)
        img_check = subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if img_check.returncode != 0:
            continue
        # Extract the first command from the verify string
        verify_stripped = step.verify.strip()
        # Handle "cd /workspace && cmd ..." pattern
        if "&&" in verify_stripped:
            verify_stripped = verify_stripped.split("&&")[-1].strip()
        first_word = verify_stripped.split()[0] if verify_stripped else ""
        if first_word:
            result = subprocess.run(
                ["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", f"command -v {first_word}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if result.returncode != 0:
                errors.append(f"Step '{step.name}' verify uses '{first_word}' but it's not in image '{image}'")

    if errors:
        print("overnight: preflight failed:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print("overnight: preflight passed")


def build_image(step: StepConfig, workspace: str) -> None:
    """Build per-step Docker image if Dockerfile.{step.name} exists."""
    dockerfile = os.path.join(workspace, ".overnight", f"Dockerfile.{step.name}")
    if not os.path.exists(dockerfile):
        return

    tag = f"claude-runner-{step.name}"
    print(f"overnight: building image '{tag}' from {dockerfile}")
    subprocess.run(
        ["docker", "build", "-t", tag, "-f", dockerfile, os.path.dirname(dockerfile)],
        check=True,
    )
    step.image = tag


def run_pipeline(
    workspace: str,
    pipeline_path: str,
    docker_volume: str,
    docker_image: str,
) -> None:
    """Load pipeline. Execute steps sequentially."""
    pipeline = load_pipeline(pipeline_path)
    overnight_dir = Path(workspace) / ".overnight"

    # Ensure .overnight directory exists
    overnight_dir.mkdir(exist_ok=True)

    # Validate prerequisites before starting
    preflight(pipeline, workspace, docker_volume, docker_image)

    print(f"overnight: pipeline '{pipeline.name}' with {len(pipeline.steps)} steps")
    print(f"overnight: workspace={workspace}")
    print(f"overnight: stop with: touch {overnight_dir}/STOP")
    print()

    prev_step_checkpoint = None

    for i, step in enumerate(pipeline.steps):
        if STOPPED:
            break

        # Override default image if not set per-step
        if step.image == DEFAULTS["image"]:
            step.image = docker_image

        # Build per-step image if Dockerfile exists
        build_image(step, workspace)

        print(f"\n{'='*60}")
        print(f"overnight: starting step {i+1}/{len(pipeline.steps)}: '{step.name}'")
        print(f"{'='*60}")

        result = run_step(
            step=step,
            workspace=workspace,
            pipeline=pipeline,
            prev_step_checkpoint=prev_step_checkpoint,
            docker_volume=docker_volume,
            overnight_dir=overnight_dir,
        )

        if result is None:
            print(f"\novernight: pipeline aborted at step '{step.name}'", file=sys.stderr)
            sys.exit(1)

        prev_step_checkpoint = result

    print(f"\novernight: pipeline '{pipeline.name}' complete")


# ---------------------------------------------------------------------------
# Section 9: CLI
# ---------------------------------------------------------------------------

def main():
    global STOPPED

    parser = argparse.ArgumentParser(description="Overnight pipeline runner")
    parser.add_argument("--workspace", required=True, help="Repo directory")
    parser.add_argument("--pipeline", default=None, help="Pipeline YAML (default: .overnight/pipeline.yaml)")
    parser.add_argument("--docker-volume", default="claude-runner-home", help="Named volume for /home/claude")
    parser.add_argument("--docker-image", default="claude-runner", help="Base Docker image")
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace)
    pipeline_path = args.pipeline or os.path.join(workspace, ".overnight", "pipeline.yaml")

    if not os.path.isdir(workspace):
        print(f"error: workspace not found: {workspace}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(pipeline_path):
        print(f"error: pipeline not found: {pipeline_path}", file=sys.stderr)
        sys.exit(1)

    # Ignore signals. The stop file (.overnight/STOP) is the only control mechanism.
    # The runner is launched from Claude Code, not a terminal.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    run_pipeline(workspace, pipeline_path, args.docker_volume, args.docker_image)


if __name__ == "__main__":
    main()
