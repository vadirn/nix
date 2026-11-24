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
        Some(&["-f", "--force"]),
        "Blocked: force push overwrites remote history. Run `git push --force-with-lease --force-if-includes`, which the pre-push hook checks.",
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

const GIT_FLAGS_WITH_VALUE: &[&str] = &["-C", "-c", "--config-env", "--git-dir", "--work-tree"];

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
    /// Each `name=value` set by `-c` or `--config-env`.
    configs: Vec<&'s str>,
    sub: &'s str,
    args: Vec<&'s str>,
    /// `git` is the command the user wrote at the top level: the segment's
    /// program, outside any substitution or reparsed string.
    own: bool,
}

/// Inside a substitution, a reparsed string or another program such as
/// `xargs`, a push may take words this guard never sees, `--no-verify` among them.
const NESTED_PUSH: &str = "Blocked: run git push as its own command, not inside a substitution, a shell string or another program, so this guard sees each flag it passes.";

const NO_VERIFY: &str = "Blocked: git push --no-verify skips the pre-push hook, which checks the branch name and force pushes. Drop --no-verify. If the hook refuses wrongly, ask the user.";

/// git takes any unambiguous prefix of a long option, so `--no-veri` skips the hook too.
/// `--no-ver` is ambiguous with `--no-verbose`, and git refuses it.
fn skips_push_hooks(arg: &str) -> bool {
    arg.len() >= "--no-veri".len() && "--no-verify".starts_with(arg)
}

/// rebase and am take any prefix down to `--com`.
fn ages_commits(arg: &str) -> bool {
    arg.len() >= "--com".len() && "--committer-date-is-author-date".starts_with(arg)
}

fn hook_off(what: &str) -> String {
    format!(
        "Blocked: {what} switches off the git hooks that check commits and pushes, or hides a commit from them. If a hook refuses wrongly, ask the user."
    )
}

/// An env setting that hides the global config holding the hook entries,
/// clears the marker the hook wrappers read, ages a commit, or sets a hook or
/// alias entry. A committer name or email is not one: the hook inherits it,
/// so it compares the commit with the same identity.
fn hook_env(name: &str, value: &str) -> bool {
    match name {
        "HOME" | "XDG_CONFIG_HOME" | "GIT_CONFIG_GLOBAL" | "CLAUDECODE" | "GIT_COMMITTER_DATE" => {
            true
        }
        "GIT_CONFIG_PARAMETERS" => {
            let v = value.to_ascii_lowercase();
            v.contains("'hook.") || v.contains("'alias.")
        }
        _ => name.starts_with("GIT_CONFIG_KEY_") && hook_key(value),
    }
}

/// Config keys that replace a hook's entry or run a program through an alias.
/// git reads section names case-insensitively.
fn hook_key(setting: &str) -> bool {
    let key = setting.split('=').next().unwrap_or("").to_ascii_lowercase();
    key.starts_with("hook.") || key.starts_with("alias.")
}

/// The name in `NAME=value`, `NAME+=value`, `NAME[i]=value` or a bare `NAME`,
/// when `hook_env` lists the setting.
fn listed(word: &str) -> Option<&str> {
    let (left, value) = word.split_once('=').unwrap_or((word, ""));
    let name = left.split(['+', '[']).next().unwrap_or("");
    hook_env(name, value).then_some(name)
}

/// Builtins whose change lasts for every later command in the script.
const SETS_ENV: &[&str] = &["export", "unset", "declare", "typeset", "readonly", "local"];

/// Whether a segment runs git as its program, directly or through `env`.
fn calls_git(seg: &Segment) -> bool {
    let w = &seg.words;
    match w.first().map(Word::base) {
        Some("git") => true,
        Some("env") => env_program(&w[1..]).is_some_and(|p| p.base() == "git"),
        _ => false,
    }
}

/// The command `env` runs: its first word past the options, the values `-u`
/// and `-C` take, and the `NAME=value` settings.
fn env_program(args: &[Word]) -> Option<&Word> {
    let mut rest = args.iter();
    while let Some(a) = rest.next() {
        match a.value.as_str() {
            "-u" | "--unset" | "-C" | "--chdir" => {
                rest.next();
            }
            v if v.starts_with('-') || v.contains('=') => {}
            _ => return Some(a),
        }
    }
    None
}

