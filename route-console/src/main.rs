//! route-console: a read-only window onto route's event log.
//!
//! It reads the day files route writes and the hooks file route reads, and
//! writes only its own index cache. It never touches `hooks.json` or
//! `state.json`; toggles and replay come later.
//!
//! The list moves only when the reader moves it, or while the reader is at its
//! end. Rows keep loading whatever the reader does; new ones land at the end,
//! below the rows on screen. At the end the list follows them; scrolling up
//! pauses it, and scrolling back down follows again. Picking a row pauses it
//! too, and only the reader changes which row is picked.

mod index;
mod record;
mod sample;
mod theme;
mod view;

use std::ops::Range;
use std::path::PathBuf;
use std::time::Duration;

use rune::{AppSpec, Chrome, Key, KeyEvent, TextEdit, Tx};
use rune_kit::shell::{self, PaneState};

use index::{Index, Row};
use record::Record;

/// How often the window looks for new lines.
const FOLLOW: Duration = Duration::from_millis(500);

/// The event list's keys: the list, its scroll viewport, and the virtual rows
/// inside it, each row keyed by its id.
pub const LIST: &str = "events";
pub const VIEWPORT: &str = "events-viewport";
pub const ROWS: &str = "events-rows";

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

/// The `live` scene's stand-in for route: the sample events again and again,
/// one more each look.
struct Feed {
    samples: Vec<String>,
    next: usize,
}

