#!/usr/bin/env python3
"""Smoke tests for overnight pipeline runner.

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
    review: "Check greeting"
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.name == "test"
        assert p.skills == []
        assert len(p.steps) == 1
        assert p.steps[0].name == "hello"
        assert p.steps[0].prompt == "Say hello"
        assert p.steps[0].review == "Check greeting"
        assert p.steps[0].model == "claude-opus-4-6[1m]"
        assert p.steps[0].review_model == "claude-opus-4-6[1m]"
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
    review: "Review the code"
    model: claude-opus-4-6[1m]
    review_model: claude-sonnet-4-6
    max_rounds: 3
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.name == "full-test"
        assert p.skills == ["tdd", "probe"]
        assert p.defaults["model"] == "claude-sonnet-4-6"
        assert p.defaults["wait"] == 5

        s = p.steps[0]
        assert s.name == "implement"
        assert s.prompt == "Write code"
        assert s.review == "Review the code"
        assert s.model == "claude-opus-4-6[1m]"
        assert s.review_model == "claude-sonnet-4-6"
        assert s.max_rounds == 3
        os.unlink(f.name)
    print("  PASS test_load_pipeline_full")


def test_load_pipeline_missing_review():
    """Step missing review field is rejected."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: test
steps:
  - name: hello
    prompt: "Say hello"
""")
        f.flush()
        try:
            run.load_pipeline(f.name)
            assert False, "should have exited"
        except SystemExit:
            pass
        os.unlink(f.name)
    print("  PASS test_load_pipeline_missing_review")


def test_load_pipeline_default_models():
    """Both model and review_model default from pipeline defaults."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: test
defaults:
  model: claude-sonnet-4-6
steps:
  - name: work
    prompt: "do"
    review: "check"
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.steps[0].model == "claude-sonnet-4-6"
        assert p.steps[0].review_model == "claude-sonnet-4-6"
        os.unlink(f.name)
    print("  PASS test_load_pipeline_default_models")


def test_load_pipeline_review_model_inherits_model():
    """review_model defaults to step model when not specified."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: test
steps:
  - name: work
    prompt: "do"
    review: "check"
    model: claude-opus-4-6[1m]
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.steps[0].model == "claude-opus-4-6[1m]"
        assert p.steps[0].review_model == "claude-opus-4-6[1m]"
        os.unlink(f.name)
    print("  PASS test_load_pipeline_review_model_inherits_model")


def test_parse_checkpoint_valid():
    """Valid checkpoint with frontmatter."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_COMPLETE
step: analyze
round: 2
---

## Feedback
Looks good.
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

## Feedback
- Missing token refresh.
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

## Feedback
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


def test_gp_template_with_prev():
    """GP prompt references both previous checkpoint and review."""
    step = run.StepConfig(name="impl", prompt="Fix auth.", review="Check auth.")
    result = run.make_gp_prompt(
        step, "/workspace", "/workspace/pipelines/test",
        "checkpoint-001.md", "review-001.md",
        "checkpoint-002.md", 2, "## Checkpoint format\n...",
    )
    assert "impl" in result
    assert "round 2" in result
    assert "Fix auth." in result
    assert "checkpoint-001.md" in result
    assert "review-001.md" in result
    assert "checkpoint-002.md" in result
    assert "Read your previous checkpoint" in result
    assert "reviewer's feedback" in result
    print("  PASS test_gp_template_with_prev")


def test_gp_template_first_round():
    """GP prompt with no previous state."""
    step = run.StepConfig(name="impl", prompt="Write code.", review="Check code.")
    result = run.make_gp_prompt(
        step, "/workspace", "/workspace/pipelines/test",
        "", "", "checkpoint-001.md", 1, "## Checkpoint format\n...",
    )
    assert "First round. No prior state." in result
    assert "Read your previous checkpoint" not in result
    print("  PASS test_gp_template_first_round")


def test_gp_template_no_review():
    """GP prompt with checkpoint but no review (skeptic crashed)."""
    step = run.StepConfig(name="impl", prompt="Write code.", review="Check code.")
    result = run.make_gp_prompt(
        step, "/workspace", "/workspace/pipelines/test",
        "checkpoint-001.md", "",
        "checkpoint-002.md", 2, "## Checkpoint format\n...",
    )
    assert "checkpoint-001.md" in result
    assert "reviewer's feedback" not in result
    print("  PASS test_gp_template_no_review")


def test_skeptic_template():
    """Skeptic template references checkpoint and review paths."""
    step = run.StepConfig(
        name="impl", prompt="Write code.", review="Check for hardcoded secrets.",
    )
    result = run.make_skeptic_prompt(
        step, "/workspace", "/workspace/pipelines/test",
        "", "checkpoint-001.md", "review-001.md", 1, "## Checkpoint format\n...",
    )
    assert "Check for hardcoded secrets." in result
    assert "checkpoint-001.md" in result
    assert "review-001.md" in result
    assert "Write code." not in result  # should use review, not prompt
    print("  PASS test_skeptic_template")


def test_skeptic_template_with_verify():
    """Skeptic template includes verification output."""
    step = run.StepConfig(name="impl", prompt="Write code.", review="Check results.")
    verify = "## Verification Output (exit 0)\n```\nAll passed\n```\n"
    result = run.make_skeptic_prompt(
        step, "/workspace", "/workspace/pipelines/test",
        verify, "checkpoint-001.md", "review-001.md", 1, "## Checkpoint format\n...",
    )
    assert "All passed" in result
    assert "Verification Output" in result
    print("  PASS test_skeptic_template_with_verify")


def test_read_file_missing():
    assert run.read_file("/nonexistent/file.md") == ""
    print("  PASS test_read_file_missing")


def test_read_file_exists():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("hello world")
        f.flush()
        assert run.read_file(f.name) == "hello world"
        os.unlink(f.name)
    print("  PASS test_read_file_exists")


if __name__ == "__main__":
    old_stderr = sys.stderr
    sys.stderr = open(os.devnull, "w")

    print("Running overnight smoke tests...\n")

    tests = [
        test_load_pipeline_minimal,
        test_load_pipeline_full,
        test_load_pipeline_missing_review,
        test_load_pipeline_default_models,
        test_load_pipeline_review_model_inherits_model,
        test_parse_checkpoint_valid,
        test_parse_checkpoint_in_progress,
        test_parse_checkpoint_failed,
        test_parse_checkpoint_missing_file,
        test_parse_checkpoint_no_frontmatter,
        test_parse_checkpoint_invalid_status,
        test_parse_checkpoint_malformed_yaml,
        test_gp_template_with_prev,
        test_gp_template_first_round,
        test_gp_template_no_review,
        test_skeptic_template,
        test_skeptic_template_with_verify,
        test_read_file_missing,
        test_read_file_exists,
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
