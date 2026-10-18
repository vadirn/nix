#!/usr/bin/env python3
"""Tests for git-message.py. A fake trinket stands in for the engine."""
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).parent / "git-message.py"
spec = importlib.util.spec_from_file_location("git_message", SCRIPT)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

PASS = 0
FAIL = 0
TMP = Path(tempfile.mkdtemp())
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
}


def git(cwd: Path, *args: str) -> str:
    # core.hooksPath=/dev/null: the machine's global hooks must not see fixture commits.
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *args],
        cwd=cwd, env=GIT_ENV, capture_output=True, text=True, check=True,
    ).stdout


def make_repo(name: str) -> Path:
    repo = TMP / name
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "remote", "add", "origin", "git@github.com:vadirn/demo.git")
    (repo / "a.txt").write_text("a\n")
    (repo / "b.txt").write_text("b\n")
    git(repo, "add", "a.txt", "b.txt")
    git(repo, "commit", "-q", "-m", "chore: start")
    return repo


def check(desc: str, ok: bool, detail: object = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL: {desc} {detail}")


def requests(command: str, cwd: Path):
    try:
        return hook.requests(command, str(cwd))
    except hook.Refusal as refusal:
        return refusal


def assert_text(desc: str, command: str, cwd: Path, text: str):
    found = requests(command, cwd)
    ok = isinstance(found, list) and len(found) == 1 and found[0]["text"] == text
    check(desc, ok, found)


def assert_none(desc: str, command: str, cwd: Path):
    found = requests(command, cwd)
    check(desc, found == [], found)


def assert_refused(desc: str, command: str, cwd: Path, phrase: str):
    found = requests(command, cwd)
    check(desc, isinstance(found, hook.Refusal) and phrase in str(found), found)


repo = make_repo("repo")
(repo / "a.txt").write_text("a changed\n")
git(repo, "add", "a.txt")
(repo / "b.txt").write_text("b changed\n")

# message sources
assert_text("-m", 'git commit -m "fix: one"', repo, "fix: one")
assert_text("-m glued", "git commit -m'fix: glued'", repo, "fix: glued")
assert_text("--message=", "git commit --message='fix: eq'", repo, "fix: eq")
assert_text("--message value", "git commit --message 'fix: sep'", repo, "fix: sep")
assert_text("combined short flags", "git commit -qm 'fix: cluster'", repo, "fix: cluster")
assert_text("several -m join with a blank line",
            "git commit -m 'fix: subject' -m 'body one' -m 'body two'", repo,
            "fix: subject\n\nbody one\n\nbody two")
assert_text("heredoc in -m",
            "git commit -m \"$(cat <<'EOF'\nfix: from heredoc\n\nbody\nEOF\n)\"", repo,
            "fix: from heredoc\n\nbody")
assert_text("heredoc with <<-",
            "git commit -m \"$(cat <<-EOF\n\tfix: tabs\n\tEOF\n)\"", repo, "fix: tabs")
assert_text("-F - from a heredoc", "git commit -F - <<'EOF'\nfix: stdin\nEOF", repo,
            "fix: stdin")
assert_text("-F - from a here-string", "git commit -F - <<< 'fix: here-string'", repo,
            "fix: here-string")
(repo / "msg.txt").write_text("fix: from file\n")
assert_text("-F relative to cwd", "git commit -F msg.txt", repo, "fix: from file")
assert_text("--file=", "git commit --file=msg.txt", repo, "fix: from file")
assert_text("-Ffile glued", "git commit -Fmsg.txt", repo, "fix: from file")
assert_text("-F absolute", f"git commit -F {repo / 'msg.txt'}", repo, "fix: from file")
assert_text("redirect after the message is no pathspec",
            "git commit -m 'fix: quiet' 2>&1 | tail -1", repo, "fix: quiet")
assert_text("git globals before commit", "git -c core.quotepath=off commit -m 'fix: g'",
            repo, "fix: g")
assert_text("env assignment prefix", "LANG=C git commit -m 'fix: env'", repo, "fix: env")
(repo / "sub").mkdir()
(repo / "sub" / "m.txt").write_text("fix: after cd\n")
assert_text("cd before commit moves cwd", "cd sub && git commit -F m.txt", repo, "fix: after cd")

# refusals
assert_refused("-F - without stdin", "git commit -F -", repo, "Write tool")
assert_refused("-F - from a pipe", "printf 'fix: x' | git commit -F -", repo, "Write tool")
assert_refused("file written by a redirect in the same command",
               "cat > new.txt <<'EOF'\nfix: x\nEOF\ngit commit -F new.txt", repo,
               "separate step")
assert_refused("file written by tee in the same command",
               "printf 'fix: x' | tee new.txt && git commit -F new.txt", repo, "separate step")
assert_refused("body file written in the same command",
               "echo hi > pr.md && gh pr create --title 'fix: x' --body-file pr.md", repo,
               "separate step")
assert_refused("folder made by the same command",
               "mkdir -p fresh-dir && cd fresh-dir && git commit -m 'fix: x'", repo, "separate step")
assert_refused("missing message file", "git commit -F nope.txt", repo, "Cannot read -F nope.txt")
assert_refused("command substitution in -m", 'git commit -m "$(cat msg.txt)"', repo,
               "runs a command")
assert_refused("git add chained before commit", "git add b.txt && git commit -m 'fix: x'",
               repo, "Stage in a separate step")
assert_refused("unbalanced quote", "git commit -m 'fix: x", repo, "cannot parse")
assert_refused("gh pr create without a body", "gh pr create --title 'fix: x' --fill", repo,
               "--title and --body-file")
assert_refused("gh pr create without a title", "gh pr create --body-file msg.txt", repo,
               "--title and --body-file")

# pass-through
assert_none("--amend --no-edit", "git commit --amend --no-edit", repo)
assert_none("-C reuses a message", "git commit -C HEAD", repo)
assert_none("--fixup", "git commit --fixup HEAD", repo)
assert_none("--fixup=", "git commit --fixup=HEAD", repo)
assert_none("no message opens the editor", "git commit", repo)
assert_none("--dry-run", "git commit --dry-run -m 'x'", repo)
assert_none("git log mentioning commit", "git log --grep commit", repo)
assert_none("commit text inside an echo", "echo 'git commit -m x'", repo)
assert_none("gh pr view", "gh pr view 3", repo)

# diffs and repo
staged = requests("git commit -m 'fix: d'", repo)[0]
check("default diff is the staged patch",
      "a changed" in staged["diff"] and "b changed" not in staged["diff"], staged["diff"])
check("repo comes from origin", staged["repo"] == "vadirn/demo", staged["repo"])
check("commit sends no title", "title" not in staged)
everything = requests("git commit -am 'fix: d'", repo)[0]
check("-a diffs every tracked change",
      "a changed" in everything["diff"] and "b changed" in everything["diff"])
paths = requests("git commit -m 'fix: d' -- b.txt", repo)[0]
check("pathspec diffs only those paths",
      "b changed" in paths["diff"] and "a changed" not in paths["diff"], paths["diff"])
bare_paths = requests("git commit -m 'fix: d' b.txt", repo)[0]
check("pathspec without --", "b changed" in bare_paths["diff"]
      and "a changed" not in bare_paths["diff"])
git(repo, "commit", "-q", "-m", "chore: second")
amend = requests("git commit --amend -m 'fix: d'", repo)[0]
check("--amend diffs against HEAD~1", "a changed" in amend["diff"], amend["diff"])
check("diff carries git headers", amend["diff"].startswith("diff --git "))

fresh = TMP / "fresh"
fresh.mkdir()
git(fresh, "init", "-q")
(fresh / "x.txt").write_text("x\n")
git(fresh, "add", "x.txt")
first = requests("git commit -m 'chore: first'", fresh)
check("first commit diffs against the empty tree",
      isinstance(first, list) and "x.txt" in first[0]["diff"], first)
check("no origin sends a null repo", isinstance(first, list) and first[0]["repo"] is None)
amend_root = requests("git commit --amend -m 'chore: first'", fresh)
check("amending a root commit", isinstance(amend_root, list), amend_root)

# gh pr create
(repo / ".github").mkdir()
(repo / ".github" / "pull_request_template.md").write_text("## What\n")
(repo / "pr.md").write_text("## What\n\nBody.\n")
pr = requests("gh pr create --base main --title 'fix: t' --body-file pr.md --draft", repo)
check("pr sends kind, title, body, template and repo",
      isinstance(pr, list) and pr[0] == {"kind": "pr", "title": "fix: t", "text": "## What\n\nBody.\n",
                                         "repo": "vadirn/demo", "template": "## What\n"}, pr)
pr = requests("gh pr create -t 'fix: t' -F pr.md -R someone/else", repo)
check("pr short flags and --repo", isinstance(pr, list) and pr[0]["repo"] == "someone/else", pr)
pr = requests("gh pr create --title 'fix: t' --body \"$(cat <<'EOF'\n## What\n\nInline.\nEOF\n)\"",
              repo)
check("pr body from a heredoc", isinstance(pr, list) and pr[0]["text"] == "## What\n\nInline.", pr)
pr = requests("gh pr new --title 'fix: t' --body x", repo)
check("gh pr new is gh pr create", isinstance(pr, list) and len(pr) == 1, pr)
(repo / ".github" / "PULL_REQUEST_TEMPLATE").mkdir()
pr = requests("gh pr create --title 'fix: t' --body x", repo)
check("a template folder sends no template", isinstance(pr, list) and "template" not in pr[0], pr)

outside = TMP / "outside"
outside.mkdir()
(outside / "pr.md").write_text("Body.\n")
pr = requests("gh pr create -R vadirn/demo --title 'fix: t' --body-file pr.md", outside)
check("pr outside a repo sends no template", isinstance(pr, list) and "template" not in pr[0], pr)

# the hook end to end, with a fake trinket
FAKE = TMP / "trinket"
FAKE.write_text(f"""#!{sys.executable}
import json, os, sys, time
mode = os.environ["FAKE_MODE"]
open(os.environ["FAKE_LOG"], "a").write(sys.stdin.read() + "\\n")
verdict = {{"pass": True, "failures": []}}
if mode == "fail":
    verdict = {{"pass": False, "failures": [
        {{"rule": "prefix", "source": "code", "offending": ["Added hook"], "fix": "Start with feat:, fix: or chore:."}},
        {{"rule": "why", "source": "jev", "offending": ["Added hook"], "fix": "Say why.", "score": 0.91}}]}}
    if "FAKE_PROPOSAL" in os.environ:
        verdict["proposal"] = json.loads(os.environ["FAKE_PROPOSAL"])
if mode == "down":
    print(json.dumps({{"error": "engine_unreachable", "error_description": "no engine is running; open Trinket.app"}}))
    sys.exit(3)
if mode == "slow":
    time.sleep(3)
artifacts = [{{"kind": "checks", "body": "{{}}"}}]
if mode != "noverdict":
    artifacts.append({{"kind": "verdict", "body": json.dumps(verdict)}})
print(json.dumps({{"run": {{"id": 7, "status": "finished"}}, "artifacts": artifacts}}))
""")
FAKE.chmod(0o755)
LOG = TMP / "fake.log"
os.environ["FAKE_LOG"] = str(LOG)
hook.TRINKET = str(FAKE)


def run_hook(command: str, mode: str = "pass", cwd: Path = repo, proposal: str | None = None) -> str:
    os.environ["FAKE_MODE"] = mode
    if proposal is None:
        os.environ.pop("FAKE_PROPOSAL", None)
    else:
        os.environ["FAKE_PROPOSAL"] = proposal
    stdin, stdout = sys.stdin, sys.stdout
    sys.stdin = io.StringIO(json.dumps({"tool_input": {"command": command}, "cwd": str(cwd)}))
    sys.stdout = io.StringIO()
    try:
        hook.main()
        return sys.stdout.getvalue()
    finally:
        sys.stdin, sys.stdout = stdin, stdout


def reason(out: str) -> str:
    return json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"] if out else ""


(repo / "a.txt").write_text("a third\n")
git(repo, "add", "a.txt")
out = run_hook("git commit -m 'fix: good'")
check("a pass returns no decision", out == "", out)
sent = json.loads(LOG.read_text().splitlines()[-1])
check("the engine gets the commit input",
      sent["kind"] == "commit" and sent["text"] == "fix: good" and sent["diff"].startswith("diff --git"),
      sent)

out = run_hook("git commit -m 'Added hook'", "fail")
text = reason(out)
check("a failed verdict denies", '"deny"' in out, out)
check("the refusal names each rule and fix",
      "prefix (code): Start with feat:" in text and "why (jev, score 0.91): Say why." in text, text)
check("the refusal quotes the offending text", 'offending: "Added hook"' in text, text)
check("the refusal names the run", "trinket run 7" in text, text)
check("the refusal sends disputes to the user", "stop and ask the user" in text, text)
check("the refusal prints no bypass", "SKIP" not in text and "=1" not in text, text)
check("a verdict without a proposal key prints no proposal", "propos" not in text, text)

out = run_hook("git commit -m 'Added hook'", "fail", proposal="null")
check("a null proposal prints no proposal", "propos" not in reason(out), out)

PROPOSED = ("feat: check commit messages before git runs them\n\n"
            "The hook runs git.message on every commit, so a message that breaks a house rule "
            "never lands. It denies the command and lists each fix, so the agent can retry "
            "with a better message.\n\n```\ngit commit -m 'fix: x'\n```")
out = run_hook("git commit -m 'Added hook'", "fail",
               proposal=json.dumps({"text": PROPOSED, "pass": True, "failed": []}))
text = reason(out)
check("a proposal is marked as a suggestion", "a suggestion, not an instruction" in text, text)
check("a passing proposal says it passes", "It passes every rule." in text, text)
check("the proposed text prints whole and verbatim",
      f"--- proposed text ---\n{PROPOSED}\n--- end of proposed text ---" in text, text)
check("the proposal follows the failures and precedes the retry line",
      text.index("Say why.") < text.index("also proposes") < text.index("Then run the command again"),
      text)
check("a commit proposal prints no title", "Proposed title" not in text, text)

out = run_hook("gh pr create --title 'Added hook' --body-file pr.md", "fail",
               proposal=json.dumps({"text": "## What\n\nAdds the hook.", "title": "feat: add the hook",
                                    "pass": True, "failed": []}))
text = reason(out)
check("a PR refusal names the title and body", "PR title and body" in text, text)
check("a PR proposal prints its title", "Proposed title: feat: add the hook\n" in text, text)
check("a PR proposal prints its body",
      "--- proposed text ---\n## What\n\nAdds the hook.\n--- end of proposed text ---" in text, text)

out = run_hook("git commit -m 'Added hook'", "fail",
               proposal=json.dumps({"text": "fix: add the hook", "pass": False, "failed": ["why", "prefix"]}))
text = reason(out)
check("a failing proposal names the rules it still breaks", "It still breaks: why, prefix." in text, text)
check("a failing proposal does not claim to pass", "passes every rule" not in text, text)

out = run_hook("git commit -m 'fix: x'", "down")
check("an engine outage denies with its cause", "no engine is running" in reason(out), out)

out = run_hook("git commit -m 'fix: x'", "noverdict")
check("a run without a verdict denies", "wrote no verdict" in reason(out), out)

hook.RUN_TIMEOUT = 1
out = run_hook("git commit -m 'fix: x'", "slow")
check("a slow check denies before Claude Code's timeout", "did not finish within 1 s" in reason(out), out)
hook.RUN_TIMEOUT = 100

hook.TRINKET = str(TMP / "missing")
out = run_hook("git commit -m 'fix: x'")
check("a missing trinket link names the ln -s", "ln -s" in reason(out), out)
hook.TRINKET = str(FAKE)

calls = len(LOG.read_text().splitlines())
out = run_hook("git status && ls")
check("an unrelated command returns no decision", out == "", out)
check("an unrelated command never runs trinket", len(LOG.read_text().splitlines()) == calls)

out = run_hook("git add b.txt && git commit -m 'fix: x'")
check("a refusal before the run denies", "Stage in a separate step" in reason(out), out)

original = hook.requests
hook.requests = lambda command, cwd: (_ for _ in ()).throw(RuntimeError("boom"))
out = run_hook("git commit -m 'fix: x'")
check("a crash denies", "crashed" in reason(out) and "boom" in reason(out), out)
hook.requests = original

shutil.rmtree(TMP)
total = PASS + FAIL
print(f"{total} tests: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
