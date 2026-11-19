//! Port of `no-dangerous.py`: denies dangerous git, curl, wget, docker,
//! sudo, chmod and obsidian invocations by their words, so text inside a
//! quoted argument (`git commit -m "block git push -f"`) never triggers a rule.
//!
//! The rule tables and messages are the script's. Differences that come from
//! the shared parse: a command is any word whose last path component names
//! it (`/usr/bin/git push` counts), commands inside `$(...)`, backticks,
//! `bash -c` and `eval` are checked, a heredoc body is data, `chmod` and
//! `777` must share one command, and the `git -C` and obsidian rules read
//! words instead of a regex over the raw text, so a quoted mention of them no
//! longer denies.
//!
//! The `git -C` rule checks its own message, "you are already in the repo":
//! it denies only a `-C` whose directory has the working directory's repo
//! root, found on disk by the nearest `.git`. The script denied every `-C`
//! it saw after a blank or an operator, which caught loops over other repos
//! and missed `$(git -C …)`.

use super::no_dangerous_rm::{expanduser, join, normpath};
use super::{Ctx, Verdict, first_deny};
use crate::shell::{Origin, Script, Segment, Word};

/// (subcommand, any one of these args or `None` for any, message), in order.
const GIT_RULES: &[(&str, Option<&[&str]>, &str)] = &[
    (
        "push",
        Some(&["-f", "--force", "--force-with-lease"]),
        "Blocked: force push overwrites remote history.",
    ),
    (
        "reset",
        Some(&["--hard"]),
        "Blocked: git reset --hard discards uncommitted changes.",
    ),
    (
        "branch",
        Some(&["-D"]),
        "Blocked: git branch -D force-deletes without merge check.",
    ),
    (
        "branch",
        Some(&["-m", "-M", "--move"]),
        "Blocked: git branch -m also rewrites .git/config. The sandbox denies that write, so -m exits 128 after the ref is already renamed. Rename in two steps: `git switch -c <new>` (or `git branch <new> <old>` when <old> is not checked out), then `git branch -d <old>`. Under the sandbox, -d prints \"could not lock config file\" but still deletes the branch and exits 0.",
    ),
    (
        "branch",
        Some(&["-c", "-C", "--copy"]),
        "Blocked: git branch -c also copies the branch's .git/config section. The sandbox denies that write, so -c exits 128 after the copy is already created. Run `git branch <new> <old>` instead.",
    ),
    (
        "merge",
        None,
        "Blocked: rebase instead of merge. Run `git rebase <base>`.",
    ),
];

const GIT_FLAGS_WITH_VALUE: &[&str] = &["-C", "-c", "--git-dir", "--work-tree"];

const CONFIG_READ_FLAGS: &[&str] = &[
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--list",
    "-l",
    "--show-origin",
    "--show-scope",
];

const CURL_UPLOAD_LONG: &[&str] = &[
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "--form",
    "--form-string",
    "--upload-file",
];
/// Short upload flags, case-sensitive: -d data, -F form, -T upload.
const CURL_UPLOAD_SHORT: &str = "dFT";
/// Short options that swallow the rest of their token as a value.
const CURL_SHORT_TAKES_VALUE: &str = "oHXuAebcCDEKmxyYzwUQPr";

const WGET_UPLOAD_LONG: &[&str] = &["--post-data", "--post-file", "--body-data", "--body-file"];

/// (subcommand path, any one of these flags or `None` for any, message).
const DOCKER_RULES: &[(&[&str], Option<&[&str]>, &str)] = &[
    (
        &["compose", "down"],
        Some(&["-v", "--volumes"]),
        "Blocked: docker compose down -v deletes every named volume in the project. Drop -v, or delete a specific volume manually.",
    ),
    (
        &["compose", "rm"],
        Some(&["-v", "--volumes"]),
        "Blocked: docker compose rm -v deletes anonymous volumes. Drop -v.",
    ),
    (
        &["volume", "rm"],
        None,
        "Blocked: docker volume rm removes volumes and their data. Run manually if needed.",
    ),
    (
        &["volume", "prune"],
        None,
        "Blocked: docker volume prune removes every unused volume. Run manually if needed.",
    ),
    (
        &["system", "prune"],
        Some(&["--volumes"]),
        "Blocked: docker system prune --volumes removes volumes. Drop --volumes.",
    ),
    (
        &["container", "rm"],
        Some(&["-v", "--volumes"]),
        "Blocked: docker container rm -v deletes anonymous volumes.",
    ),
    (
        &["rm"],
        Some(&["-v", "--volumes"]),
        "Blocked: docker rm -v deletes anonymous volumes with the container.",
    ),
];

