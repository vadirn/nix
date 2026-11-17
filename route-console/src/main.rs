//! route-console: a window onto route's event log and its handlers.
//!
//! It reads the day files route writes and the hooks file route reads, and
//! writes its own index cache and route's `state.json`, the file that switches
//! handlers off. It never writes `hooks.json`, which is edited by hand. Three
//! screens: the Log, whose inspector can replay a Bash call through route;
//! Health, which sums up today's handler failures, timings and log limits;
//! and Handlers, which lists the hooks file's handlers with a switch each.
//!
//! The list moves only when the reader moves it, or while the reader is at its
//! end. Rows keep loading whatever the reader does; new ones land at the end,
//! below the rows on screen. At the end the list follows them; scrolling up
//! pauses it, and scrolling back down follows again. Picking a row pauses it
//! too, and only the reader changes which row is picked.

mod handlers;
mod health;
mod hooks;
mod index;
mod record;
mod replay;
mod sample;
mod theme;
mod view;

use std::ops::Range;
use std::path::PathBuf;
use std::time::Duration;

use rune::{AppSpec, Chrome, Key, KeyEvent, Live, TextEdit, Tx};
use rune_kit::shell::{self, PaneState};
use serde_json::Value;

use hooks::{HandlerId, Hooks, Toggles};
use index::{Index, Issue, IssueKey, Row, Timing};
use record::Record;
use replay::Replay;

/// How often the window looks for new lines.
const FOLLOW: Duration = Duration::from_millis(500);

/// The event list's keys: the list, its scroll viewport, and the virtual rows
/// inside it, each row keyed by its id.
pub const LIST: &str = "events";
pub const VIEWPORT: &str = "events-viewport";
pub const ROWS: &str = "events-rows";

