//! The agent harness that calls hooky: Claude Code or Codex.
//!
//! Both send the same hook JSON and read the same answers, so one binary
//! serves them; `--harness` names the caller. Each harness has its own hooks
//! file and state file, while the log is shared and each line names its
//! harness.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Harness {
    Claude,
    Codex,
}

impl Harness {
    pub fn parse(s: &str) -> Result<Harness, String> {
        match s {
            "claude" => Ok(Harness::Claude),
            "codex" => Ok(Harness::Codex),
            other => Err(format!("unknown harness {other}: expected claude or codex")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
        }
    }

    /// This harness's file `name` in hooky's directory `dir`: Claude's where
    /// it was before hooky served two harnesses, Codex's in `codex/` beside it.
    pub fn file(self, dir: &Path, name: &str) -> PathBuf {
        match self {
            Harness::Claude => dir.join(name),
            Harness::Codex => dir.join("codex").join(name),
        }
    }

    /// The settings file whose `hooks` hand each event to hooky.
    pub fn settings_file(self, home: &Path) -> PathBuf {
        match self {
            Harness::Claude => home.join(".claude/settings.json"),
            Harness::Codex => home.join(".codex/hooks.json"),
        }
    }

    /// What to do after install changed the settings file.
    pub fn reload_hint(self) -> &'static str {
        match self {
            Harness::Claude => {
                "A running Claude Code session may keep its old hooks; start a new one to load these."
            }
            Harness::Codex => {
                "Codex asks you to trust new or changed entries: review them in /hooks."
            }
        }
    }

    /// The arguments a settings entry puts between hooky's path and the event.
    /// Claude Code's entries name none, so they stay as they were.
    pub fn flag(self) -> Option<&'static str> {
        match self {
            Harness::Claude => None,
            Harness::Codex => Some("--harness codex"),
        }
    }

    /// Whether the harness honours `onFailure: "block"`, which denies a call
    /// when hooky cannot start at all. Codex documents no such field.
    pub fn blocks_on_failure(self) -> bool {
        self == Harness::Claude
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_keeps_the_old_paths_and_codex_gets_a_folder() {
        let dir = Path::new("/c/hooky");
        assert_eq!(
            Harness::Claude.file(dir, "hooks.json"),
            Path::new("/c/hooky/hooks.json")
        );
        assert_eq!(
            Harness::Codex.file(dir, "state.json"),
            Path::new("/c/hooky/codex/state.json")
        );
    }

    #[test]
    fn only_the_two_names_parse() {
        assert_eq!(Harness::parse("codex"), Ok(Harness::Codex));
        assert!(Harness::parse("opencode").unwrap_err().contains("opencode"));
    }
}
