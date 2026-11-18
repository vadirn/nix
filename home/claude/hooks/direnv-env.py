#!/usr/bin/env python3
"""Load a project's direnv environment for Claude's Bash tool.

Claude runs Bash non-interactively, so direnv's prompt hook never fires. The
shell snapshot Claude sources before every command also ends with a frozen
`export PATH`, which buries anything ~/.zshrc did. CLAUDE_ENV_FILE is sourced
after that snapshot, so it is the only place a PATH change survives.

Three things this does NOT do, all deliberate:

  - It never overwrites CLAUDE_ENV_FILE. Every hook in the session shares that
    file, so truncating it would drop sandbox-nc-path.sh's entry. It appends
    one source line and rewrites its own snapshot instead.
  - It never assigns PATH. The snapshot only ever prepends to the live $PATH,
    so entries other hooks added survive whatever order the hooks ran in.
  - It never fails a shell. Every exit is 0, the snapshot always parses, and
    the source line tolerates a snapshot that is missing or unreadable.

Hooks may run under macOS's own python3, so this stays within Python 3.9.
"""

import contextlib
import fcntl
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys

# `direnv status --json` reports a config file's trust as one of these.
ALLOWED, NOT_ALLOWED = 0, 1

# direnv reports "already loaded" and prints nothing when DIRENV_DIFF is set,
# which Claude inherits whenever it was launched from a loaded shell. Dropping
# the bookkeeping makes every run a full export.
BOOKKEEPING = (
    "DIRENV_DIFF",
    "DIRENV_WATCHES",
    "DIRENV_DIR",
    "DIRENV_FILE",
    "IN_NIX_SHELL",
)

SHELL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def quote(value):
    """Single-quote a string for a POSIX shell, safe characters included."""
    return "'" + value.replace("'", "'\\''") + "'"


def snapshot_lines(exported, base_path):
    """Shell lines that apply direnv's export on top of the live $PATH."""
    lines = []
    for key, value in exported.items():
        # direnv exports its own bookkeeping even for a config file it refused
        # to run. It says nothing about the project, and the next run unsets it
        # anyway, so it never reaches the snapshot.
        if not SHELL_NAME.match(key) or key.startswith("DIRENV_"):
            continue
        if value is None:
            lines.append("unset " + key)
        elif key != "PATH":
            lines.append("export {}={}".format(key, quote(value)))
        elif value != base_path:
            # direnv prepends, so its PATH is normally the live one with entries
            # in front. Strip that suffix and re-attach $PATH at run time. When
            # the suffix does not match, direnv reordered or dropped something:
            # prepend the whole value, so a PATH entry another hook added still
            # resolves.
            suffix = ":" + base_path
            if value.endswith(suffix):
                value = value[: -len(suffix)]
            lines.append('export PATH={}":$PATH"'.format(quote(value)))
    # Some Claude versions join this file into command strings with `&&`, and a
    # trailing `;` would make `; &&` a syntax error. Keep the last token valid.
    lines.append("true")
    return lines


def run(args, **kwargs):
    """Run a command with captured output, or return None if it cannot start.

    direnv's stderr carries whatever the .envrc and nix printed, so a byte that
    is not UTF-8 becomes a replacement character instead of aborting the run.
    """
    try:
        return subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            **kwargs,
        )
    except OSError:
        return None


def git(*args):
    """A git command's output without its trailing newline, or "" on failure."""
    done = run(["git", *args])
    return done.stdout.rstrip("\n") if done and done.returncode == 0 else ""


def found_rc(direnv, env, cwd=None):
    """The config file direnv sees from cwd, as `direnv status` describes it."""
    done = run([direnv, "status", "--json"], env=env, cwd=cwd)
    try:
        rc = json.loads(done.stdout)["state"]["foundRC"]
    except (AttributeError, KeyError, TypeError, ValueError):
        return {}
    return rc if isinstance(rc, dict) else {}


def inherit_trust(direnv, env):
    """Allow a worktree's .envrc that is a byte-identical copy of an allowed one.

    direnv ties trust to a file's path, so every new worktree starts out blocked
    even when the main checkout's .envrc is allowed. A file the branch changed,
    or one the user denied, stays as direnv left it.
    """
    rc = found_rc(direnv, env)
    path = rc.get("path")
    if rc.get("allowed") != NOT_ALLOWED or not isinstance(path, str):
        return
    top = git("-C", os.path.dirname(path), "rev-parse", "--show-toplevel")
    if not top or not path.startswith(top + "/"):
        return
    # The first entry is the main worktree, whichever worktree asks.
    first = git("-C", top, "worktree", "list", "--porcelain").split("\n", 1)[0]
    if not first.startswith("worktree "):
        return
    main_tree = first[len("worktree ") :]
    if main_tree == top:
        return
    twin = main_tree + path[len(top) :]
    try:
        if not filecmp.cmp(path, twin, shallow=False):
            return
    except OSError:
        return
    twin_dir = os.path.dirname(twin)
    if found_rc(direnv, dict(env, PWD=twin_dir), twin_dir).get("allowed") != ALLOWED:
        return
    run([direnv, "allow", path], env=env)


