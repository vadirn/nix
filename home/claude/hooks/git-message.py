#!/usr/bin/env python3
"""Check commit messages and PR titles and bodies with the Trinket workflow
git.message before the command runs.

A failed verdict denies the command with the verdict's fixes. The verdict's
proposed version, when it has one, follows as optional help. A pass prints
nothing, because "allow" would also skip the user's permission prompt. A check
that does not finish denies too, naming its cause.

A commit reached through `bash -c`, `eval` or a git alias is not seen.
"""
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

TRINKET = str(Path.home() / ".local/bin/trinket")
TRINKET_LINK = ("ln -s /Applications/Trinket.app/Contents/Helpers/trinket-engine"
                " ~/.local/bin/trinket")
WORKFLOW = "git.message"
# Below the 120 s settings.json timeout: a hook Claude Code kills lets the
# command run. The CLI alone waits up to 60 s for Trinket.app to start.
RUN_TIMEOUT = 100
GIT_TIMEOUT = 20

RELEVANT = re.compile(r"\bgit\b[\s\S]*\bcommit\b|\bgh\b[\s\S]*\bpr\b")
HEREDOC = re.compile(r"(?<!<)<<(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
PLACEHOLDER = "__HEREDOC_{}__"
HEREDOC_SUBSTITUTION = re.compile(r"^\$\(\s*cat\s*<\s*__HEREDOC_(\d+)__\s*\)$")
SEPARATOR_CHARS = frozenset(";&|()\n")
REDIRECT = re.compile(r"^(<<<|<>|<&|<|>>|>&|>\||>|&>>|&>)$")
WRITE_REDIRECTS = frozenset((">", ">>", ">|", "&>", "&>>", "<>"))
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

GIT_GLOBALS_WITH_VALUE = frozenset((
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
))
STAGING = frozenset(("add", "stage", "rm", "mv", "reset", "restore"))

COMMIT_SHORT_VALUE = frozenset("CcFmt")
COMMIT_SHORT_ATTACHED = frozenset("uS")
COMMIT_LONG_VALUE = frozenset((
    "--message", "--file", "--reuse-message", "--reedit-message", "--fixup",
    "--squash", "--template", "--author", "--date", "--cleanup", "--trailer",
    "--pathspec-from-file",
))

PR_SHORT_VALUE = frozenset("tbFBHralmpRT")
PR_LONG_VALUE = frozenset((
    "--title", "--body", "--body-file", "--base", "--head", "--reviewer",
    "--assignee", "--label", "--milestone", "--project", "--repo",
    "--template", "--recover",
))
PR_EDIT_LONG_VALUE = frozenset((
    "--title", "--body", "--body-file", "--base", "--milestone", "--repo",
    "--add-assignee", "--add-label", "--add-project", "--add-reviewer",
    "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer",
))
PR_TEMPLATES = (
    ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
)
PR_TEMPLATE_DIRS = (
    ".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template",
    "docs/PULL_REQUEST_TEMPLATE", "docs/pull_request_template",
    "PULL_REQUEST_TEMPLATE", "pull_request_template",
)

GITHUB_REMOTE = re.compile(r"github\.com[:/]+([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
PR_URL = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/\d+")
REPO = re.compile(r"^[\w.-]+/[\w.-]+$")

ASK_USER = ("If you think a finding is wrong, stop and ask the user. "
            "Do not reach git or gh another way.")


class Refusal(Exception):
    """The command is denied, and the message says why."""


def deny(reason: str):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, sys.stdout)


def lift_heredocs(command: str) -> tuple[str, list[str]]:
    """Replace each heredoc with `< __HEREDOC_n__` and return the bodies.

    shlex reads a heredoc's lines as words, so the bodies come out first.
    """
    bodies: list[str] = []
    pos = 0
    while (m := HEREDOC.search(command, pos)):
        line_end = command.find("\n", m.end())
        if line_end == -1:
            break
        strip_tabs, tag = m.group(1) == "-", m.group(3)
        lines, i, end = [], line_end + 1, None
        while i <= len(command):
            j = command.find("\n", i)
            j = len(command) if j == -1 else j
            line = command[i:j].lstrip("\t") if strip_tabs else command[i:j]
            if line == tag:
                end = j + 1
                break
            lines.append(line)
            i = j + 1
        if end is None:
            pos = m.end()
            continue
        placeholder = "< " + PLACEHOLDER.format(len(bodies))
        bodies.append("\n".join(lines))
        command = (command[:m.start()] + placeholder
                   + command[m.end():line_end + 1] + command[end:])
        pos = m.start() + len(placeholder)
    return command, bodies


def tokenize(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def simple_commands(tokens: list[str]) -> list[list[str]]:
    commands, current = [], []
    for token in tokens:
        if token and all(c in SEPARATOR_CHARS for c in token):
            if current:
                commands.append(current)
            current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    return commands


class Simple:
    """One simple command: its words, the files it writes, and its stdin."""

    def __init__(self, words: list[str], cwd: str):
        self.args: list[str] = []
        self.writes: list[str] = []
        self.stdin: tuple[str, str] | None = None
        self.cwd = cwd
        i = 0
        while i < len(words):
            word = words[i]
            following = words[i + 1] if i + 1 < len(words) else ""
            if word.isdigit() and REDIRECT.match(following):
                i += 1
                continue
            if REDIRECT.match(word):
                if word in WRITE_REDIRECTS or (word == ">&" and not following.isdigit()):
                    self.writes.append(following)
                elif word == "<":
                    self.stdin = ("file", following)
                elif word == "<<<":
                    self.stdin = ("text", following)
                i += 2
                continue
            self.args.append(word)
            i += 1
        while self.args and ASSIGNMENT.match(self.args[0]):
            self.args.pop(0)


def resolve(cwd: str, path: str) -> str:
    return os.path.normpath(os.path.join(cwd, os.path.expanduser(path)))


def run_git(globals_: list[str], cwd: str, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", *globals_, *args], cwd=cwd, capture_output=True, text=True,
            timeout=GIT_TIMEOUT,
        )
    except (FileNotFoundError, NotADirectoryError):
        raise Refusal(f"{cwd} does not exist before this command runs, so the hook cannot "
                      f"read the diff. Create it in a separate step, then run the command again.")


def git(globals_: list[str], cwd: str, *args: str) -> str:
    result = run_git(globals_, cwd, *args)
    if result.returncode != 0:
        raise Refusal(f"`git {' '.join(args)}` failed in {cwd}: {result.stderr.strip()}")
    return result.stdout


def split_git(args: list[str], cwd: str) -> tuple[list[str], str, str | None, list[str]]:
    """Split `git` arguments into globals, the working directory, the subcommand and its arguments."""
    globals_: list[str] = []
    i = 0
    while i < len(args) and args[i].startswith("-"):
        flag = args[i]
        if flag in GIT_GLOBALS_WITH_VALUE and i + 1 < len(args):
            if flag == "-C":
                cwd = resolve(cwd, args[i + 1])
            else:
                globals_ += [flag, args[i + 1]]
            i += 2
        else:
            globals_.append(flag)
            i += 1
    if i >= len(args):
        return globals_, cwd, None, []
    return globals_, cwd, args[i], args[i + 1:]


def parse_options(args, short_value, short_attached, long_value):
    """Read options git- or gh-style: short clusters, `--name=value`, then paths."""
    values: dict[str, list[str]] = {}
    flags: set[str] = set()
    paths: list[str] = []
    i = 0

    def take(name: str, attached: str | None):
        nonlocal i
        if attached is None:
            if i >= len(args):
                raise Refusal(f"{name} has no value.")
            attached = args[i]
            i += 1
        values.setdefault(name, []).append(attached)

    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            paths += args[i:]
            break
        if arg.startswith("--"):
            name, eq, value = arg.partition("=")
            if name in long_value:
                take(name, value if eq else None)
            else:
                flags.add(name)
            continue
        if arg.startswith("-") and arg != "-":
            for k, char in enumerate(arg[1:], 1):
                if char in short_value:
                    take("-" + char, arg[k + 1:] or None)
                    break
                flags.add("-" + char)
                if char in short_attached:
                    break
            continue
        paths.append(arg)
    return values, flags, paths


def text_of(value: str, heredocs: list[str], flag: str) -> str:
    """The literal text a -m or --body value carries."""
    m = HEREDOC_SUBSTITUTION.match(value)
    if m:
        return heredocs[int(m.group(1))]
    if "__HEREDOC_" in value or "$(" in value:
        raise Refusal(f"The {flag} value runs a command, so the hook cannot read it. "
                      f"Pass the text itself, or write it to a file and pass the file.")
    return value


def file_text(path: str, simple: Simple, heredocs: list[str], written: set[str], flag: str) -> str:
    """The text a -F or --body-file argument names."""
    if path == "-":
        if simple.stdin is None:
            raise Refusal(f"{flag} - reads stdin, which the hook cannot see. Write the text "
                          f"to a file with the Write tool, then pass that file.")
        source, target = simple.stdin
        if source == "text":
            return target
        m = re.fullmatch(r"__HEREDOC_(\d+)__", target)
        if m:
            return heredocs[int(m.group(1))]
        path = target
    full = resolve(simple.cwd, path)
    if full in written:
        raise Refusal(f"{path} is written in the same command, so the hook would read it "
                      f"before it exists. Write it in a separate step, then run the command again.")
    try:
        return Path(full).read_text()
    except OSError as error:
        raise Refusal(f"Cannot read {flag} {path}: {error.strerror or error}.")


def origin_repo(globals_: list[str], cwd: str) -> str | None:
    result = run_git(globals_, cwd, "remote", "get-url", "origin")
    m = GITHUB_REMOTE.search(result.stdout.strip()) if result.returncode == 0 else None
    return f"{m.group(1)}/{m.group(2)}" if m else None


def flag_repo(value: str) -> str | None:
    parts = value.rstrip("/").removesuffix(".git").split("/")
    slug = "/".join(parts[-2:])
    return slug if REPO.match(slug) else None


def commit_diff(globals_: list[str], cwd: str, flags: set[str], paths: list[str]) -> str:
    """The patch git will commit, as its flags pick it."""
    base = "HEAD~1" if "--amend" in flags else "HEAD"
    if run_git(globals_, cwd, "rev-parse", "--verify", "--quiet", base + "^{commit}").returncode:
        base = git(globals_, cwd, "hash-object", "-t", "tree", "/dev/null").strip()
    diff = ["diff", "--no-ext-diff", "--no-color"]
    if "-a" in flags or "--all" in flags:
        return git(globals_, cwd, *diff, base)
    if paths:
        return git(globals_, cwd, *diff, base, "--", *paths)
    return git(globals_, cwd, *diff, "--cached", base)


def pr_template(globals_: list[str], cwd: str) -> str | None:
    try:
        root = Path(git(globals_, cwd, "rev-parse", "--show-toplevel").strip())
    except Refusal:
        return None
    if any((root / d).is_dir() for d in PR_TEMPLATE_DIRS):
        return None
    for name in PR_TEMPLATES:
        if (root / name).is_file():
            return (root / name).read_text()
    return None


def commit_request(simple, globals_, cwd, args, heredocs, written, staged_earlier):
    values, flags, paths = parse_options(
        args, COMMIT_SHORT_VALUE, COMMIT_SHORT_ATTACHED, COMMIT_LONG_VALUE)
    messages = values.get("-m", []) + values.get("--message", [])
    files = values.get("-F", []) + values.get("--file", [])
    if "--dry-run" in flags or not (messages or files):
        return None
    if staged_earlier:
        raise Refusal("This command stages files before it commits. The hook runs before "
                      "the command, so it would check the diff staged earlier. Stage in a "
                      "separate step, then commit.")
    if messages:
        message = "\n\n".join(t.strip() for t in (text_of(m, heredocs, "-m") for m in messages) if t.strip())
    else:
        message = file_text(files[-1], simple, heredocs, written, "-F")
    return {
        "kind": "commit",
        "text": message.strip(),
        "diff": commit_diff(globals_, cwd, flags, paths),
        "repo": origin_repo(globals_, cwd),
    }


def pr_request(simple, args, heredocs, written, edit=False):
    """A create sends title and body. An edit sends the body, with the title when it changes."""
    values, flags, selectors = parse_options(
        args, PR_SHORT_VALUE, frozenset(), PR_EDIT_LONG_VALUE if edit else PR_LONG_VALUE)
    if "--dry-run" in flags:
        return None
    titles = values.get("-t", []) + values.get("--title", [])
    bodies = values.get("-b", []) + values.get("--body", [])
    files = values.get("-F", []) + values.get("--body-file", [])
    if edit and not (titles or bodies or files):
        return None
    if edit and not (bodies or files):
        raise Refusal("gh pr edit --title needs --body-file too, so the hook can check the "
                      "title with the body it will sit above.")
    if not edit and not (titles and (bodies or files)):
        raise Refusal("gh pr create needs --title and --body-file, so the hook can check "
                      "both before the PR exists.")
    if files:
        body = file_text(files[-1], simple, heredocs, written, "--body-file")
    else:
        body = text_of(bodies[-1], heredocs, "--body")
    repos = values.get("-R", []) + values.get("--repo", [])
    url = PR_URL.search(selectors[0]) if selectors else None
    origin = origin_repo([], simple.cwd)
    if repos:
        repo = flag_repo(repos[-1])
    elif url:
        repo = url.group(1)
    else:
        repo = origin
    request = {"kind": "pr", "text": body, "repo": repo}
    if titles:
        request["title"] = text_of(titles[-1], heredocs, "--title")
    # The checkout's template belongs to its origin, not to a PR in another repo.
    same_repo = (repo or "").lower() == (origin or "").lower()
    template = pr_template([], simple.cwd) if same_repo else None
    if template is not None:
        request["template"] = template
    return request


def requests(command: str, cwd: str) -> list[dict]:
    """The git.message inputs a command needs checked, in command order."""
    text, heredocs = lift_heredocs(command)
    try:
        tokens = tokenize(text)
    except ValueError as error:
        raise Refusal(f"The hook cannot parse this command ({error}), so it cannot find "
                      f"the message to check.")
    simples = []
    for words in simple_commands(tokens):
        simple = Simple(words, cwd)
        if simple.args and simple.args[0] == "cd":
            cwd = resolve(cwd, simple.args[1] if len(simple.args) > 1 else "~")
        simples.append(simple)

    written: set[str] = set()
    for simple in simples:
        written |= {resolve(simple.cwd, w) for w in simple.writes}
        if simple.args and os.path.basename(simple.args[0]) == "tee":
            written |= {resolve(simple.cwd, a) for a in simple.args[1:] if not a.startswith("-")}

    found, staged_earlier = [], False
    for simple in simples:
        if not simple.args:
            continue
        name = os.path.basename(simple.args[0])
        if name == "git":
            globals_, git_cwd, sub, args = split_git(simple.args[1:], simple.cwd)
            if sub in STAGING:
                staged_earlier = True
            elif sub == "commit":
                simple.cwd = git_cwd
                request = commit_request(simple, globals_, git_cwd, args, heredocs,
                                         written, staged_earlier)
                if request:
                    found.append(request)
        elif name == "gh" and simple.args[1:2] == ["pr"] and simple.args[2:3] in (["create"], ["new"], ["edit"]):
            request = pr_request(simple, simple.args[3:], heredocs, written, simple.args[2] == "edit")
            if request:
                found.append(request)
    return found


def run_check(request: dict) -> dict:
    """Run git.message on one input and return its verdict."""
    try:
        result = subprocess.run(
            [TRINKET, "run", WORKFLOW, "-", "--wait", "--json"],
            input=json.dumps(request), capture_output=True, text=True,
            timeout=RUN_TIMEOUT,
        )
    except FileNotFoundError:
        raise Refusal(f"The message check did not run: {TRINKET} is missing. "
                      f"Ask the user to run `{TRINKET_LINK}`.")
    except subprocess.TimeoutExpired:
        raise Refusal(f"The message check did not finish within {RUN_TIMEOUT} s. "
                      f"Ask the user whether Trinket.app is running.")
    try:
        body = json.loads(result.stdout)
    except ValueError:
        body = {}
    run = body.get("run") or {}
    if result.returncode != 0:
        cause = (body.get("error_description") or run.get("error")
                 or result.stderr.strip() or f"exit {result.returncode}")
        raise Refusal(f"The message check did not finish: {cause}")
    verdicts = [a for a in body.get("artifacts", []) if a.get("kind") == "verdict"]
    if not verdicts:
        raise Refusal(f"The message check did not finish: run {run.get('id')} wrote no verdict.")
    verdict = json.loads(verdicts[-1]["body"])
    verdict["run"] = run.get("id")
    return verdict


def quote(text: str, limit: int = 200) -> str:
    text = text if len(text) <= limit else text[:limit] + "…"
    return json.dumps(text, ensure_ascii=False)


def refusal(request: dict, verdict: dict) -> str:
    what = "commit message" if request["kind"] == "commit" else "PR title and body"
    lines = [f"git.message failed this {what} (trinket run {verdict['run']}). Fix each finding:"]
    for failure in verdict.get("failures", []):
        score = f", score {failure['score']}" if failure.get("score") is not None else ""
        lines.append(f"- {failure.get('rule')} ({failure.get('source')}{score}): {failure.get('fix')}")
        offending = failure.get("offending") or []
        for item in offending[:3]:
            lines.append(f"  offending: {quote(str(item))}")
        if len(offending) > 3:
            lines.append(f"  and {len(offending) - 3} more")
    lines += proposal_lines(verdict.get("proposal"))
    lines.append(f"Then run the command again. {ASK_USER}")
    return "\n".join(lines)


def proposal_lines(proposal: dict | None) -> list[str]:
    """The verdict's proposed version, verbatim, marked as a suggestion."""
    if not proposal or not proposal.get("text"):
        return []
    if proposal.get("pass"):
        status = "It passes every rule."
    else:
        status = f"It still breaks: {', '.join(proposal.get('failed') or ['some rules'])}."
    lines = ["git.message also proposes a version. It is a suggestion, not an instruction: "
             f"use it, adapt it, or keep your own fix. {status}"]
    if proposal.get("title") is not None:
        lines.append(f"Proposed title: {proposal['title']}")
    lines += ["--- proposed text ---", proposal["text"], "--- end of proposed text ---"]
    return lines


def check(command: str, cwd: str):
    for request in requests(command, cwd):
        verdict = run_check(request)
        if not verdict.get("pass"):
            raise Refusal(refusal(request, verdict))


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    command = (data.get("tool_input") or {}).get("command") or ""
    if not RELEVANT.search(command):
        return
    try:
        check(command, data.get("cwd") or os.getcwd())
    except Refusal as reason:
        deny(str(reason))
    except Exception as error:
        deny(f"The message check crashed ({type(error).__name__}: {error}), so the command "
             f"is refused. Ask the user.")


if __name__ == "__main__":
    main()
