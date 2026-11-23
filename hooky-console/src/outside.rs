//! Hooks a harness runs beside hooky's. The Handlers screen lists them under
//! "Outside hooky", with no switch: hooky never runs them, so it can neither
//! turn them off nor log them.
//!
//! - **Your settings:** a hook in the settings file `hooky install` writes
//!   that does not call hooky. The `hooky-wiring-*` checks fail the next
//!   rebuild until it moves into hooky's hooks file.
//! - **Projects:** the hooks a project's own files wire. The projects are the
//!   folders hooky's log names, each line's `cwd`, so a project shows while
//!   the log keeps a day a session worked in it. A folder stands for its
//!   repository: the nearest folder at or above it that holds `.git`. A
//!   worktree goes by the name of the repository it belongs to, and a hook
//!   its copy shares with that repository shows once. The home folder is no
//!   project: its settings are the file above.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::hooks::Hooks;
use crate::space::Harness;

/// Where a hook outside hooky is wired.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// The settings file whose entries hand each event to hooky.
    Settings,
    /// A project's own files, by the repository's folder name.
    Project(String),
}

/// One hook a harness runs beside hooky's.
#[derive(Debug, Clone, PartialEq)]
pub struct Outside {
    pub source: Source,
    pub event: String,
    /// The matcher as written; empty when its group sets none.
    pub matcher: String,
    pub command: String,
}

/// The settings file `hooky install` writes for one harness
/// (`hooky/src/harness.rs`, `settings_file`).
fn settings_file(h: Harness, home: &Path) -> PathBuf {
    match h {
        Harness::Claude => home.join(".claude/settings.json"),
        Harness::Codex => home.join(".codex/hooks.json"),
    }
}

/// Whether `cmd` is an entry hooky generates for `event`: one shell word
/// naming a file called `hooky`, an optional `--harness NAME`, then the
/// event. A copy of `calls_hooky` in `hooky/src/install.rs`, whose test
/// cases its own test repeats.
fn calls_hooky(cmd: &str, event: &str) -> bool {
    let Some(mut rest) = cmd.strip_suffix(event).and_then(|r| r.strip_suffix(' ')) else {
        return false;
    };
    if let Some((head, name)) = rest.rsplit_once(" --harness ")
        && !name.contains(' ')
    {
        rest = head;
    }
    let one_word = !rest.contains(char::is_whitespace)
        || ((rest.starts_with('\'') || rest.starts_with("~/'")) && rest.ends_with('\''));
    let bin = rest.trim_end_matches('\'');
    one_word && (bin == "hooky" || bin.ends_with("/hooky"))
}

/// Each hook a file's `hooks` object wires, as (event, matcher, command); an
/// unreadable or missing file wires none.
fn wired(path: &Path) -> Vec<(String, String, String)> {
    let Some(root) = fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return Vec::new();
    };
    Hooks::of(Some(&root))
        .events
        .into_iter()
        .flat_map(|(event, groups)| {
            groups.into_iter().flat_map(move |g| {
                let event = event.clone();
                g.handlers
                    .into_iter()
                    .map(move |e| (event.clone(), g.matcher.clone(), e.command))
            })
        })
        .collect()
}

/// A project's files that wire one harness's hooks, relative to its folder.
/// Each holds a `hooks` object shaped as hooky's hooks file is.
fn files(h: Harness) -> &'static [&'static str] {
    match h {
        Harness::Claude => &[".claude/settings.json", ".claude/settings.local.json"],
        Harness::Codex => &[".codex/hooks.json"],
    }
}

/// The repository `dir` sits in, or `dir` itself outside one.
fn repo(dir: &Path) -> &Path {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .unwrap_or(dir)
}