/// Docker top-level flags whose value is the next word.
const DOCKER_TOP_FLAGS_WITH_VALUE: &[&str] = &[
    "-H",
    "--host",
    "--context",
    "--config",
    "-c",
    "--log-level",
    "-l",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
    "-f",
    "--file",
    "-p",
    "--project-name",
    "--project-directory",
    "--profile",
    "--env-file",
    "--ansi",
    "--progress",
    "--parallel",
];

const OBSIDIAN_DENIED: &[&str] = &[
    "eval",
    "plugin:install",
    "plugin:uninstall",
    "dev:cdp",
    "command",
    "history:restore",
];

pub fn check(ctx: &Ctx) -> Verdict {
    first_deny(&ctx.scripts(), |s| scan(s, ctx.cwd, &ctx.home))
}

struct GitCall<'s> {
    /// The value of each `-C`, in order.
    dirs: Vec<&'s Word>,
    sub: &'s str,
    args: Vec<&'s str>,
    /// `git` is the command the user wrote at the top level: the segment's
    /// program, outside any substitution or reparsed string.
    own: bool,
}

/// The git message hook checks the branch a push sends, but it reads only a
/// push that is its own command. Inside a substitution, a reparsed string or
/// another program such as `xargs`, a push may carry words it never sees.
const NESTED_PUSH: &str = "Blocked: run git push as its own command, not inside a substitution, a shell string or another program, so the git message hook can check the branch it sends.";

/// Whether `-C` points git at the repo it is already in: the directory each
/// `-C` names, applied in turn from `cwd`, has the same repo root as `cwd`.
/// A directory holding an expansion (`"$d"` in a loop over repos) is
/// unknown, so it passes; so does any `-C` outside a repo.
fn redundant_dir(dirs: &[&Word], cwd: &str, home: &str) -> bool {
    if dirs.is_empty() || dirs.iter().any(|d| d.expands) || !cwd.starts_with('/') {
        return false;
    }
    let mut at = normpath(cwd);
    for d in dirs {
        at = normpath(&join(&at, &expanduser(&d.value, home)));
    }
    match (repo_root(cwd), repo_root(&at)) {
        (Some(here), Some(there)) => here == there,
        _ => false,
    }
}

/// The root of the repo holding `dir`, as git finds it: the nearest
/// directory at or above `dir` with a `.git` entry, a directory or, for a
/// worktree or submodule, a file. Resolved through symlinks, so `/tmp` and
/// `/private/tmp` compare equal.
fn repo_root(dir: &str) -> Option<std::path::PathBuf> {
    let mut p = std::path::Path::new(dir);
    loop {
        if p.join(".git").exists() {
            return std::fs::canonicalize(p).ok();
        }
        p = p.parent()?;
    }
}

/// Each `git` invocation: its `-C` directories, subcommand, and arguments up to
/// the next `git` word or the end of its simple command.
fn git_calls(seg: &Segment) -> Vec<GitCall<'_>> {
    let w = &seg.words;
    let mut out = Vec::new();
    let mut i = 0;
    while i < w.len() {
        if w[i].base() != "git" {
            i += 1;
            continue;
        }
        let mut dirs = Vec::new();
        let mut j = i + 1;
        while j < w.len() && w[j].value.starts_with('-') {
            if w[j].value == "-C" {
                dirs.extend(w.get(j + 1));
            }
            j += if GIT_FLAGS_WITH_VALUE.contains(&w[j].value.as_str()) {
                2
            } else {
                1
            };
        }
        if j < w.len() {
            let mut k = j + 1;
            while k < w.len() && w[k].base() != "git" {
                k += 1;
            }
            out.push(GitCall {
                dirs,
                sub: w[j].value.as_str(),
                args: w[j + 1..k].iter().map(|a| a.value.as_str()).collect(),
                own: i == 0 && seg.depth == 0 && seg.origin == Origin::Source,
            });
        }
        i = j + 1;
    }
    out
}

/// The arguments after each word naming `name`, to the end of its command.
fn calls<'s>(s: &'s Script, name: &'s str) -> impl Iterator<Item = &'s [Word]> {
    s.segments.iter().flat_map(move |seg| {
        seg.words
            .iter()
            .enumerate()
            .filter(move |(_, w)| w.base() == name)
            .map(move |(k, _)| &seg.words[k + 1..])
    })
}

