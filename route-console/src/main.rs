//! route-console: a read-only window onto route's event log.
//!
//! It reads the day files route writes and the hooks file route reads, and
//! writes only its own index cache. It never touches `hooks.json` or
//! `state.json`; toggles and replay come later.

mod index;
mod record;
mod sample;
mod theme;
mod view;

use std::path::PathBuf;
use std::time::Duration;

use rune::{AppSpec, Chrome, KeyEvent, TextEdit, Tx};
use rune_kit::TableState;
use rune_kit::shell::{self, PaneState};

use index::{Index, Row};
use record::Record;

/// How often the window looks for new lines.
const FOLLOW: Duration = Duration::from_millis(500);

/// The event table's key, which scrolling to a row names.
const TABLE: &str = "events";

/// Where route keeps its files, found as route finds them
/// (`route/src/main.rs`), and where this app keeps its index.
pub struct Paths {
    pub config: PathBuf,
    pub log_dir: PathBuf,
    pub index: PathBuf,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/".into())
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(fallback),
    }
}

impl Paths {
    /// route's defaults, overridden by `--config`, `--log-dir` and `--index`.
    fn from_args(args: &[String]) -> Paths {
        let mut p = Paths {
            config: xdg("XDG_CONFIG_HOME", ".config").join("route/hooks.json"),
            log_dir: xdg("XDG_STATE_HOME", ".local/state").join("route/log"),
            index: home().join("Library/Caches/route-console/index.sqlite"),
        };
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let slot = match arg.as_str() {
                "--config" => &mut p.config,
                "--log-dir" => &mut p.log_dir,
                "--index" => &mut p.index,
                _ => continue,
            };
            if let Some(v) = it.next() {
                *slot = v.into();
            }
        }
        p
    }
}

/// Which screen the main pane shows.
#[derive(Clone, PartialEq, Debug)]
pub enum Screen {
    /// The Log, narrowed to one hook event or not.
    Log(Option<String>),
}

pub struct Selected {
    pub id: i64,
    pub line: String,
    pub record: Record,
}

pub struct App {
    pub paths: Paths,
    pub index: Index,
    /// False in the sample scene: the index holds the canvas's events, and
    /// following would mix today's in.
    pub live: bool,
    pub day: String,
    pub screen: Screen,
    pub events: Vec<String>,
    pub search: TextEdit,
    /// Scroll the newest row into view on the next frame. The list reads
    /// oldest first, as a tail does, so a new event lands below the rest and no
    /// row above it moves or changes stripe; following keeps the end in view.
    pub reveal: bool,
    pub following: bool,
    pub rows: Vec<Row>,
    pub table: TableState,
    pub selected: Option<Selected>,
    pub sidebar: PaneState,
    pub last_look: f64,
    pub error: Option<String>,
}

