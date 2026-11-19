//! Spaces: the window shows one harness at a time, the agent that ran route
//! for a line (`route/src/harness.rs`), as an Arc-style space. A space holds
//! the page it shows and everything its pages show: its Log's rows, hook
//! event, pick and place, its Health, its hooks file's handlers and switches,
//! and its hook events. The log and its index are one for both; each line
//! names its harness.

use std::ops::Range;
use std::path::{Path, PathBuf};

use rune::{Live, TextEdit};
use serde_json::Value;

use crate::hooks::{Hooks, Toggles};
use crate::index::{Index, IssueKey, Row};
use crate::replay::Replay;
use crate::{Health, Limits, Page, Screen, Selected};

/// The agent that called route.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Harness {
    Claude,
    Codex,
}

/// Claude Code's hook events in the order the sidebar lists them: the
/// busiest first, as the design orders them. Events a hooks file adds that
/// are not here follow, in the file's order.
const CLAUDE_EVENTS: [&str; 11] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionStart",
    "CwdChanged",
    "SessionEnd",
    "Notification",
    "TaskCompleted",
];

/// Codex's, as the design's Codex space lists them.
const CODEX_EVENTS: [&str; 5] = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "Interrupt",
];

impl Harness {
    /// In the order the sidebar's foot shows them, and ⌃1 and ⌃2 pick them.
    pub const ALL: [Harness; 2] = [Harness::Claude, Harness::Codex];

    /// A log line's `harness`. A line without one is Claude Code's: route
    /// wrote none before it served two harnesses. A name route does not write
    /// is no harness, and its line shows in no space.
    pub fn parse(name: Option<&str>) -> Option<Harness> {
        match name {
            None | Some("claude") => Some(Harness::Claude),
            Some("codex") => Some(Harness::Codex),
            Some(_) => None,
        }
    }

    /// The name route logs and takes after `--harness`.
    pub fn name(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
        }
    }

    /// The space's name, as the sidebar shows it.
    pub fn title(self) -> &'static str {
        match self {
            Harness::Claude => "Claude Code",
            Harness::Codex => "Codex",
        }
    }

    /// This harness's copy of one of route's files, given Claude Code's:
    /// Claude's is that file, Codex's sits in `codex/` beside it, as route
    /// finds them.
    pub fn file(self, claude: &Path) -> PathBuf {
        match self {
            Harness::Claude => claude.to_path_buf(),
            Harness::Codex => {
                let dir = claude.parent().unwrap_or(Path::new(""));
                dir.join("codex")
                    .join(claude.file_name().unwrap_or_default())
            }
        }
    }

    /// What route is told before the event to run as this harness: nothing
    /// for Claude Code, route's default, as its settings entries say it.
    pub fn args(self) -> &'static [&'static str] {
        match self {
            Harness::Claude => &[],
            Harness::Codex => &["--harness", "codex"],
        }
    }

    fn event_order(self) -> &'static [&'static str] {
        match self {
            Harness::Claude => &CLAUDE_EVENTS,
            Harness::Codex => &CODEX_EVENTS,
        }
    }

    /// The hook events route handles for this harness, from its hooks file,
    /// else every event this harness has.
    pub fn hook_events(self, hooks: Option<&Value>) -> Vec<String> {
        let order = self.event_order();
        let mut events: Vec<String> = hooks
            .and_then(|v| {
                v.get("hooks")?
                    .as_object()
                    .map(|m| m.keys().cloned().collect())
            })
            .unwrap_or_else(|| order.iter().map(|s| s.to_string()).collect());
        events.sort_by_key(|e| order.iter().position(|x| x == e).unwrap_or(order.len()));
        events
    }
}

/// One harness's space.
pub struct Space {
    pub harness: Harness,
    /// The screen this space shows, kept while the other space shows, as
    /// the sidebar's pick in it is.
    pub screen: Screen,
    /// The Log's hook event: with one, the Log is that event's page
    /// (`Page::Event`). Kept while Health or Handlers shows, so the rows a
    /// trip there leaves are the rows it comes back to.
    pub event: Option<String>,
    /// The Log's narrowing to one handler's trouble, from Health's "Show
    /// events". Cleared by the sidebar.
    pub issue: Option<IssueKey>,
    pub events: Vec<String>,
    pub search: TextEdit,
    /// The list keeps its end in view, so new rows scroll in at the bottom.
    pub following: bool,
    /// Rows below the viewport, as the list last reported what it shows: the
    /// "↓ Latest" pill shows while there are any.
    pub below: usize,
    /// The rows the viewport showed last, by index into `rows`.
    pub visible: Range<usize>,
    /// Take the list to its end on the next frame, and follow from there.
    pub to_end: bool,
    pub rows: Vec<Row>,
    /// The row the reader picked. Only the reader changes it: new rows, a
    /// filter or a search never do.
    pub selected: Option<Selected>,
    /// Where the Log's viewport is scrolled, as Rune last drew it.
    pub scroll_y: Live<f32>,
    pub health: Health,
    pub limits: Limits,
    /// The hooks file's handlers, as the Handlers screen lists them.
    pub hooks: Hooks,
    /// `state.json`, as last read or written.
    pub toggles: Toggles,
    /// The last replay, for the event picked when it ran.
    pub replay: Option<Replay>,
}

