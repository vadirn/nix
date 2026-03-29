#!/usr/bin/env python3
"""Smoke tests for overnight pipeline runner v2.

Run: uv run --with pyyaml python3 home/claude/skills/overnight/test_run.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import run


def test_load_pipeline_minimal():
    """Minimal valid pipeline."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: test
steps:
  - name: hello
    prompt: "Say hello"
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.name == "test"
        assert p.skills == []
        assert len(p.steps) == 1
        assert p.steps[0].name == "hello"
        assert p.steps[0].prompt == "Say hello"
        assert p.steps[0].role == "gp"
        assert p.steps[0].model == "claude-opus-4-6[1m]"
        assert p.steps[0].max_rounds == 5
        os.unlink(f.name)
    print("  PASS test_load_pipeline_minimal")


def test_load_pipeline_full():
    """Pipeline with all fields."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: full-test
skills: [tdd, probe]
defaults:
  model: claude-sonnet-4-6
  max_rounds: 10
  wait: 5
steps:
  - name: implement
    prompt: "Write code"
  - name: review
    prompt: "Review the code"
    role: skeptic
    model: claude-opus-4-6[1m]
    max_rounds: 3
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.name == "full-test"
        assert p.skills == ["tdd", "probe"]
        assert p.defaults["model"] == "claude-sonnet-4-6"
        assert p.defaults["wait"] == 5

        s0 = p.steps[0]
        assert s0.name == "implement"
        assert s0.role == "gp"
        assert s0.model == "claude-sonnet-4-6"
        assert s0.max_rounds == 10

        s1 = p.steps[1]
        assert s1.name == "review"
        assert s1.role == "skeptic"
        assert s1.model == "claude-opus-4-6[1m]"
        assert s1.max_rounds == 3
        os.unlink(f.name)
    print("  PASS test_load_pipeline_full")


def test_validate_pipeline_valid():
    """Valid pipeline passes validation."""
    pipeline = run.PipelineConfig(
        name="test",
        steps=[
            run.StepConfig(name="work", prompt="do it", role="gp"),
            run.StepConfig(name="review", prompt="check it", role="skeptic"),
            run.StepConfig(name="more-work", prompt="do more", role="gp"),
        ],
    )
    run.validate_pipeline(pipeline)  # should not raise
    print("  PASS test_validate_pipeline_valid")


def test_validate_pipeline_skeptic_first():
    """Skeptic as first step is rejected."""
    pipeline = run.PipelineConfig(
        name="test",
        steps=[
            run.StepConfig(name="review", prompt="check", role="skeptic"),
        ],
    )
    try:
        run.validate_pipeline(pipeline)
        assert False, "should have exited"
    except SystemExit:
        pass
    print("  PASS test_validate_pipeline_skeptic_first")


def test_validate_pipeline_consecutive_skeptics():
    """Two consecutive skeptics is rejected."""
    pipeline = run.PipelineConfig(
        name="test",
        steps=[
            run.StepConfig(name="work", prompt="do", role="gp"),
            run.StepConfig(name="r1", prompt="check", role="skeptic"),
            run.StepConfig(name="r2", prompt="check again", role="skeptic"),
        ],
    )
    try:
        run.validate_pipeline(pipeline)
        assert False, "should have exited"
    except SystemExit:
        pass
    print("  PASS test_validate_pipeline_consecutive_skeptics")


def test_validate_pipeline_invalid_role():
    """Invalid role is rejected."""
    pipeline = run.PipelineConfig(
        name="test",
        steps=[
            run.StepConfig(name="work", prompt="do", role="worker"),
        ],
    )
    try:
        run.validate_pipeline(pipeline)
        assert False, "should have exited"
    except SystemExit:
        pass
    print("  PASS test_validate_pipeline_invalid_role")


def test_parse_checkpoint_valid():
    """Valid checkpoint with frontmatter."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_COMPLETE
step: analyze
round: 2
---

## Done
Analyzed all files.
""")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_COMPLETE"
        assert result["step"] == "analyze"
        assert result["round"] == 2
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_valid")


def test_parse_checkpoint_in_progress():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_IN_PROGRESS
step: implement
round: 1
---

## Done
Started work.

## Next
- Finish endpoint.
""")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_in_progress")


def test_parse_checkpoint_failed():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_FAILED
step: test
round: 1
---