/// Hook events in the order the sidebar lists them: Claude Code's busiest
/// first, as the design orders them. Events the hooks file adds that are not
/// here follow, in the file's order.
const EVENT_ORDER: [&str; 11] = [
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

/// The hook events route handles, from its hooks file (read, never written).
fn hook_events(config: &std::path::Path) -> Vec<String> {
    let keys: Vec<String> = std::fs::read_to_string(config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("hooks")?
                .as_object()
                .map(|m| m.keys().cloned().collect())
        })
        .unwrap_or_else(|| EVENT_ORDER.iter().map(|s| s.to_string()).collect());
    let rank = |e: &String| {
        EVENT_ORDER
            .iter()
            .position(|x| x == e)
            .unwrap_or(EVENT_ORDER.len())
    };
    let mut sorted = keys;
    sorted.sort_by_key(rank);
    sorted
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

impl App {
    fn init() -> App {
        let paths = Paths::from_args(rune::extra_args());
        let (index, error) = match Index::open(&paths.index) {
            Ok(ix) => (ix, None),
            Err(e) => (Index::memory(), Some(format!("index: {e}; kept in memory"))),
        };
        let mut app = App::new(paths, index, error);
        app.look();
        app.refresh();
        app
    }

    fn new(paths: Paths, index: Index, error: Option<String>) -> App {
        App {
            events: hook_events(&paths.config),
            paths,
            index,
            live: true,
            day: today(),
            screen: Screen::Log(None),
            search: TextEdit::new(""),
            reveal: false,
            following: true,
            rows: Vec::new(),
            table: TableState::new().key(TABLE),
            selected: None,
            sidebar: PaneState::new(220.0).range(180.0, 360.0),
            last_look: f64::NEG_INFINITY,
            error,
        }
    }

    /// Indexes whatever route appended since the last look. True when new
    /// events came in.
    fn look(&mut self) -> bool {
        if !self.live {
            return false;
        }
        match self.index.sync(&self.paths.log_dir) {
            Ok(n) => n > 0,
            Err(e) => {
                self.error = Some(e);
                false
            }
        }
    }

    pub fn filter(&self) -> Option<&str> {
        match &self.screen {
            Screen::Log(e) => e.as_deref(),
        }
    }

    /// Re-reads the rows for the current day, filter and search, and keeps
    /// the selection while its row is still listed, else selects the newest.
    pub fn refresh(&mut self) {
        self.rows = self.index.rows(&self.day, self.filter(), &self.search.text);
        self.reveal = self.following;
        let keep = self
            .selected
            .as_ref()
            .map(|s| s.id)
            .filter(|id| self.rows.iter().any(|r| r.id == *id));
        match keep.or_else(|| self.rows.last().map(|r| r.id)) {
            Some(id) => self.select(id),
            None => {
                self.selected = None;
                self.table.clear_selection();
            }
        }
    }

    pub fn select(&mut self, id: i64) {
        self.table.select(id.to_string());
        if self.selected.as_ref().is_some_and(|s| s.id == id) {
            return;
        }
        self.selected = self.index.line(id).and_then(|line| {
            Some(Selected {
                id,
                record: Record::parse(&line)?,
                line,
            })
        });
    }

    /// A row the user chose, by click or arrow key. Choosing an older row
    /// stops following, so new events no longer pull the list to its end
    /// while that row is read; choosing the newest row follows again, as a
    /// terminal resumes when scrolled back to the bottom.
    pub fn pick(&mut self, id: i64) {
        self.select(id);
        let newest = self.rows.last().map(|r| r.id) == Some(id);
        if newest != self.following {
            self.toggle_following();
        }
    }

    pub fn show(&mut self, screen: Screen) {
        self.screen = screen;
        self.refresh();
    }

    pub fn toggle_following(&mut self) {
        self.following = !self.following;
        if self.following {
            self.refresh();
        }
    }
}

fn poll(s: &mut App, now: f64, tx: &mut Tx) -> bool {
    if std::mem::take(&mut s.reveal)
        && let Some(newest) = s.rows.last()
    {
        tx.scroll_into_view_in(TABLE, newest.id.to_string());
    }
    tx.wake_after(FOLLOW);
    if now - s.last_look < FOLLOW.as_secs_f64() {
        return false;
    }
    s.last_look = now;
    let mut changed = false;
    if s.live && s.day != today() {
        // Midnight: route has started a new file, and the Log follows it.
        s.day = today();
        changed = true;
    }
    if s.look() || changed {
        if s.following {
            s.refresh();
        }
        return true;
    }
    false
}

fn on_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    false
}

/// The `canvas` scene: the design canvas's sample events, the newest selected.
fn canvas_scene(s: &mut App) {
    s.live = false;
    s.index = Index::memory();
    s.index
        .insert_lines(sample::DAY, &sample::lines())
        .expect("sample lines index");
    s.day = sample::DAY.to_string();
    s.selected = None;
    s.refresh();
}

fn main() {
    // The traffic lights sit in the 48-point band across the top of the
    // sidebar, as the design draws them.
    let chrome = Chrome {
        full_size_content: true,
        traffic_lights: Some((16.0, 18.0)),
        drag_regions: true,
    };
    rune::App::new(AppSpec {
        min_size: Some((900.0, 560.0)),
        scenes: &[("canvas", canvas_scene)],
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        poll: Some(poll),
        on_key: Some(on_key),
        ..AppSpec::new("Route Console", (1280.0, 880.0), App::init, view::view)
    })
    .chrome(chrome)
    .run();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_app() -> App {
        let nowhere = PathBuf::from("/nonexistent");
        let paths = Paths {
            config: nowhere.clone(),
            log_dir: nowhere.clone(),
            index: nowhere,
        };
        let mut app = App::new(paths, Index::memory(), None);
        canvas_scene(&mut app);
        app
    }

    #[test]
    fn picking_an_older_row_pauses_following_and_the_newest_resumes_it() {
        let mut app = sample_app();
        let ids: Vec<i64> = app.rows.iter().map(|r| r.id).collect();
        let newest = *ids.last().unwrap();
        assert!(app.following);
        assert_eq!(app.selected.as_ref().map(|s| s.id), Some(newest));
        app.pick(ids[2]);
        assert!(!app.following, "an older row pauses");
        assert_eq!(app.selected.as_ref().map(|s| s.id), Some(ids[2]));
        app.pick(newest);
        assert!(app.following, "the newest row resumes");
        assert!(app.reveal, "and the end comes back into view");
    }
}