pub struct App {
    pub paths: Paths,
    pub index: Index,
    /// False in the sample scenes: the index holds sample events, and reading
    /// the day files would mix today's in.
    pub live: bool,
    pub day: String,
    pub screen: Screen,
    pub events: Vec<String>,
    pub search: TextEdit,
    /// The list keeps its end in view, so new rows scroll in at the bottom.
    pub following: bool,
    /// Rows below the viewport, as the list last reported what it shows: the
    /// count on the "↓ N new" pill.
    pub below: usize,
    /// The rows the viewport showed last, by index into `rows`.
    pub visible: Range<usize>,
    /// Take the list to its end on the next frame, and follow from there.
    pub to_end: bool,
    pub rows: Vec<Row>,
    /// The row the reader picked. Only the reader changes it: new rows, a
    /// filter or a search never do.
    pub selected: Option<Selected>,
    pub sidebar: PaneState,
    pub last_look: f64,
    pub error: Option<String>,
    feed: Option<Feed>,
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
            following: true,
            below: 0,
            visible: 0..0,
            to_end: false,
            rows: Vec::new(),
            selected: None,
            sidebar: PaneState::new(220.0).range(180.0, 360.0),
            last_look: f64::NEG_INFINITY,
            error,
            feed: None,
        }
    }

    /// Indexes whatever route appended since the last look. True when new
    /// events came in.
    fn look(&mut self) -> bool {
        if let Some(feed) = &mut self.feed {
            let line = sample::feed(&feed.samples, feed.next);
            feed.next += 1;
            return self
                .index
                .insert_lines(sample::DAY, &[line])
                .is_ok_and(|n| n > 0);
        }
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

    /// Whether a filter or search narrows the list.
    pub fn narrowed(&self) -> bool {
        self.filter().is_some() || !self.search.text.trim().is_empty()
    }

    /// Re-reads the rows for the current day, filter and search. The
    /// selection stays as it is, listed or not.
    pub fn refresh(&mut self) {
        self.rows = self.index.rows(&self.day, self.filter(), &self.search.text);
    }

    fn position(&self, id: i64) -> Option<usize> {
        self.rows.iter().position(|r| r.id == id)
    }

    /// The picked row is out of the list: a filter or search hides it, or the
    /// day has turned.
    pub fn hidden(&self) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|s| self.position(s.id).is_none())
    }

    fn select(&mut self, id: i64) {
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

    /// A row the reader picked, by click or arrow key. Picking any row stops
    /// following, the newest included, so the row holds still while it is read.
    pub fn pick(&mut self, id: i64) {
        self.select(id);
        self.following = false;
    }

    /// A row the reader clicked: picked, and revealed as the arrow keys reveal
    /// theirs, so a row half under an edge scrolls just far enough to show.
    pub fn click(&mut self, id: i64, tx: &mut Tx) {
        self.pick(id);
        // Stopgap: turning `stick_bottom` off leaves Rune's scroll mode Pinned,
        // and `report_visible_rows` and the virtual window read that mode, not
        // `stick_bottom` (rune `runtime/virtual/window.rs:18`,
        // `el/virtual_list.rs:412`), so a click at the end would go on
        // reporting the end and the "↓ N new" pill would never show. A reveal
        // rests the viewport, as it does for the arrow keys. Remove once Rune
        // reads `stick_bottom` there.
        tx.scroll_into_view_in(LIST, id.to_string());
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

    /// The list goes to its newest row and follows from there: End, or the
    /// "↓ N new" pill. The only jumps the list makes.
    pub fn jump_to_end(&mut self) {
        self.following = true;
        self.to_end = true;
    }

    /// The picked row, when it is on screen and the list is paused: the row a
    /// filter change holds in place.
    fn anchor(&self) -> Option<i64> {
        let id = self.selected.as_ref()?.id;
        let i = self.position(id)?;
        (!self.following && self.visible.contains(&i)).then_some(id)
    }

    /// Re-reads the rows after `change`, keeping the picked row where it shows
    /// on screen while rows above it come and go.
    fn narrow(&mut self, change: impl FnOnce(&mut App), tx: &mut Tx) {
        let anchor = self.anchor();
        let before = std::mem::take(&mut self.rows);
        change(self);
        self.refresh();
        // A filter is not a scroll: when it brings the end into view, the
        // list stays paused. Following resumes on the reader's way down only.
        // Rows that come back unchanged (the same screen again, a trailing
        // space) get no new report from the list, so their count stands.
        if self.rows != before {
            self.below = 0;
        }
        if let Some(id) = anchor.filter(|id| self.position(*id).is_some()) {
            tx.keep_on_screen(format!("{ROWS}/{id}"));
        }
    }

    pub fn show(&mut self, screen: Screen, tx: &mut Tx) {
        self.narrow(|s| s.screen = screen, tx);
    }

    /// The search text changed.
    pub fn searched(&mut self, tx: &mut Tx) {
        self.narrow(|_| {}, tx);
    }

    /// The list's keys, as a WAI-ARIA listbox takes them: Up and Down pick the
    /// next row and Home the first, each scrolling only as far as it takes to
    /// show it; Page Up and Page Down scroll. End jumps to the newest row and,
    /// unlike a listbox, leaves the pick alone: the jump is the reader's way
    /// back to following, not a pick.
    pub fn key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        let m = ev.mods;
        if m.cmd || m.ctrl || m.alt || m.logo || m.shift {
            return false;
        }
        match ev.key {
            Key::Up | Key::Down | Key::Home => {
                let id = match ev.key {
                    Key::Home => self.rows.first().map(|r| r.id),
                    _ => self.step(matches!(ev.key, Key::Down)),
                };
                let Some(id) = id else {
                    return false;
                };
                self.pick(id);
                tx.scroll_into_view_in(LIST, id.to_string());
            }
            Key::PageUp => tx.scroll_page(VIEWPORT, -1),
            Key::PageDown => tx.scroll_page(VIEWPORT, 1),
            Key::End => self.jump_to_end(),
            _ => return false,
        }
        true
    }
}

fn poll(s: &mut App, now: f64, tx: &mut Tx) -> bool {
    if std::mem::take(&mut s.to_end) {
        // Instant, so the trip passes no rows that would report the list
        // as scrolled up.
        tx.scroll_to_bottom_instant(VIEWPORT);
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
        s.refresh();
        return true;
    }
    false
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    // With nothing focused, the list takes the keys it takes when focused.
    tx.focused().is_none() && s.key(ev, tx)
}

