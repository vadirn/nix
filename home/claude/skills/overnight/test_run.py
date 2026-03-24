#!/usr/bin/env python3
"""Smoke tests for overnight pipeline runner.

Run: uv run --with pyyaml python3 home/claude/skills/overnight/test_run.py
"""

import os
import sys
import tempfile
import shutil

# Add the skill directory to path so we can import run
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
        assert len(p.steps) == 1
        assert p.steps[0].name == "hello"
        assert p.steps[0].prompt == "Say hello"
        # Defaults applied
        assert p.steps[0].model == "claude-opus-4-6[1m]"
        assert p.steps[0].image == "claude-runner"
        assert p.steps[0].max_rounds == 50
        assert p.steps[0].resolve_questions is True
        os.unlink(f.name)
    print("  PASS test_load_pipeline_minimal")


def test_load_pipeline_full():
    """Pipeline with all fields."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write("""
name: full-test
defaults:
  model: claude-sonnet-4-6
  max_rounds: 10
  wait: 5
  resolve_questions: false
  explore_model: claude-haiku-4-5
steps:
  - name: analyze
    prompt: "Analyze code"
    skills: [explore, tdd]
    max_rounds: 3
  - name: implement
    prompt: "Write code"
    accept: "tests pass"
    agent: api-dev
    image: custom-image
    model: claude-opus-4-6[1m]
    on_fail: retry
    max_retries: 2
    verify: "npm test"
    resolve_questions: true
""")
        f.flush()
        p = run.load_pipeline(f.name)
        assert p.name == "full-test"
        assert p.defaults["model"] == "claude-sonnet-4-6"
        assert p.defaults["wait"] == 5

        s0 = p.steps[0]
        assert s0.name == "analyze"
        assert s0.skills == ["explore", "tdd"]
        assert s0.max_rounds == 3  # overridden
        assert s0.model == "claude-sonnet-4-6"  # from defaults
        assert s0.resolve_questions is False  # from defaults

        s1 = p.steps[1]
        assert s1.agent == "api-dev"
        assert s1.image == "custom-image"
        assert s1.model == "claude-opus-4-6[1m]"  # overridden
        assert s1.on_fail == "retry"
        assert s1.max_retries == 2
        assert s1.verify == "npm test"
        assert s1.resolve_questions is True  # overridden
        os.unlink(f.name)
    print("  PASS test_load_pipeline_full")


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
    """Missing file defaults to IN_PROGRESS."""
    result = run.parse_checkpoint("/nonexistent/path.md")
    assert result["status"] == "STEP_IN_PROGRESS"
    print("  PASS test_parse_checkpoint_missing_file")


def test_parse_checkpoint_no_frontmatter():
    """No frontmatter defaults to IN_PROGRESS."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("# Just a regular markdown file\n\nNo frontmatter here.\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_no_frontmatter")


def test_parse_checkpoint_invalid_status():
    """Unknown status defaults to IN_PROGRESS."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("---\nstatus: BOGUS_VALUE\n---\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_invalid_status")


def test_parse_checkpoint_malformed_yaml():
    """Malformed YAML defaults to IN_PROGRESS."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("---\nstatus: [broken\n---\n")
        f.flush()
        result = run.parse_checkpoint(f.name)
        assert result["status"] == "STEP_IN_PROGRESS"
        os.unlink(f.name)
    print("  PASS test_parse_checkpoint_malformed_yaml")


def test_has_open_questions_yes():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_IN_PROGRESS
step: impl
round: 1
---

## Done
Some work.

## Open questions
- What rate limit does the API enforce?
- Is there a retry mechanism?
""")
        f.flush()
        assert run.has_open_questions(f.name) is True
        os.unlink(f.name)
    print("  PASS test_has_open_questions_yes")


def test_has_open_questions_no():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_COMPLETE
step: impl
round: 3
---

## Done
Everything done.

## Open questions
None
""")
        f.flush()
        assert run.has_open_questions(f.name) is False
        os.unlink(f.name)
    print("  PASS test_has_open_questions_no")