## Frictions
Cannot connect to database.
""")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_FAILED"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_failed")


def test_parse_checkpoint_missing_file():
    result = run.parse_checkpoint("/nonexistent/path.md")
    assert result["status"] == "STEP_IN_PROGRESS"
    print("  PASS test_parse_checkpoint_missing_file")


def test_parse_checkpoint_no_frontmatter():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("# Just a regular markdown file\n\nNo frontmatter here.\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_no_frontmatter")


def test_parse_checkpoint_invalid_status():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("---\nstatus: BOGUS_VALUE\n---\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_invalid_status")


def test_parse_checkpoint_malformed_yaml():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("---\nstatus: [broken\n---\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_malformed_yaml")


def test_gp_template():
    """GP prompt template renders correctly."""
    step = run.StepConfig(name="impl", prompt="Fix the auth module.")
    result = run.make_gp_prompt(
        step, "/tmp/pipeline", "## Done\nAnalyzed files.\n",
        "checkpoint-001.md", 3,
    )
    assert "impl" in result
    assert "round 3" in result
    assert "Fix the auth module." in result
    assert "Analyzed files." in result
    assert "checkpoint-001.md" in result
    assert "/tmp/pipeline" in result
    print("  PASS test_gp_template")


def test_gp_after_skeptic_template():
    """GP-after-skeptic template includes both checkpoints."""
    step = run.StepConfig(name="impl", prompt="Fix auth.")
    result = run.make_gp_after_skeptic_prompt(
        step, "/tmp/pipeline",
        "## Done\nWrote JWT code.",
        "## Feedback\nMissing token refresh.",
        "checkpoint-002.md", 4,
    )
    assert "Wrote JWT code." in result
    assert "Missing token refresh." in result
    assert "Your Previous Checkpoint" in result
    assert "Reviewer Feedback" in result
    print("  PASS test_gp_after_skeptic_template")


def test_skeptic_template():
    """Skeptic template includes diff and GP checkpoint."""
    step = run.StepConfig(name="review", prompt="Check for hardcoded secrets.", role="skeptic")
    result = run.make_skeptic_prompt(
        step, "/tmp/pipeline",
        "## Done\nImplemented JWT.",
        "diff --git a/auth.py b/auth.py\n+SECRET='abc'",
        "checkpoint-003.md", 1,
    )
    assert "Check for hardcoded secrets." in result
    assert "Implemented JWT." in result
    assert "SECRET='abc'" in result
    assert "Review Criteria" in result
    assert "Changes Made" in result
    print("  PASS test_skeptic_template")


def test_read_file_missing():
    """read_file returns empty string for missing files."""
    assert run.read_file("/nonexistent/file.md") == ""
    print("  PASS test_read_file_missing")


def test_read_file_exists():
    """read_file returns content for existing files."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("hello world")
        f.flush()
        assert run.read_file(f.name) == "hello world"
        os.unlink(f.name)
    print("  PASS test_read_file_exists")


def test_make_checkpoint_filename():
    """Checkpoint filename includes step name and round."""
    name = run.make_checkpoint_filename("impl", 3)
    assert name.startswith("checkpoint-impl-")
    assert name.endswith("-003.md")
    print("  PASS test_make_checkpoint_filename")


if __name__ == "__main__":
    old_stderr = sys.stderr
    sys.stderr = open(os.devnull, "w")

    print("Running overnight v2 smoke tests...\n")

    tests = [
        test_load_pipeline_minimal,
        test_load_pipeline_full,
        test_validate_pipeline_valid,
        test_validate_pipeline_skeptic_first,
        test_validate_pipeline_consecutive_skeptics,
        test_validate_pipeline_invalid_role,
        test_parse_checkpoint_valid,
        test_parse_checkpoint_in_progress,
        test_parse_checkpoint_failed,
        test_parse_checkpoint_missing_file,
        test_parse_checkpoint_no_frontmatter,
        test_parse_checkpoint_invalid_status,
        test_parse_checkpoint_malformed_yaml,
        test_gp_template,
        test_gp_after_skeptic_template,
        test_skeptic_template,
        test_read_file_missing,
        test_read_file_exists,
        test_make_checkpoint_filename,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            sys.stderr = old_stderr
            print(f"  FAIL {test.__name__}: {e}")
            sys.stderr = open(os.devnull, "w")
            failed += 1

    sys.stderr = old_stderr
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