/// Puts the sample scenes' rows in an index of their own.
fn sample_index(s: &mut App, lines: &[String]) {
    s.live = false;
    s.index = Index::memory();
    s.index
        .insert_lines(sample::DAY, lines)
        .expect("sample lines index");
    s.day = sample::DAY.to_string();
    s.selected = None;
    s.refresh();
}

/// The `canvas` scene: the design canvas's sample events, the newest picked.
fn canvas_scene(s: &mut App) {
    sample_index(s, &sample::lines());
    if let Some(id) = s.rows.last().map(|r| r.id) {
        s.select(id);
    }
}

/// The `live` scene: a list longer than the window that grows by one sample
/// event every look, for headless runs of scrolling and following.
fn live_scene(s: &mut App) {
    let samples = sample::lines();
    let seed: Vec<String> = (0..40).map(|n| sample::feed(&samples, n)).collect();
    sample_index(s, &seed);
    s.feed = Some(Feed { samples, next: 40 });
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
        scenes: &[("canvas", canvas_scene), ("live", live_scene)],
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
    use rune::Mods;

    fn app(scene: fn(&mut App)) -> App {
        let nowhere = PathBuf::from("/nonexistent");
        let paths = Paths {
            config: nowhere.clone(),
            log_dir: nowhere.clone(),
            index: nowhere,
        };
        let mut app = App::new(paths, Index::memory(), None);
        scene(&mut app);
        app
    }

    /// A live list scrolled to its end, twenty rows on screen.
    fn at_end() -> App {
        let mut app = app(live_scene);
        let n = app.rows.len();
        app.seen(n - 20..n);
        assert!(app.following && app.below == 0);
        app
    }

    fn press(app: &mut App, key: Key) -> bool {
        let ev = KeyEvent {
            key,
            mods: Mods::default(),
        };
        app.key(&ev, &mut Tx::default())
    }

    #[test]
    fn nothing_is_picked_until_the_reader_picks_a_row() {
        let mut app = at_end();
        assert!(app.selected.is_none(), "the list opens with nothing picked");
        app.look();
        app.refresh();
        assert!(app.selected.is_none(), "a new row picks nothing");
    }

    #[test]
    fn picking_any_row_pauses_following_the_newest_included() {
        let mut app = at_end();
        let newest = app.rows.last().unwrap().id;
        app.pick(newest);
        assert!(!app.following);
        assert_eq!(app.selected.as_ref().map(|s| s.id), Some(newest));
    }

    #[test]
    fn scrolling_up_pauses_and_rows_keep_arriving_below() {
        let mut app = at_end();
        let n = app.rows.len();
        assert!(app.seen(n - 25..n - 5), "the pill shows");
        assert!(!app.following, "scrolling up pauses");
        assert_eq!(app.below, 5);
        let before = app.rows.clone();
        assert!(app.look());
        app.refresh();
        assert_eq!(app.rows.len(), n + 1, "loading goes on while paused");
        assert_eq!(
            app.rows[..n],
            before[..],
            "the new row lands below the rest"
        );
        app.seen(n - 25..n - 5);
        assert_eq!(app.below, 6, "the pill counts it");
    }

    #[test]
    fn scrolling_back_to_the_end_follows_again_where_it_stands() {
        let mut app = at_end();
        let n = app.rows.len();
        app.seen(n - 25..n - 5);
        app.look();
        app.refresh();
        app.seen(n - 19..n + 1);
        assert!(app.following, "the end follows again");
        assert!(app.to_end, "and pins the list there");
        assert_eq!(app.below, 0);
    }

    /// The app's half of the click stopgap; Rune's half, the viewport leaving
    /// its pinned mode, is checked headless by `scripts/check-route-console.sh`.
    #[test]
    fn a_click_on_the_newest_row_pauses_and_the_pill_counts_new_rows() {
        let mut app = at_end();
        let n = app.rows.len();
        app.click(app.rows[n - 1].id, &mut Tx::default());
        assert!(!app.following, "the click pauses");
        for k in 1..=2 {
            assert!(app.look());
            app.refresh();
            app.seen(n - 20..n);
            assert_eq!(app.below, k, "the pill counts each new row");
            assert!(!app.following);
        }
    }

    #[test]
    fn a_pick_at_the_end_holds_until_the_reader_scrolls_to_new_rows() {
        let mut app = at_end();
        let n = app.rows.len();
        app.pick(app.rows[n - 1].id);
        app.seen(n - 20..n);
        assert!(!app.following, "staying at the end keeps the pause");
        app.look();
        app.refresh();
        app.seen(n - 20..n);
        assert_eq!(app.below, 1, "the new row waits below");
        assert!(!app.following);
        app.seen(n - 19..n + 1);
        assert!(app.following, "scrolling down to it follows again");
    }

    #[test]
    fn end_jumps_to_the_newest_row_and_follows() {
        let mut app = at_end();
        let n = app.rows.len();
        app.pick(app.rows[n - 10].id);
        assert!(press(&mut app, Key::End));
        assert!(app.following && app.to_end);
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(app.rows[n - 10].id),
            "the jump leaves the picked row picked"
        );
    }

    #[test]
    fn arrow_keys_step_from_the_picked_row_or_the_rows_on_screen() {
        let mut app = at_end();
        let n = app.rows.len();
        assert!(press(&mut app, Key::Up));
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(app.rows[n - 1].id),
            "Up with nothing picked picks the last row on screen"
        );
        assert!(!app.following, "and pauses");
        press(&mut app, Key::Up);
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(app.rows[n - 2].id)
        );
        app.selected = None;
        press(&mut app, Key::Down);
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(app.rows[n - 20].id),
            "Down with nothing picked picks the first row on screen"
        );
        press(&mut app, Key::Home);
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(app.rows[0].id),
            "Home picks the first row"
        );
    }

    #[test]
    fn a_filter_that_brings_the_end_into_view_leaves_the_list_paused() {
        let mut app = at_end();
        let n = app.rows.len();
        app.seen(n - 25..n - 5);
        app.show(Screen::Log(Some("Stop".into())), &mut Tx::default());
        let m = app.rows.len();
        app.seen(0..m);
        assert!(!app.following, "only the reader's way down resumes it");
        assert!(!app.to_end, "and nothing jumps");
    }

    #[test]
    fn a_filter_that_changes_no_rows_keeps_the_pill_count() {
        let mut app = at_end();
        let n = app.rows.len();
        app.seen(n - 25..n - 5);
        app.show(Screen::Log(None), &mut Tx::default());
        assert_eq!(app.below, 5, "the same screen again keeps the count");
        app.search.text = " ".into();
        app.searched(&mut Tx::default());
        assert_eq!(app.below, 5, "so does a search of blanks");
    }

    #[test]
    fn a_filter_that_hides_the_picked_row_keeps_it_picked() {
        let mut app = app(canvas_scene);
        let stop = app.rows.iter().find(|r| r.event == "Stop").unwrap().id;
        app.pick(stop);
        let mut tx = Tx::default();
        app.show(Screen::Log(Some("PreToolUse".into())), &mut tx);
        assert_eq!(
            app.selected.as_ref().map(|s| s.id),
            Some(stop),
            "the pick stays"
        );
        assert!(app.hidden(), "and is marked hidden");
        app.search.text = "git".into();
        app.searched(&mut tx);
        assert_eq!(app.selected.as_ref().map(|s| s.id), Some(stop));
        app.search.text.clear();
        app.show(Screen::Log(None), &mut tx);
        assert!(!app.hidden(), "clearing the filter shows it again");
    }
}