/// Whether segment `i` calls git, or hands a shell a script that does. The
/// parser appends that script's segments right after it, one level deeper.
fn reaches_git(segs: &[Segment], i: usize) -> bool {
    calls_git(&segs[i])
        || segs[i + 1..]
            .iter()
            .take_while(|s| s.depth > segs[i].depth && s.origin == Origin::Reparsed)
            .any(calls_git)
}

/// A listed env change that reaches git: a leading assignment or `env` on a
/// segment that reaches git, or a bare assignment or builtin in a script that calls it.
fn env_switch(seg: &Segment, reaches: bool, script_calls_git: bool) -> Option<String> {
    let changed = |name: &str| format!("changing `{name}`");
    let w = &seg.words;
    let lasting = w
        .first()
        .is_none_or(|c| SETS_ENV.contains(&c.value.as_str()));
    if !(reaches || (lasting && script_calls_git)) {
        return None;
    }
    if let Some(name) = seg.assigns.iter().find_map(|a| listed(&a.value)) {
        return Some(changed(name));
    }
    if lasting {
        return w.iter().skip(1).find_map(|a| listed(&a.value)).map(changed);
    }
    if w[0].base() != "env" {
        return None;
    }
    env_change(&w[1..]).map(|n| n.map_or("`env -i`".into(), changed))
}

/// The listed setting `env` makes or clears before its command, or
/// `Some(None)` when it clears every variable.
fn env_change(args: &[Word]) -> Option<Option<&str>> {
    let mut rest = args.iter().map(|a| a.value.as_str());
    while let Some(a) = rest.next() {
        let setting = match a {
            "-i" | "--ignore-environment" | "-" => return Some(None),
            "-u" | "--unset" => rest.next(),
            "-C" | "--chdir" => {
                rest.next();
                None
            }
            _ if a.starts_with("--unset=") => Some(&a["--unset=".len()..]),
            _ if a.starts_with("-u") => Some(&a[2..]),
            _ if a.starts_with('-') => None,
            _ if a.contains('=') => Some(a),
            _ => return None,
        };
        if let Some(name) = setting.and_then(listed) {
            return Some(Some(name));
        }
    }
    None
}

/// A git call that switches off the git hooks or hides a commit from them.
fn hook_switch(call: &GitCall) -> Option<String> {
    if let Some(c) = call.configs.iter().find(|c| hook_key(c)) {
        return Some(format!("`git -c {c}`"));
    }
    if matches!(call.sub, "rebase" | "am") && call.args.iter().any(|a| ages_commits(a)) {
        return Some("`--committer-date-is-author-date`".into());
    }
    let remote = |r: &str| r.starts_with("refs/remotes/");
    // Copying a remote-tracking ref, as a clean clone does, holds no new commit.
    let writes_remotes = match call.sub {
        "update-ref" => updated_ref(&call.args).is_some_and(remote),
        "fetch" | "push" => call.args.iter().any(|a| {
            a.split_once(":refs/remotes/")
                .is_some_and(|(src, _)| !remote(src.trim_start_matches('+')))
        }),
        _ => false,
    };
    writes_remotes.then(|| "a write to `refs/remotes/`".into())
}

/// The ref `git update-ref` writes: its first word past the options and the
/// value `-m` takes.
fn updated_ref<'s>(args: &[&'s str]) -> Option<&'s str> {
    let mut rest = args.iter();
    while let Some(&a) = rest.next() {
        match a {
            "-m" => {
                rest.next();
            }
            _ if a.starts_with('-') => {}
            _ => return Some(a),
        }
    }
    None
}

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
        let mut configs = Vec::new();
        let mut j = i + 1;
        while j < w.len() && w[j].value.starts_with('-') {
            let flag = w[j].value.as_str();
            if flag == "-C" {
                dirs.extend(w.get(j + 1));
            }
            if flag == "-c" || flag == "--config-env" {
                configs.extend(w.get(j + 1).map(|v| v.value.as_str()));
            }
            configs.extend(flag.strip_prefix("--config-env="));
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
                configs,
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
    let script_calls_git = s.segments.iter().any(calls_git);
    for (i, seg) in s.segments.iter().enumerate() {
        if let Some(what) = env_switch(seg, reaches_git(&s.segments, i), script_calls_git) {
            return Some(hook_off(&what));
        }
        for call in git_calls(seg) {
            if let Some(what) = hook_switch(&call) {
                return Some(hook_off(&what));
            }
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
            if call.sub == "push" && call.args.iter().any(|a| skips_push_hooks(a)) {
                return Some(NO_VERIFY.into());
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