impl Space {
    pub fn new(harness: Harness, hooks: Option<&Value>, toggles: Toggles) -> Space {
        Space {
            harness,
            screen: Screen::Log,
            event: None,
            issue: None,
            events: harness.hook_events(hooks),
            search: TextEdit::new(""),
            following: true,
            below: 0,
            visible: 0..0,
            to_end: false,
            rows: Vec::new(),
            selected: None,
            scroll_y: Live::new(0.0),
            health: Health::default(),
            limits: Limits::of(hooks),
            hooks: Hooks::of(hooks),
            toggles,
            replay: None,
        }
    }

    /// The sidebar's row this space has picked.
    pub fn page(&self) -> Page<'_> {
        match (self.screen, self.event.as_deref()) {
            (Screen::Log, None) => Page::Log,
            (Screen::Log, Some(e)) => Page::Event(e),
            (Screen::Health, _) => Page::Health,
            (Screen::Handlers, _) => Page::Handlers,
        }
    }

    /// Whether the page shows handlers' switches, whose hooks file and
    /// `state.json` are read again while it does.
    pub fn shows_switches(&self) -> bool {
        matches!(self.page(), Page::Handlers | Page::Event(_))
    }

    /// Re-reads the rows for `day`, this space's filter and search. The
    /// selection stays as it is, listed or not.
    pub fn refresh(&mut self, index: &Index, day: &str) {
        self.rows = index.rows(
            day,
            self.harness,
            self.event.as_deref(),
            &self.search.text,
            self.issue.as_ref(),
        );
    }

    /// Re-reads what the Health screen shows, for `day`.
    pub fn recount(&mut self, index: &Index, day: &str) {
        self.health = Health {
            issues: index.issues(day, self.harness),
            timing: index.timing(day, self.harness),
        };
    }

    /// Whether a filter or search narrows the list.
    pub fn narrowed(&self) -> bool {
        self.event.is_some() || self.issue.is_some() || !self.search.text.trim().is_empty()
    }

    pub fn position(&self, id: i64) -> Option<usize> {
        self.rows.iter().position(|r| r.id == id)
    }

    /// The picked row is out of the list: a filter or search hides it, or the
    /// day has turned.
    pub fn hidden(&self) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|s| self.position(s.id).is_none())
    }

    /// The row an arrow key moves to: the next one down or up from the picked
    /// row, or, with none picked or the picked one hidden, the first or last
    /// row on screen.
    pub fn step(&self, down: bool) -> Option<i64> {
        let last = self.rows.len().checked_sub(1)?;
        let at = self.selected.as_ref().and_then(|s| self.position(s.id));
        let i = match at {
            Some(i) if down => (i + 1).min(last),
            Some(i) => i.saturating_sub(1),
            None if down => self.visible.start.min(last),
            None => self.visible.end.saturating_sub(1).min(last),
        };
        Some(self.rows[i].id)
    }

    /// The list reported the rows its viewport shows. Rows below it stop the
    /// following; coming back down to the end follows again, pinned where it
    /// stands, so the reader steers by scrolling alone. A pick made at the end
    /// holds until rows arrive below it and the reader scrolls to them. True
    /// when something the view shows changed.
    pub fn seen(&mut self, rows: Range<usize>) -> bool {
        let below = self.rows.len().saturating_sub(rows.end);
        let was = std::mem::replace(&mut self.below, below);
        let following = self.following;
        self.visible = rows;
        if below > 0 {
            self.following = false;
        } else if was > 0 && !self.following {
            self.following = true;
            self.to_end = true;
        }
        was != below || following != self.following
    }

    /// The picked row, when it is on screen and the list is paused: the row a
    /// filter change holds in place.
    pub fn anchor(&self) -> Option<i64> {
        let id = self.selected.as_ref()?.id;
        let i = self.position(id)?;
        (!self.following && self.visible.contains(&i)).then_some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_s_files_sit_in_codex_beside_claude_s() {
        let claude = Path::new("/c/route/state.json");
        assert_eq!(Harness::Claude.file(claude), claude);
        assert_eq!(
            Harness::Codex.file(claude),
            Path::new("/c/route/codex/state.json")
        );
    }

    #[test]
    fn a_line_without_a_harness_is_claude_s_and_an_unknown_one_is_none() {
        assert_eq!(Harness::parse(None), Some(Harness::Claude));
        assert_eq!(Harness::parse(Some("codex")), Some(Harness::Codex));
        assert_eq!(Harness::parse(Some("opencode")), None);
    }

    #[test]
    fn each_harness_orders_its_own_events() {
        let codex = serde_json::json!({"hooks": {"Interrupt": [], "Stop": [], "PreToolUse": []}});
        assert_eq!(
            Harness::Codex.hook_events(Some(&codex)),
            ["PreToolUse", "Stop", "Interrupt"]
        );
        assert_eq!(Harness::Codex.hook_events(None), CODEX_EVENTS);
        assert_eq!(Harness::Claude.hook_events(None), CLAUDE_EVENTS);
    }
}