def nix_path():
    """NIX_PATH as a login zsh would see it, or "".

    nix-darwin sets NIX_PATH only in a script that /etc/zshenv sources, and
    Python never reads zshenv. Hooks the desktop app starts inherit launchd's
    environment, which lacks it. nix-direnv then cannot resolve <nixpkgs> and
    falls back to an empty shell. So ask zsh. Dropping nix-darwin's guard makes
    zshenv source the script even when a parent exported the guard without
    NIX_PATH.
    """
    env = dict(os.environ)
    env.pop("__NIX_DARWIN_SET_ENVIRONMENT_DONE", None)
    done = run(["zsh", "-c", 'print -r -- "$NIX_PATH"'], env=env)
    return done.stdout.rstrip("\n") if done else ""


def hook_cwd():
    """The working directory the hook event names, or "" if it names none."""
    try:
        event = json.load(sys.stdin.buffer)
    except ValueError:
        return ""
    cwd = event.get("cwd") if isinstance(event, dict) else None
    return cwd if isinstance(cwd, str) and os.path.isdir(cwd) else ""


def install(staged, snapshot, claim, pid):
    """Rename staged over snapshot if this run still holds the newest claim.

    A cold nix evaluation can outrun the hook timeout, and the kill lands
    mid-write. Renaming within one directory is atomic, so a killed run leaves
    the previous snapshot whole rather than truncating it to half a line. The
    claim check and the rename share one lock, so an older run never renames
    over a newer one.
    """
    with open(claim) as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        if held.read().strip() == pid:
            os.replace(staged, snapshot)


def main():
    env_file = os.environ.get("CLAUDE_ENV_FILE")
    direnv = shutil.which("direnv")
    if not env_file or not direnv:
        return

    snapshot = env_file + ".direnv"
    # CwdChanged can fire twice within milliseconds, and the two runs overlap.
    # Each run claims the snapshot as it starts, and only the latest claim
    # installs, so the snapshot follows the newest directory whichever run
    # finishes last.
    claim = snapshot + ".latest"
    pid = str(os.getpid())
    with open(claim, "w") as f:
        f.write(pid + "\n")

    env = dict(os.environ)
    if not env.get("NIX_PATH"):
        found = nix_path()
        if found:
            env["NIX_PATH"] = found

    # Hooks receive the working directory on stdin. Trust it over $PWD so
    # worktree sessions started by `clw` read their own .envrc. PWD follows,
    # as it would after a shell's cd.
    cwd = hook_cwd()
    if cwd:
        os.chdir(cwd)
        env["PWD"] = cwd

    inherit_trust(direnv, env)

    done = run(
        [direnv, "export", "json"],
        env={k: v for k, v in env.items() if k not in BOOKKEEPING},
    )
    try:
        exported = json.loads(done.stdout) if done and done.stdout.strip() else {}
    except ValueError:
        exported = {}
    if not isinstance(exported, dict):
        exported = {}

    # Staged beside CLAUDE_ENV_FILE, which we already know is writable. A temp
    # file under $TMPDIR could be refused by a sandboxed session. The pid keeps
    # overlapping runs out of each other's files.
    staged = "{}.{}.new".format(snapshot, pid)
    try:
        with open(staged, "w", encoding="utf-8") as f:
            f.write("\n".join(snapshot_lines(exported, env.get("PATH", ""))) + "\n")
        install(staged, snapshot, claim, pid)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(staged)

    # Written after the snapshot exists, and guarded anyway: a stale line
    # pointing at a deleted snapshot must not print an error before every
    # command, nor return non-zero to whatever sources this file.
    try:
        with open(env_file, encoding="utf-8", errors="replace") as f:
            listed = snapshot in f.read()
    except FileNotFoundError:
        listed = False
    if not listed:
        with open(env_file, "a", encoding="utf-8") as f:
            f.write("[ -r {0} ] && . {0} || true\n".format(quote(snapshot)))

    if done and "is blocked" in done.stderr:
        where = env.get("PWD") or os.getcwd()
        print(
            "direnv-env: config in {} is not allowed - run: direnv allow".format(where),
            file=sys.stderr,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # report it, but every exit is 0
        print("direnv-env: {}".format(error), file=sys.stderr)
    sys.exit(0)