fn values(args: &[Word]) -> Vec<&str> {
    args.iter().map(|a| a.value.as_str()).collect()
}

fn scan(s: &Script, cwd: &str, home: &str) -> Option<String> {
    for seg in &s.segments {
        for call in git_calls(seg) {
            if call.sub == "config" {
                if !call.args.iter().any(|a| CONFIG_READ_FLAGS.contains(a)) {
                    return Some(
                        "Blocked: git config writes persist and affect all future commits.".into(),
                    );
                }
                continue;
            }
            for (sub, required, message) in GIT_RULES {
                if call.sub != *sub {
                    continue;
                }
                if required.is_none_or(|r| call.args.iter().any(|a| r.contains(a))) {
                    return Some((*message).into());
                }
            }
            if call.sub == "push" && !call.own {
                return Some(NESTED_PUSH.into());
            }
        }
    }

    for args in calls(s, "curl") {
        if has_curl_upload_flag(&values(args)) {
            return Some("Blocked: curl with data upload flags (-d/--data/-F/--form/-T). The sandbox allowlist checks the destination, not the payload. Run manually if needed.".into());
        }
    }

    for args in calls(s, "wget") {
        if values(args)
            .iter()
            .any(|a| WGET_UPLOAD_LONG.contains(&a.split('=').next().unwrap_or("")))
        {
            return Some(
                "Blocked: wget with --post-data/--post-file. Run manually if needed.".into(),
            );
        }
    }

    for args in calls(s, "docker") {
        if let Some(m) = check_docker_args(&values(args)) {
            return Some(m.into());
        }
    }
    for args in calls(s, "docker-compose") {
        let mut v = vec!["compose"];
        v.extend(values(args));
        if let Some(m) = check_docker_args(&v) {
            return Some(m.into());
        }
    }

    for seg in &s.segments {
        if seg.words.iter().any(|w| w.base() == "sudo") {
            return Some("Blocked: sudo runs commands as root. Too risky.".into());
        }
    }

    for seg in &s.segments {
        if seg.words.iter().any(|w| w.base() == "chmod")
            && seg.words.iter().any(|w| w.value == "777")
        {
            return Some("Blocked: chmod 777 makes files world-writable.".into());
        }
    }

    for seg in &s.segments {
        if git_calls(seg)
            .iter()
            .any(|c| redundant_dir(&c.dirs, cwd, home))
        {
            return Some("Use plain `git` — you are already in the repo.".into());
        }
    }

    for seg in &s.segments {
        let w = &seg.words;
        for (k, word) in w.iter().enumerate() {
            if word.base() != "obsidian" {
                continue;
            }
            let Some(sub) = w.get(k + 1).map(|x| x.value.as_str()) else {
                continue;
            };
            let delete_permanent =
                sub == "delete" && w[k + 2..].iter().any(|x| x.value.ends_with("permanent"));
            if OBSIDIAN_DENIED.contains(&sub) || delete_permanent {
                return Some(
                    "Blocked: this obsidian subcommand can cause data loss or run arbitrary code."
                        .into(),
                );
            }
        }
    }
    None
}

fn has_curl_upload_flag(args: &[&str]) -> bool {
    for arg in args {
        if CURL_UPLOAD_LONG.contains(&arg.split('=').next().unwrap_or("")) {
            return true;
        }
        if arg.starts_with("--") || !arg.starts_with('-') {
            continue;
        }
        for c in arg[1..].chars() {
            if CURL_UPLOAD_SHORT.contains(c) {
                return true;
            }
            if CURL_SHORT_TAKES_VALUE.contains(c) {
                break;
            }
        }
    }
    false
}

/// Finds the subcommand path after `docker`, skipping top-level flags, and
/// matches the volume-deleting shapes.
fn check_docker_args(args: &[&str]) -> Option<&'static str> {
    let mut path: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let t = args[i];
        if t.starts_with('-') {
            i += if !t.contains('=') && DOCKER_TOP_FLAGS_WITH_VALUE.contains(&t) {
                2
            } else {
                1
            };
            continue;
        }
        path.push(t);
        i += 1;
        if path.len() == 2 {
            break;
        }
    }
    for (rule_path, required, message) in DOCKER_RULES {
        if path.len() < rule_path.len() || path[..rule_path.len()] != **rule_path {
            continue;
        }
        if required.is_none_or(|r| args.iter().any(|a| r.contains(a))) {
            return Some(message);
        }
    }
    None
}