/// The name a repository goes by. A worktree's `.git` is a file naming
/// `<main>/.git/worktrees/<name>`, so it goes by `<main>`'s name.
fn project(repo: &Path) -> String {
    let gitdir = fs::read_to_string(repo.join(".git")).ok();
    let main = gitdir
        .as_deref()
        .and_then(|t| t.trim().strip_prefix("gitdir: "))
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|w| w.file_name().is_some_and(|n| n == "worktrees"))
        .and_then(Path::parent)
        .and_then(Path::parent);
    let named = main.unwrap_or(repo);
    named.file_name().map_or_else(
        || named.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// The hooks one harness runs beside hooky's: those in its settings file
/// under the home folder `home` first, then those of the projects of
/// `folders`, in project order, then file order.
pub fn scan(folders: &[String], h: Harness, home: &Path) -> Vec<Outside> {
    let mut found: Vec<Outside> = wired(&settings_file(h, home))
        .into_iter()
        .filter(|(event, _, command)| !calls_hooky(command, event))
        .map(|(event, matcher, command)| Outside {
            source: Source::Settings,
            event,
            matcher,
            command,
        })
        .collect();
    let mut repos: Vec<PathBuf> = folders
        .iter()
        .map(|f| repo(Path::new(f)).to_path_buf())
        .filter(|r| r != home)
        .collect();
    repos.sort();
    repos.dedup();
    let mut projects: Vec<Outside> = Vec::new();
    for r in &repos {
        let name = project(r);
        for file in files(h) {
            for (event, matcher, command) in wired(&r.join(file)) {
                let o = Outside {
                    source: Source::Project(name.clone()),
                    event,
                    matcher,
                    command,
                };
                if !projects.contains(&o) {
                    projects.push(o);
                }
            }
        }
    }
    projects.sort_by(|a, b| match (&a.source, &b.source) {
        (Source::Project(x), Source::Project(y)) => x.cmp(y),
        _ => std::cmp::Ordering::Equal,
    });
    found.extend(projects);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rc-outside-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn project(name: &str) -> Source {
        Source::Project(name.into())
    }

    const STOP: &str =
        r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "./stop.sh"}]}]}}"#;

    #[test]
    fn hooky_commands_are_told_from_others() {
        // `hooky/src/install.rs`'s cases, so the copy answers as hooky does.
        assert!(calls_hooky("~/.local/bin/hooky PreToolUse", "PreToolUse"));
        assert!(calls_hooky("/opt/hooky --harness codex Stop", "Stop"));
        assert!(calls_hooky("~/'my apps/hooky' Stop", "Stop"));
        assert!(calls_hooky("hooky Stop", "Stop"));
        assert!(!calls_hooky("/opt/hooky Stop", "PreToolUse"));
        assert!(!calls_hooky("bash ~/.claude/hooks/router Stop", "Stop"));
        assert!(!calls_hooky(
            "~/.local/bin/trinket-git-message",
            "PreToolUse"
        ));
        assert!(!calls_hooky("python3 /opt/hooky Stop", "Stop"));
    }

    #[test]
    fn your_settings_list_only_the_hooks_that_skip_hooky() {
        let home = scratch("settings");
        write(
            &home.join(".claude/settings.json"),
            r#"{"hooks": {"Stop": [{"hooks": [
              {"type": "command", "command": "~/.local/bin/hooky Stop"},
              {"type": "command", "command": "./stop.sh"}]}]}}"#,
        );
        let folders = [home.display().to_string()];
        let found = scan(&folders, Harness::Claude, &home);
        assert_eq!(
            found,
            [Outside {
                source: Source::Settings,
                event: "Stop".into(),
                matcher: String::new(),
                command: "./stop.sh".into(),
            }],
            "hooky's own entry is left out, and the home folder is no project"
        );
        assert!(
            scan(&folders, Harness::Codex, &home).is_empty(),
            "Codex's settings file is another"
        );
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_project_s_hooks_list_under_its_repository_s_name() {
        let dir = scratch("repo");
        let app = dir.join("app");
        fs::create_dir_all(app.join(".git")).unwrap();
        write(
            &app.join(".claude/settings.json"),
            r#"{"permissions": {}, "hooks": {"PreToolUse": [
              {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "./guard.sh"}]}]}}"#,
        );
        write(&app.join(".claude/settings.local.json"), STOP);
        fs::create_dir_all(app.join("src/deep")).unwrap();
        let folders = [app.join("src/deep").display().to_string()];
        let found = scan(&folders, Harness::Claude, Path::new("/nowhere"));
        let rows: Vec<(&Source, &str, &str, &str)> = found
            .iter()
            .map(|o| (&o.source, &*o.event, &*o.matcher, &*o.command))
            .collect();
        assert_eq!(
            rows,
            [
                (&project("app"), "PreToolUse", "Edit|Write", "./guard.sh"),
                (&project("app"), "Stop", "", "./stop.sh"),
            ],
            "a subfolder stands for its repository, and both files count"
        );
        assert!(
            scan(&folders, Harness::Codex, Path::new("/nowhere")).is_empty(),
            "Claude's files are not Codex's"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_worktree_goes_by_its_repository_and_shares_its_hooks_once() {
        let dir = scratch("worktree");
        let main = dir.join("solaris");
        fs::create_dir_all(main.join(".git/worktrees/review")).unwrap();
        write(&main.join(".claude/settings.json"), STOP);
        let wt = dir.join("trees/review");
        write(
            &wt.join(".git"),
            &format!("gitdir: {}\n", main.join(".git/worktrees/review").display()),
        );
        write(
            &wt.join(".claude/settings.json"),
            r#"{"hooks": {"Stop": [{"hooks": [
              {"type": "command", "command": "./stop.sh"},
              {"type": "command", "command": "./only-here.sh"}]}]}}"#,
        );
        let folders = [main.display().to_string(), wt.display().to_string()];
        let found = scan(&folders, Harness::Claude, Path::new("/nowhere"));
        let rows: Vec<(&Source, &str)> = found.iter().map(|o| (&o.source, &*o.command)).collect();
        assert_eq!(
            rows,
            [
                (&project("solaris"), "./stop.sh"),
                (&project("solaris"), "./only-here.sh")
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_and_missing_files_add_nothing() {
        let dir = scratch("broken");
        let broken = dir.join("broken");
        fs::create_dir_all(broken.join(".git")).unwrap();
        write(&broken.join(".claude/settings.json"), "{nope");
        let folders = [
            broken.display().to_string(),
            dir.join("gone").display().to_string(),
        ];
        assert!(scan(&folders, Harness::Claude, &dir).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn codex_reads_a_project_s_codex_hooks_file() {
        let dir = scratch("codex");
        fs::create_dir_all(dir.join("tool/.git")).unwrap();
        write(&dir.join("tool/.codex/hooks.json"), STOP);
        let folders = [dir.join("tool").display().to_string()];
        let found = scan(&folders, Harness::Codex, Path::new("/nowhere"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, project("tool"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