def test_has_open_questions_empty():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_COMPLETE
step: impl
round: 2
---

## Done
Done.

## Open questions

""")
        f.flush()
        assert run.has_open_questions(f.name) is False
        os.unlink(f.name)
    print("  PASS test_has_open_questions_empty")


def test_has_open_questions_missing_section():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("""---
status: STEP_COMPLETE
step: impl
round: 1
---

## Done
Done.
""")
        f.flush()
        assert run.has_open_questions(f.name) is False
        os.unlink(f.name)
    print("  PASS test_has_open_questions_missing_section")


def test_build_skills_dir():
    """Skills filtering: only checkpoint + listed skills are copied."""
    with tempfile.TemporaryDirectory() as skills_src:
        # Create source skills
        for name in ["checkpoint", "tdd", "tracer-bullet", "explore"]:
            skill_dir = os.path.join(skills_src, name)
            os.makedirs(skill_dir)
            with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
                f.write(f"# {name} skill\n")

        with tempfile.TemporaryDirectory() as tmpdir:
            from pathlib import Path
            result = run.build_skills_dir(Path(skills_src), ["tdd", "explore"], tmpdir)

            # checkpoint always included
            assert os.path.exists(os.path.join(result, "checkpoint", "SKILL.md"))
            # listed skills included
            assert os.path.exists(os.path.join(result, "tdd", "SKILL.md"))
            assert os.path.exists(os.path.join(result, "explore", "SKILL.md"))
            # unlisted skill excluded
            assert not os.path.exists(os.path.join(result, "tracer-bullet"))

    print("  PASS test_build_skills_dir")


def test_build_skills_dir_empty():
    """No skills listed: only checkpoint."""
    with tempfile.TemporaryDirectory() as skills_src:
        os.makedirs(os.path.join(skills_src, "checkpoint"))
        with open(os.path.join(skills_src, "checkpoint", "SKILL.md"), "w") as f:
            f.write("# checkpoint\n")
        os.makedirs(os.path.join(skills_src, "tdd"))

        with tempfile.TemporaryDirectory() as tmpdir:
            from pathlib import Path
            result = run.build_skills_dir(Path(skills_src), [], tmpdir)
            assert os.path.exists(os.path.join(result, "checkpoint", "SKILL.md"))
            assert not os.path.exists(os.path.join(result, "tdd"))

    print("  PASS test_build_skills_dir_empty")


def test_prompt_template():
    """Prompt template renders without errors."""
    result = run.PROMPT_TEMPLATE.format(
        step_name="implement",
        round_number=3,
        prompt="Fix the auth module.",
        accept="Tests pass.",
        prev_checkpoint="## Done\nAnalyzed files.\n",
        checkpoint_filename="checkpoint-2026-03-24-11-45-58-003.md",
    )
    assert "implement" in result
    assert "round 3" in result
    assert "Fix the auth module." in result
    assert "Tests pass." in result
    assert "Analyzed files." in result
    assert "checkpoint-" in result
    print("  PASS test_prompt_template")


if __name__ == "__main__":
    # Suppress warnings from parse_checkpoint to stderr
    old_stderr = sys.stderr
    sys.stderr = open(os.devnull, "w")

    print("Running overnight smoke tests...\n")

    tests = [
        test_load_pipeline_minimal,
        test_load_pipeline_full,
        test_parse_checkpoint_valid,
        test_parse_checkpoint_in_progress,
        test_parse_checkpoint_failed,
        test_parse_checkpoint_missing_file,
        test_parse_checkpoint_no_frontmatter,
        test_parse_checkpoint_invalid_status,
        test_parse_checkpoint_malformed_yaml,
        test_has_open_questions_yes,
        test_has_open_questions_no,
        test_has_open_questions_empty,
        test_has_open_questions_missing_section,
        test_build_skills_dir,
        test_build_skills_dir_empty,
        test_prompt_template,
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