/// Where route keeps its files, found as route finds them
/// (`route/src/main.rs`), where this app keeps its index, and the route
/// binary replay runs: the one Claude Code runs.
pub struct Paths {
    pub config: PathBuf,
    pub state: PathBuf,
    pub log_dir: PathBuf,
    pub index: PathBuf,
    pub route: PathBuf,
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
    /// route's defaults, overridden by `--config`, `--state`, `--log-dir`,
    /// `--index` and `--route`.
    fn from_args(args: &[String]) -> Paths {
        let mut p = Paths {
            config: xdg("XDG_CONFIG_HOME", ".config").join("route/hooks.json"),
            state: xdg("XDG_STATE_HOME", ".local/state").join("route/state.json"),
            log_dir: xdg("XDG_STATE_HOME", ".local/state").join("route/log"),
            index: home().join("Library/Caches/route-console/index.sqlite"),
            route: home().join(".local/libexec/route"),
        };
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let slot = match arg.as_str() {
                "--config" => &mut p.config,
                "--state" => &mut p.state,
                "--log-dir" => &mut p.log_dir,
                "--index" => &mut p.index,
                "--route" => &mut p.route,
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
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Screen {
    Log,
    Health,
    Handlers,
}

/// What the Health screen shows: today's issues and Bash timings.
#[derive(Default)]
pub struct Health {
    pub issues: Vec<Issue>,
    pub timing: Timing,
}

/// How much route's log keeps, from the hooks file's `route.log`, else
/// route's defaults (`route/src/config.rs`, `LogSettings`).
#[derive(Debug, PartialEq)]
pub struct Limits {
    pub retention_days: u64,
    pub max_input_chars: u64,
    pub max_output_chars: u64,
}

impl Limits {
    fn of(hooks: Option<&Value>) -> Limits {
        let n = |key: &str, default: u64| {
            hooks
                .and_then(|v| v.pointer(&format!("/route/log/{key}")))
                .and_then(Value::as_u64)
                .unwrap_or(default)
        };
        Limits {
            retention_days: n("retention_days", 30),
            max_input_chars: n("max_input_chars", 500),
            max_output_chars: n("max_output_chars", 2000),
        }
    }
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
    /// the day files would mix today's in. Their toggles stay in memory, so a
    /// headless run never switches off a live handler.
    pub live: bool,
    pub day: String,
    pub screen: Screen,
    /// The Log's narrowing to one hook event, kept while Health shows.
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
    /// The Handlers screen's narrowing to one hook event. Apart from the
    /// Log's, so a trip to Handlers leaves the Log's rows as they were.
    pub handlers_event: Option<String>,
    /// The last replay, for the event picked when it ran.
    pub replay: Option<Replay>,
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

/// route's hooks file (read, never written).
fn read_hooks(config: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()
}

/// The hook events route handles, from its hooks file.
fn hook_events(hooks: Option<&Value>) -> Vec<String> {
    let keys: Vec<String> = hooks
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
        app.recount();
        app
    }

    fn new(paths: Paths, index: Index, error: Option<String>) -> App {
        let hooks = read_hooks(&paths.config);
        let (toggles, toggles_error) = match Toggles::load(&paths.state) {
            Ok(t) => (t, None),
            Err(e) => (Toggles::default(), Some(e)),
        };
        App {
            events: hook_events(hooks.as_ref()),
            limits: Limits::of(hooks.as_ref()),
            hooks: Hooks::of(hooks.as_ref()),
            toggles,
            handlers_event: None,
            replay: None,
            paths,
            index,
            live: true,
            day: today(),
            screen: Screen::Log,
            event: None,
            issue: None,
            search: TextEdit::new(""),
            following: true,
            below: 0,
            visible: 0..0,
            to_end: false,
            rows: Vec::new(),
            selected: None,
            scroll_y: Live::new(0.0),
            health: Health::default(),
            sidebar: PaneState::new(220.0).range(180.0, 360.0),
            last_look: f64::NEG_INFINITY,
            error: error.or(toggles_error),
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

    /// Whether a filter or search narrows the list.
    pub fn narrowed(&self) -> bool {
        self.event.is_some() || self.issue.is_some() || !self.search.text.trim().is_empty()
    }

    /// Re-reads the rows for the current day, filter and search. The
    /// selection stays as it is, listed or not.
    pub fn refresh(&mut self) {
        self.rows = self.index.rows(
            &self.day,
            self.event.as_deref(),
            &self.search.text,
            self.issue.as_ref(),
        );
    }

    /// Re-reads what the Health screen shows, for the current day.
    pub fn recount(&mut self) {
        self.health = Health {
            issues: self.index.issues(&self.day),
            timing: self.index.timing(&self.day),
        };
    }

    /// Drops the index and builds it again from the day files. Every event
    /// gets a new id, so the picked row is found again by where its line sits.
    pub fn rebuild(&mut self, tx: &mut Tx) {
        tx.instant();
        if !self.live {
            // The sample scenes have no day files to build from.
            return;
        }
        let place = self.selected.as_ref().and_then(|s| self.index.place(s.id));
        if let Err(e) = self.index.rebuild(&self.paths.log_dir) {
            self.error = Some(e);
        }
        match place.and_then(|(day, offset)| self.index.id_at(&day, offset)) {
            Some(id) => {
                if let Some(s) = &mut self.selected {
                    s.id = id;
                }
            }
            None => self.selected = None,
        }
        self.refresh();
        self.recount();
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
        self.replay = None;
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
    ///
    /// Like every change the reader makes here, it lands at once: Rune would
    /// spring heights and bars, fade colours and fade elements in and out.
    /// The commit is instant rather than the elements, so the one motion left,
    /// rune-kit's sidebar sliding open and shut, still carries the content
    /// with it, and a pick made mid-slide leaves the slide running.
    pub fn click(&mut self, id: i64, tx: &mut Tx) {
        tx.instant();
        self.pick(id);
        // Stopgap: turning `stick_bottom` off leaves Rune's scroll mode Pinned,
        // and `report_visible_rows` and the virtual window read that mode, not
        // `stick_bottom` (rune `runtime/virtual/window.rs:18`,
        // `el/virtual_list.rs:412`), so a click at the end would go on
        // reporting the end and the "↓ Latest" pill would never show. A reveal
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
    /// "↓ Latest" pill. The only jumps the list makes.
    pub fn jump_to_end(&mut self, tx: &mut Tx) {
        tx.instant();
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

    /// Shows the Log, its rows re-read after `change`, keeping the picked row
    /// where it shows on screen while rows above it come and go.
    fn narrow(&mut self, change: impl FnOnce(&mut App), tx: &mut Tx) {
        tx.instant();
        let returning = self.screen != Screen::Log;
        let anchor = self.anchor().and_then(|id| Some((id, self.position(id)?)));
        let y = self.scroll_y.get();
        let before = std::mem::take(&mut self.rows);
        self.screen = Screen::Log;
        change(self);
        self.refresh();
        // A filter is not a scroll: when it brings the end into view, the
        // list stays paused. Following resumes on the reader's way down only.
        // Rows that come back unchanged (the same screen again, a trailing
        // space) get no new report from the list, so their count stands.
        if self.rows != before {
            self.below = 0;
        }
        // The picked row is the anchor, as a browser anchors scrolling: its
        // top goes back to the height it had below the viewport's top, placed
        // from the new rows' layout and clamped to the list's ends. Rows are
        // all one height, so where it was is its index times that, less the
        // offset. Rune's `keep_on_screen` measures the drawn row instead and
        // missed by 66 points as the rows above it left.
        if let Some((id, was)) = anchor.filter(|(id, _)| self.position(*id).is_some()) {
            let at = was as f32 * theme::ROW_H - y;
            tx.scroll_key_to(format!("{ROWS}/{id}"), at);
        } else if returning && !self.following {
            // Back from Health, the list mounts afresh: Rune keeps a
            // viewport's offset only while it is in the tree (rune
            // `runtime/commit/prune.rs`). Following, it mounts at its end;
            // paused with no row to hold, it goes back to its offset.
            tx.scroll_to_y(VIEWPORT, y);
        }
    }

    /// The Log, narrowed to one hook event or to none.
    pub fn show_log(&mut self, event: Option<String>, tx: &mut Tx) {
        self.narrow(
            |s| {
                s.event = event;
                s.issue = None;
            },
            tx,
        );
    }

    /// The Log, narrowed to the events of one issue: exactly the rows Health
    /// counts for it, so the search is cleared too.
    pub fn show_issue(&mut self, key: IssueKey, tx: &mut Tx) {
        self.narrow(
            |s| {
                s.event = Some(key.event.clone());
                s.issue = Some(key);
                s.search = TextEdit::new("");
            },
            tx,
        );
    }

    /// The Log's issue filter goes; its hook event stays.
    pub fn clear_issue(&mut self, tx: &mut Tx) {
        self.narrow(|s| s.issue = None, tx);
    }

    /// The Health screen. The Log keeps its rows, filter, pick and place.
    pub fn show_health(&mut self, tx: &mut Tx) {
        tx.instant();
        self.screen = Screen::Health;
    }

    /// The Handlers screen, listing one hook event's handlers or every
    /// event's. The hooks file and `state.json` are read again, since either
    /// may have changed since the last look.
    pub fn show_handlers(&mut self, event: Option<String>, tx: &mut Tx) {
        tx.instant();
        self.screen = Screen::Handlers;
        self.handlers_event = event;
        if self.live {
            self.hooks = Hooks::of(read_hooks(&self.paths.config).as_ref());
            self.reload_toggles();
        }
    }

    /// Reads `state.json` again: another window, or a hand edit, may have
    /// changed it.
    fn reload_toggles(&mut self) {
        match Toggles::load(&self.paths.state) {
            Ok(t) => self.toggles = t,
            Err(e) => self.error = Some(e),
        }
    }

    /// Writes one change to `state.json`, read again first so an edit made
    /// elsewhere stays; the sample scenes keep theirs in memory. route reads
    /// the file on every event, so the next event runs without the handler.
    fn change_toggles(&mut self, tx: &mut Tx, change: impl FnOnce(&mut Toggles)) {
        tx.instant();
        if !self.live {
            change(&mut self.toggles);
            return;
        }
        let (t, error) = Toggles::update(&self.paths.state, change);
        self.toggles = t;
        if error.is_some() {
            self.error = error;
        }
    }

    /// Switches one handler on or off.
    pub fn toggle(&mut self, id: &HandlerId, on: bool, tx: &mut Tx) {
        self.change_toggles(tx, |t| t.set(id, on));
    }

    /// Every handler back on, including entries for handlers the hooks file
    /// no longer lists.
    pub fn enable_all(&mut self, tx: &mut Tx) {
        self.change_toggles(tx, Toggles::clear);
    }

    /// Opens the hooks file in its default app, at the file its links lead
    /// to (home-manager links it out of the store, back to the repo), so an
    /// editor opens the copy that can be edited.
    pub fn open_hooks(&mut self, tx: &mut Tx) {
        tx.instant();
        if !self.live {
            return;
        }
        let path =
            std::fs::canonicalize(&self.paths.config).unwrap_or_else(|_| self.paths.config.clone());
        if let Err(e) = std::process::Command::new("/usr/bin/open")
            .arg(&path)
            .spawn()
        {
            self.error = Some(format!("open {}: {e}", path.display()));
        }
    }

    /// The hooks file replay hands route: the real one, read now, or the
    /// sample scenes' own.
    fn hooks_text(&self) -> Result<String, String> {
        if !self.live {
            return Ok(sample::HOOKS.to_string());
        }
        std::fs::read_to_string(&self.paths.config)
            .map_err(|e| format!("{}: {e}", self.paths.config.display()))
    }

    /// Sends the picked event through route again, with only the built-in
    /// guards on (`replay.rs`), and keeps route's new line beside the logged
    /// one. Guards answer in milliseconds, so it runs on this thread.
    pub fn replay(&mut self, tx: &mut Tx) {
        tx.instant();
        if self.live {
            self.reload_toggles();
        }
        let Some(sel) = &self.selected else {
            return;
        };
        let r = &sel.record;
        let text = self.hooks_text();
        let hooks = Hooks::of(
            text.as_ref()
                .ok()
                .and_then(|t| serde_json::from_str(t).ok())
                .as_ref(),
        );
        let result = replay::payload(r).and_then(|payload| {
            let text = text.clone()?;
            let state = replay::scratch_state(&hooks, &r.event, &self.toggles);
            let line = replay::run(&self.paths.route, &text, &r.event, &payload, &state)?;
            Record::parse(&line).ok_or_else(|| "route's line did not parse".to_string())
        });
        let off = replay::switched_off(&hooks, &r.event, &self.toggles);
        self.replay = Some(Replay {
            id: sel.id,
            result,
            off,
        });
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
            Key::End => self.jump_to_end(tx),
            _ => return false,
        }
        tx.instant();
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
    if s.live && s.screen == Screen::Handlers {
        // `state.json` is small, and another window may write it.
        s.reload_toggles();
    }
    let mut changed = false;
    if s.live && s.day != today() {
        // Midnight: route has started a new file, and the Log follows it.
        s.day = today();
        changed = true;
    }
    if s.look() || changed {
        s.refresh();
        s.recount();
        return true;
    }
    false
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    // With nothing focused, the list takes the keys it takes when focused,
    // while it shows.
    s.screen == Screen::Log && tx.focused().is_none() && s.key(ev, tx)
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
    let hooks = sample::hooks();
    s.events = hook_events(Some(&hooks));
    s.limits = Limits::of(Some(&hooks));
    s.hooks = Hooks::of(Some(&hooks));
    s.toggles = Toggles::default();
    s.refresh();
    s.recount();
}

/// The `canvas` scene: the design canvas's sample events, the newest picked.
fn canvas_scene(s: &mut App) {
    sample_index(s, &sample::lines());
    if let Some(id) = s.rows.last().map(|r| r.id) {
        s.select(id);
    }
}

/// The `health` scene: the canvas's events and some handlers in trouble, on
/// the Health screen.
fn health_scene(s: &mut App) {
    sample_index(s, &sample::trouble_lines());
    s.screen = Screen::Health;
}

/// The `handlers` scene: the canvas's events, on the Handlers screen at
/// PreToolUse, as the Handlers artboard opens.
fn handlers_scene(s: &mut App) {
    sample_index(s, &sample::lines());
    s.screen = Screen::Handlers;
    s.handlers_event = Some("PreToolUse".into());
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
        scenes: &[
            ("canvas", canvas_scene),
            ("live", live_scene),
            ("health", health_scene),
            ("handlers", handlers_scene),
        ],
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

    fn nowhere() -> Paths {
        let nowhere = PathBuf::from("/nonexistent");
        Paths {
            config: nowhere.clone(),
            state: nowhere.join("state.json"),
            log_dir: nowhere.clone(),
            index: nowhere.clone(),
            route: nowhere,
        }
    }

    fn app(scene: fn(&mut App)) -> App {
        let mut app = App::new(nowhere(), Index::memory(), None);
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
        assert_eq!(app.below, 6, "and counts it below");
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
    fn a_click_on_the_newest_row_pauses_and_counts_the_rows_below() {
        let mut app = at_end();
        let n = app.rows.len();
        app.click(app.rows[n - 1].id, &mut Tx::default());
        assert!(!app.following, "the click pauses");
        for k in 1..=2 {
            assert!(app.look());
            app.refresh();
            app.seen(n - 20..n);
            assert_eq!(app.below, k, "each new row counts below");
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
        app.show_log(Some("Stop".into()), &mut Tx::default());
        let m = app.rows.len();
        app.seen(0..m);
        assert!(!app.following, "only the reader's way down resumes it");
        assert!(!app.to_end, "and nothing jumps");
    }

    #[test]
    fn a_filter_that_changes_no_rows_keeps_the_count_below() {
        let mut app = at_end();
        let n = app.rows.len();
        app.seen(n - 25..n - 5);
        app.show_log(None, &mut Tx::default());
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
        app.show_log(Some("PreToolUse".into()), &mut tx);
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
        app.show_log(None, &mut tx);
        assert!(!app.hidden(), "clearing the filter shows it again");
    }

    fn press_window(app: &mut App, key: Key) -> bool {
        let ev = KeyEvent {
            key,
            mods: Mods::default(),
        };
        on_key(app, &ev, &mut Tx::default())
    }

    #[test]
    fn a_trip_to_health_leaves_the_log_as_it_was() {
        let mut app = at_end();
        let n = app.rows.len();
        app.seen(n - 25..n - 5);
        let id = app.rows[n - 10].id;
        app.pick(id);
        app.show_health(&mut Tx::default());
        assert!(
            !press_window(&mut app, Key::Up),
            "the list takes no keys while hidden"
        );
        assert!(!press_window(&mut app, Key::End));
        assert!(app.look(), "rows keep loading");
        app.refresh();
        app.recount();
        app.show_log(None, &mut Tx::default());
        assert_eq!(app.screen, Screen::Log);
        assert_eq!(app.selected.as_ref().map(|s| s.id), Some(id));
        assert!(!app.following && !app.to_end, "it comes back paused");
    }

    #[test]
    fn show_events_lists_what_the_issue_counts_until_the_sidebar_clears_it() {
        let mut app = app(health_scene);
        assert_eq!(app.screen, Screen::Health);
        let issue = app.health.issues[0].clone();
        app.search.text = "git".into();
        let mut tx = Tx::default();
        app.show_issue(issue.key.clone(), &mut tx);
        assert_eq!(app.screen, Screen::Log);
        assert_eq!(app.rows.len(), issue.events, "exactly the rows it counts");
        assert_eq!(app.search.text, "", "a search would hide some");
        app.clear_issue(&mut tx);
        assert!(app.issue.is_none());
        assert_eq!(
            app.event.as_deref(),
            Some("PreToolUse"),
            "the hook event stays"
        );
        assert!(app.rows.len() > issue.events);
        app.show_issue(issue.key.clone(), &mut tx);
        app.show_log(Some("Stop".into()), &mut tx);
        assert!(app.issue.is_none(), "the sidebar clears it");
    }

    #[test]
    fn rebuilding_the_index_finds_the_picked_row_again() {
        let dir =
            std::env::temp_dir().join(format!("route-console-rebuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let day = sample::DAY;
        let lines = sample::trouble_lines().join("\n") + "\n";
        std::fs::write(dir.join(format!("{day}.jsonl")), lines).unwrap();
        let paths = Paths {
            log_dir: dir.clone(),
            ..nowhere()
        };
        // A day with no file takes the first ids, and leaves with the rebuild.
        let mut ix = Index::memory();
        ix.insert_lines("2026-11-15", &sample::lines()).unwrap();
        let mut app = App::new(paths, ix, None);
        app.day = day.to_string();
        app.look();
        app.refresh();
        let row = app.rows[3].clone();
        app.pick(row.id);
        let line = app.selected.as_ref().unwrap().line.clone();
        app.rebuild(&mut Tx::default());
        let picked = app.selected.as_ref().expect("still picked");
        assert_ne!(picked.id, row.id, "every event has a new id");
        assert_eq!(
            app.index.line(picked.id),
            Some(line),
            "the same line is picked"
        );
        assert_eq!(app.health.issues.len(), 4);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn handlers_narrow_apart_from_the_log() {
        let mut app = app(handlers_scene);
        assert_eq!(app.screen, Screen::Handlers);
        assert_eq!(app.handlers_event.as_deref(), Some("PreToolUse"));
        let mut tx = Tx::default();
        app.show_log(Some("Stop".into()), &mut tx);
        app.show_handlers(Some("SessionStart".into()), &mut tx);
        assert_eq!(
            app.event.as_deref(),
            Some("Stop"),
            "the Log keeps its filter"
        );
        app.show_handlers(None, &mut tx);
        assert!(
            app.handlers_event.is_none(),
            "the Handlers row lists every event"
        );
        assert!(
            !press_window(&mut app, Key::Up),
            "the list takes no keys while Handlers shows"
        );
        app.show_log(None, &mut tx);
        assert_eq!(app.screen, Screen::Log);
    }

    #[test]
    fn a_sample_scene_toggles_in_memory_only() {
        let mut app = app(handlers_scene);
        let id = HandlerId::new(
            "PreToolUse",
            "Bash",
            "bash ~/.claude/hooks/rg-glob-guard.sh",
        );
        app.toggle(&id, false, &mut Tx::default());
        assert!(app.toggles.is_off(&id));
        assert_eq!(app.toggles.off_in(&app.hooks), 1);
        assert!(!app.paths.state.exists(), "no state.json is written");
        app.enable_all(&mut Tx::default());
        assert_eq!(app.toggles.off_in(&app.hooks), 0);
    }

    #[test]
    fn a_live_toggle_round_trips_through_state_json() {
        let dir = std::env::temp_dir().join(format!("route-console-toggle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths {
            state: dir.join("route/state.json"),
            ..nowhere()
        };
        let mut app = App::new(paths, Index::memory(), None);
        assert!(app.live);
        let id = HandlerId::new(
            "PreToolUse",
            "Bash",
            "bash ~/.claude/hooks/rg-glob-guard.sh",
        );
        let mut tx = Tx::default();
        app.toggle(&id, false, &mut tx);
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&app.paths.state).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({"disabled": [{"event": "PreToolUse", "matcher": "Bash",
                "command": "bash ~/.claude/hooks/rg-glob-guard.sh"}]}),
            "route's shape and key"
        );
        // Another window switches a second handler off; this one keeps it.
        let other = HandlerId::new("Stop", "", "bash ~/.claude/hooks/stop-verify.sh");
        Toggles::update(&app.paths.state, |t| t.set(&other, false));
        app.toggle(&id, true, &mut tx);
        assert!(app.toggles.is_off(&other) && !app.toggles.is_off(&id));
        app.enable_all(&mut tx);
        assert!(
            Toggles::load(&app.paths.state)
                .unwrap()
                .disabled()
                .is_empty()
        );
        assert!(app.error.is_none(), "{:?}", app.error);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_replay_answers_for_the_event_it_ran_on() {
        let mut app = app(canvas_scene);
        let bash = app
            .rows
            .iter()
            .find(|r| r.tool.as_deref() == Some("Bash"))
            .unwrap()
            .id;
        app.pick(bash);
        app.replay(&mut Tx::default());
        let rp = app.replay.as_ref().expect("a replay");
        assert_eq!(rp.id, bash);
        let err = rp.result.as_ref().unwrap_err();
        assert!(err.contains("/nonexistent"), "no route here: {err}");
        let other = app.rows.iter().find(|r| r.id != bash).unwrap().id;
        app.pick(other);
        assert!(app.replay.is_none(), "a new pick drops it");
    }

    #[test]
    fn log_limits_come_from_the_hooks_file_else_route_s_defaults() {
        let set = serde_json::json!({"route": {"log": {"retention_days": 7}}});
        let l = Limits::of(Some(&set));
        assert_eq!(
            (l.retention_days, l.max_input_chars, l.max_output_chars),
            (7, 500, 2000)
        );
        assert_eq!(Limits::of(None).retention_days, 30);
    }
}
