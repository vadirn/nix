//! hooky-console: a window onto hooky's event log and its handlers.
//!
//! It reads the day files hooky writes and the hooks files hooky reads, and
//! writes its own index cache and hooky's `state.json` files, which switch
//! handlers off. It never writes a hooks file, which is edited by hand. Each
//! harness hooky serves, Claude Code and Codex, is a space of its own
//! (`space.rs`), switched at the sidebar's foot. Its sidebar picks one page
//! (`Page`): the Log, whose inspector can replay a Bash call through hooky;
//! a hook event's page, the Log of that event alone with the event's
//! handlers and their switches beside it; Health, which sums up today's
//! handler failures, timings and log limits; and Handlers, which lists every
//! event's handlers with a switch each.
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
mod outside;
mod record;
mod replay;
mod sample;
mod space;
mod theme;
mod view;

use std::path::PathBuf;
use std::time::Duration;

use rune::{AppSpec, Chrome, Key, KeyEvent, Spring, TextEdit, Tx};
use rune_kit::shell::{self, PaneState};
use serde_json::Value;

use hooks::{HandlerId, Hooks, Toggles};
use index::{Index, Issue, IssueKey, Timing};
use record::Record;
use replay::Replay;
use space::{Harness, Space};

/// How often the window looks for new lines.
const FOLLOW: Duration = Duration::from_millis(500);

/// The event list's keys: the list, its scroll viewport, and the virtual rows
/// inside it, each row keyed by its id.
pub const LIST: &str = "events";
pub const VIEWPORT: &str = "events-viewport";
pub const ROWS: &str = "events-rows";

/// Where hooky keeps its files, found as hooky finds them
/// (`hooky/src/main.rs`), where this app keeps its index, and the hooky
/// binary replay runs: the one the harnesses run. `config` and `state` are
/// Claude Code's; Codex's sit beside them (`Harness::file`), so a check that
/// points `--state` at a scratch directory keeps both there.
pub struct Paths {
    pub config: PathBuf,
    pub state: PathBuf,
    pub log_dir: PathBuf,
    pub index: PathBuf,
    pub hooky: PathBuf,
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
    /// hooky's defaults, overridden by `--config`, `--state`, `--log-dir`,
    /// `--index` and `--hooky`.
    fn from_args(args: &[String]) -> Paths {
        let mut p = Paths {
            config: xdg("XDG_CONFIG_HOME", ".config").join("hooky/hooks.json"),
            state: xdg("XDG_STATE_HOME", ".local/state").join("hooky/state.json"),
            log_dir: xdg("XDG_STATE_HOME", ".local/state").join("hooky/log"),
            index: home().join("Library/Caches/hooky-console/index.sqlite"),
            hooky: home().join(".local/bin/hooky"),
        };
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let slot = match arg.as_str() {
                "--config" => &mut p.config,
                "--state" => &mut p.state,
                "--log-dir" => &mut p.log_dir,
                "--index" => &mut p.index,
                "--hooky" => &mut p.hooky,
                _ => continue,
            };
            if let Some(v) = it.next() {
                *slot = v.into();
            }
        }
        p
    }

    /// The hooks file hooky reads for one harness.
    pub fn hooks_file(&self, h: Harness) -> PathBuf {
        h.file(&self.config)
    }

    /// The toggles file hooky reads for one harness.
    pub fn state_file(&self, h: Harness) -> PathBuf {
        h.file(&self.state)
    }
}

/// Which screen the main pane shows.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Screen {
    Log,
    Health,
    Handlers,
}

/// The sidebar's pick, one of its rows: a screen, or a hook event's page,
/// which is the Log of that event alone. One value, so one row lights.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page<'a> {
    Log,
    Event(&'a str),
    Health,
    Handlers,
}

/// What the Health screen shows: today's issues and Bash timings.
#[derive(Default)]
pub struct Health {
    pub issues: Vec<Issue>,
    pub timing: Timing,
}

/// How much hooky's log keeps, from the hooks file's `hooky.log`, else
/// hooky's defaults (`hooky/src/config.rs`, `LogSettings`).
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
                .and_then(|v| v.pointer(&format!("/hooky/log/{key}")))
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

/// The `live` scene's stand-in for hooky: the sample events again and again,
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
    /// The space shown.
    pub space: Space,
    /// The other harness's space, as it was left.
    pub parked: Space,
    pub sidebar: PaneState,
    /// The commit a switch makes: the window lands every change at once but
    /// the sidebar contents' slide (`view.rs`, `view`). The next poll clears
    /// it, so the sidebar's own slide open and shut keeps its spring.
    ///
    /// Stopgap: Rune fades in each descendant of a new element, even under a
    /// `Transition::none()` parent (rune `runtime/commit/apply.rs`, where
    /// only `instant_changes` mounts them at once), so the screen a switch
    /// mounts would fade in. Remove once Rune can mount a subtree whole.
    pub switching: bool,
    pub last_look: f64,
    pub error: Option<String>,
    feed: Option<Feed>,
}

/// A hooks file hooky reads (read, never written).
fn read_hooks(config: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// ⌃1 and ⌃2: the spaces, in the order the sidebar's foot shows them. macOS
/// sends ⌃1 as the text "1" with Control held; elsewhere Control is the
/// command key.
fn space_key(ev: &KeyEvent) -> Option<Harness> {
    let m = ev.mods;
    if !m.ctrl || m.shift || m.alt || m.logo {
        return None;
    }
    let digit = match &ev.key {
        Key::Text(t) => t.chars().next().filter(|_| t.chars().count() == 1)?,
        Key::Command(c) => *c,
        _ => return None,
    };
    Harness::ALL
        .into_iter()
        .zip(['1', '2'])
        .find_map(|(h, d)| (d == digit).then_some(h))
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
        app.refresh_all();
        app.recount();
        app
    }

    fn new(paths: Paths, index: Index, error: Option<String>) -> App {
        let mut error = error;
        let mut space = |h: Harness| {
            let toggles = Toggles::load(&paths.state_file(h)).unwrap_or_else(|e| {
                error.get_or_insert(e);
                Toggles::default()
            });
            Space::new(h, read_hooks(&paths.hooks_file(h)).as_ref(), toggles)
        };
        let (claude, codex) = (space(Harness::Claude), space(Harness::Codex));
        App {
            space: claude,
            parked: codex,
            paths,
            index,
            live: true,
            day: today(),
            sidebar: PaneState::new(220.0).range(180.0, 360.0),
            switching: false,
            last_look: f64::NEG_INFINITY,
            error,
            feed: None,
        }
    }

    /// Both spaces, the one shown first.
    fn spaces_mut(&mut self) -> [&mut Space; 2] {
        [&mut self.space, &mut self.parked]
    }

    /// A harness's space, shown or parked.
    pub fn space_of(&self, h: Harness) -> &Space {
        if self.space.harness == h {
            &self.space
        } else {
            &self.parked
        }
    }

    /// Indexes whatever hooky appended since the last look. True when new
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

    /// Re-reads the shown space's rows for the current day, filter and
    /// search. The selection stays as it is, listed or not.
    pub fn refresh(&mut self) {
        self.space.refresh(&self.index, &self.day);
    }

    /// Re-reads both spaces' rows, so the parked one holds what arrived while
    /// it was away, as the Log does while Health shows.
    pub fn refresh_all(&mut self) {
        let (index, day) = (&self.index, &self.day);
        for sp in [&mut self.space, &mut self.parked] {
            sp.refresh(index, day);
        }
    }

    /// Re-reads what both spaces' Health screens show, for the current day:
    /// the parked one's issues mark its icon.
    pub fn recount(&mut self) {
        let (index, day) = (&self.index, &self.day);
        for sp in [&mut self.space, &mut self.parked] {
            sp.recount(index, day);
        }
    }

    /// Drops the index and builds it again from the day files. Every event
    /// gets a new id, so each space's picked row is found again by where its
    /// line sits.
    pub fn rebuild(&mut self, tx: &mut Tx) {
        tx.instant();
        if !self.live {
            // The sample scenes have no day files to build from.
            return;
        }
        let places: Vec<_> = [&self.space, &self.parked]
            .map(|sp| sp.selected.as_ref().and_then(|s| self.index.place(s.id)))
            .into();
        if let Err(e) = self.index.rebuild(&self.paths.log_dir) {
            self.error = Some(e);
        }
        let ids: Vec<Option<i64>> = places
            .into_iter()
            .map(|p| p.and_then(|(day, offset)| self.index.id_at(&day, offset)))
            .collect();
        for (sp, id) in self.spaces_mut().into_iter().zip(ids) {
            match id {
                Some(id) => {
                    if let Some(s) = &mut sp.selected {
                        s.id = id;
                    }
                }
                None => sp.selected = None,
            }
        }
        self.refresh_all();
        self.recount();
    }

    fn select(&mut self, id: i64) {
        let sp = &mut self.space;
        if sp.selected.as_ref().is_some_and(|s| s.id == id) {
            return;
        }
        sp.replay = None;
        sp.selected = self.index.line(id).and_then(|line| {
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
        self.space.following = false;
    }

    /// A row the reader clicked: picked, and revealed as the arrow keys reveal
    /// theirs, so a row half under an edge scrolls just far enough to show.
    ///
    /// Like every change the reader makes here, it lands at once: Rune would
    /// spring heights and bars, fade colours and fade elements in and out.
    /// The commit is instant rather than the elements, so the motion left,
    /// rune-kit's sidebar sliding open and shut and a switch's slide (`switch`),
    /// still carries the content with it, and a pick made mid-slide leaves
    /// the slide running.
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

    /// The list goes to its newest row and follows from there: End, or the
    /// "↓ Latest" pill. The only jumps the list makes.
    pub fn jump_to_end(&mut self, tx: &mut Tx) {
        tx.instant();
        self.space.following = true;
        self.space.to_end = true;
    }

    /// Shows the Log, its rows re-read after `change`, keeping the picked row
    /// where it shows on screen while rows above it come and go.
    fn narrow(&mut self, change: impl FnOnce(&mut Space), tx: &mut Tx) {
        tx.instant();
        let returning = self.space.screen != Screen::Log;
        let sp = &self.space;
        let anchor = sp.anchor().and_then(|id| Some((id, sp.position(id)?)));
        let y = sp.scroll_y.get();
        let before = std::mem::take(&mut self.space.rows);
        self.space.screen = Screen::Log;
        change(&mut self.space);
        self.refresh();
        let sp = &mut self.space;
        // A filter is not a scroll: when it brings the end into view, the
        // list stays paused. Following resumes on the reader's way down only.
        // Rows that come back unchanged (the same screen again, a trailing
        // space) get no new report from the list, so their count stands.
        if sp.rows != before {
            sp.below = 0;
        }
        // The picked row is the anchor, as a browser anchors scrolling: its
        // top goes back to the height it had below the viewport's top, placed
        // from the new rows' layout and clamped to the list's ends. Rows are
        // all one height, so where it was is its index times that, less the
        // offset. Rune's `keep_on_screen` measures the drawn row instead and
        // missed by 66 points as the rows above it left.
        if let Some((id, was)) = anchor.filter(|(id, _)| sp.position(*id).is_some()) {
            let at = was as f32 * theme::ROW_H - y;
            tx.scroll_key_to(format!("{ROWS}/{id}"), at);
        } else if returning {
            self.mount_log(tx);
        }
    }

    /// The Log mounts afresh, back from another screen or into another
    /// space: Rune keeps a viewport's offset only while it is in the tree
    /// (rune `runtime/commit/prune.rs`). Following, it mounts at its end;
    /// paused, it goes back to where the reader left it.
    fn mount_log(&self, tx: &mut Tx) {
        if !self.space.following {
            tx.scroll_to_y(VIEWPORT, self.space.scroll_y.get());
        }
    }

    /// The Log of every event, or one hook event's page.
    pub fn show_log(&mut self, event: Option<String>, tx: &mut Tx) {
        self.narrow(
            |s| {
                s.event = event;
                s.issue = None;
            },
            tx,
        );
        self.reload_switches();
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
        self.reload_switches();
    }

    /// The Log's issue filter goes; its hook event stays.
    pub fn clear_issue(&mut self, tx: &mut Tx) {
        self.narrow(|s| s.issue = None, tx);
    }

    /// The Health screen. The Log keeps its rows, filter, pick and place.
    pub fn show_health(&mut self, tx: &mut Tx) {
        tx.instant();
        self.space.screen = Screen::Health;
    }

    /// The Handlers screen, listing every hook event's handlers.
    pub fn show_handlers(&mut self, tx: &mut Tx) {
        tx.instant();
        self.space.screen = Screen::Handlers;
        self.reload_switches();
    }

    /// Reads the shown space's hooks file and `state.json` again when its
    /// page shows switches: either may have changed since the last look.
    /// The Handlers screen reads the hooks its projects wire again too.
    fn reload_switches(&mut self) {
        if self.live && self.space.shows_switches() {
            let h = self.space.harness;
            self.space.hooks = Hooks::of(read_hooks(&self.paths.hooks_file(h)).as_ref());
            if self.space.screen == Screen::Handlers {
                self.space.outside = outside::scan(&self.index.folders(h), h, &home());
            }
            self.reload_toggles();
        }
    }

    /// The other harness's space, as it was left: the screen it showed, its
    /// Log's rows, filter, pick and place, its Health and its Handlers. The
    /// space shown is parked as it is, as a trip to Health leaves the Log.
    ///
    /// The one commit here that animates, for the sidebar's contents to
    /// slide (`view.rs`, `slide`). The rest lands at once all the same,
    /// colours included.
    pub fn switch(&mut self, h: Harness, tx: &mut Tx) {
        if self.space.harness == h {
            tx.instant();
            return;
        }
        tx.color_motion(Spring::NONE);
        self.switching = true;
        tx.wake_after(Duration::ZERO);
        std::mem::swap(&mut self.space, &mut self.parked);
        self.refresh();
        // Its screen mounts afresh, so the Log goes back to its place.
        if self.space.screen == Screen::Log {
            self.mount_log(tx);
        }
        self.reload_switches();
    }

    /// Reads the shown space's `state.json` again: another window, or a hand
    /// edit, may have changed it.
    fn reload_toggles(&mut self) {
        match Toggles::load(&self.paths.state_file(self.space.harness)) {
            Ok(t) => self.space.toggles = t,
            Err(e) => self.error = Some(e),
        }
    }

    /// Writes one change to the shown space's `state.json`, read again first
    /// so an edit made elsewhere stays; the sample scenes keep theirs in
    /// memory. hooky reads the file on every event, so the next event runs
    /// without the handler.
    fn change_toggles(&mut self, tx: &mut Tx, change: impl FnOnce(&mut Toggles)) {
        tx.instant();
        if !self.live {
            change(&mut self.space.toggles);
            return;
        }
        let (t, error) = Toggles::update(&self.paths.state_file(self.space.harness), change);
        self.space.toggles = t;
        if error.is_some() {
            self.error = error;
        }
    }

    /// Switches one handler on or off.
    pub fn toggle(&mut self, id: &HandlerId, on: bool, tx: &mut Tx) {
        self.change_toggles(tx, |t| t.set(id, on));
    }

    /// Every handler of the shown space back on, including entries for
    /// handlers its hooks file no longer lists. The other space's stay as
    /// they are.
    pub fn enable_all(&mut self, tx: &mut Tx) {
        self.change_toggles(tx, Toggles::clear);
    }

    /// Opens the shown space's hooks file in its default app, at the file
    /// its links lead to (home-manager links it out of the store, back to
    /// the repo), so an editor opens the copy that can be edited.
    pub fn open_hooks(&mut self, tx: &mut Tx) {
        tx.instant();
        if !self.live {
            return;
        }
        let config = self.paths.hooks_file(self.space.harness);
        let path = std::fs::canonicalize(&config).unwrap_or(config);
        if let Err(e) = std::process::Command::new("/usr/bin/open")
            .arg(&path)
            .spawn()
        {
            self.error = Some(format!("open {}: {e}", path.display()));
        }
    }

    /// The hooks file replay hands hooky: the shown space's real one, read
    /// now, or the sample scenes' own.
    fn hooks_text(&self) -> Result<String, String> {
        let h = self.space.harness;
        if !self.live {
            return Ok(sample::hooks_text(h).to_string());
        }
        let config = self.paths.hooks_file(h);
        std::fs::read_to_string(&config).map_err(|e| format!("{}: {e}", config.display()))
    }

    /// Sends the picked event through hooky again, as its harness, with only
    /// the built-in guards on (`replay.rs`), and keeps hooky's new line beside
    /// the logged one. Guards answer in milliseconds, so it runs on this
    /// thread.
    pub fn replay(&mut self, tx: &mut Tx) {
        tx.instant();
        if self.live {
            self.reload_toggles();
        }
        let text = self.hooks_text();
        let sp = &self.space;
        let Some(sel) = &sp.selected else {
            return;
        };
        let r = &sel.record;
        let hooks = Hooks::of(
            text.as_ref()
                .ok()
                .and_then(|t| serde_json::from_str(t).ok())
                .as_ref(),
        );
        let result = replay::payload(r).and_then(|payload| {
            let text = text.clone()?;
            let state = replay::scratch_state(&hooks, &r.event, &sp.toggles);
            let line = replay::run(
                &self.paths.hooky,
                sp.harness,
                &text,
                &r.event,
                &payload,
                &state,
            )?;
            Record::parse(&line).ok_or_else(|| "hooky's line did not parse".to_string())
        });
        let off = replay::switched_off(&hooks, &r.event, &sp.toggles);
        let id = sel.id;
        self.space.replay = Some(Replay { id, result, off });
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
                    Key::Home => self.space.rows.first().map(|r| r.id),
                    _ => self.space.step(matches!(ev.key, Key::Down)),
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
    let switched = std::mem::take(&mut s.switching);
    if std::mem::take(&mut s.space.to_end) {
        // Instant, so the trip passes no rows that would report the list
        // as scrolled up.
        tx.scroll_to_bottom_instant(VIEWPORT);
    }
    tx.wake_after(FOLLOW);
    if now - s.last_look < FOLLOW.as_secs_f64() {
        return switched;
    }
    s.last_look = now;
    if s.live && s.space.shows_switches() {
        // `state.json` is small, and another window may write it.
        s.reload_toggles();
    }
    let mut changed = false;
    if s.live && s.day != today() {
        // Midnight: hooky has started a new file, and the Log follows it.
        s.day = today();
        changed = true;
    }
    if s.look() || changed {
        s.refresh_all();
        s.recount();
        return true;
    }
    switched
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    if let Some(h) = space_key(ev) {
        s.switch(h, tx);
        return true;
    }
    // With nothing focused, the list takes the keys it takes when focused,
    // while it shows.
    s.space.screen == Screen::Log && tx.focused().is_none() && s.key(ev, tx)
}

/// Puts the sample scenes' rows in an index of their own, each space with
/// its harness's sample hooks file.
fn sample_index(s: &mut App, lines: &[String]) {
    s.live = false;
    s.index = Index::memory();
    s.index
        .insert_lines(sample::DAY, lines)
        .expect("sample lines index");
    s.day = sample::DAY.to_string();
    for sp in s.spaces_mut() {
        let hooks = sample::hooks(sp.harness);
        *sp = Space::new(sp.harness, Some(&hooks), Toggles::default());
        sp.outside = sample::outside(sp.harness);
    }
    s.refresh_all();
    s.recount();
}

/// The `canvas` scene: the design canvas's sample events, the newest picked.
fn canvas_scene(s: &mut App) {
    sample_index(s, &sample::lines());
    if let Some(id) = s.space.rows.last().map(|r| r.id) {
        s.select(id);
    }
}

/// The `health` scene: the canvas's events and some handlers in trouble, on
/// the Health screen.
fn health_scene(s: &mut App) {
    sample_index(s, &sample::trouble_lines());
    s.space.screen = Screen::Health;
}

/// The `handlers` scene: the canvas's events, on the Handlers screen.
fn handlers_scene(s: &mut App) {
    sample_index(s, &sample::lines());
    s.space.screen = Screen::Handlers;
}

/// The `live` scene: a list longer than the window that grows by one sample
/// event every look, for headless runs of scrolling and following.
fn live_scene(s: &mut App) {
    let samples = sample::lines();
    let seed: Vec<String> = (0..40).map(|n| sample::feed(&samples, n)).collect();
    sample_index(s, &seed);
    s.feed = Some(Feed { samples, next: 40 });
}

/// The `spaces` scene: the `live` scene's Claude Code list, growing, beside
/// the design's Codex events, one of them with a handler in trouble.
fn spaces_scene(s: &mut App) {
    let samples = sample::lines();
    let mut seed: Vec<String> = (0..40).map(|n| sample::feed(&samples, n)).collect();
    seed.extend(sample::codex_lines());
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
            ("spaces", spaces_scene),
        ],
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        poll: Some(poll),
        on_key: Some(on_key),
        ..AppSpec::new("Hooky Console", (1280.0, 880.0), App::init, view::view)
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
            hooky: nowhere,
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
        let n = app.space.rows.len();
        app.space.seen(n - 20..n);
        assert!(app.space.following && app.space.below == 0);
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
        assert!(
            app.space.selected.is_none(),
            "the list opens with nothing picked"
        );
        app.look();
        app.refresh();
        assert!(app.space.selected.is_none(), "a new row picks nothing");
    }

    #[test]
    fn picking_any_row_pauses_following_the_newest_included() {
        let mut app = at_end();
        let newest = app.space.rows.last().unwrap().id;
        app.pick(newest);
        assert!(!app.space.following);
        assert_eq!(app.space.selected.as_ref().map(|s| s.id), Some(newest));
    }

    #[test]
    fn scrolling_up_pauses_and_rows_keep_arriving_below() {
        let mut app = at_end();
        let n = app.space.rows.len();
        assert!(app.space.seen(n - 25..n - 5), "the pill shows");
        assert!(!app.space.following, "scrolling up pauses");
        assert_eq!(app.space.below, 5);
        let before = app.space.rows.clone();
        assert!(app.look());
        app.refresh();
        assert_eq!(app.space.rows.len(), n + 1, "loading goes on while paused");
        assert_eq!(
            app.space.rows[..n],
            before[..],
            "the new row lands below the rest"
        );
        app.space.seen(n - 25..n - 5);
        assert_eq!(app.space.below, 6, "and counts it below");
    }

    #[test]
    fn scrolling_back_to_the_end_follows_again_where_it_stands() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.space.seen(n - 25..n - 5);
        app.look();
        app.refresh();
        app.space.seen(n - 19..n + 1);
        assert!(app.space.following, "the end follows again");
        assert!(app.space.to_end, "and pins the list there");
        assert_eq!(app.space.below, 0);
    }

    /// The app's half of the click stopgap; Rune's half, the viewport leaving
    /// its pinned mode, is checked headless by `scripts/check-hooky-console.sh`.
    #[test]
    fn a_click_on_the_newest_row_pauses_and_counts_the_rows_below() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.click(app.space.rows[n - 1].id, &mut Tx::default());
        assert!(!app.space.following, "the click pauses");
        for k in 1..=2 {
            assert!(app.look());
            app.refresh();
            app.space.seen(n - 20..n);
            assert_eq!(app.space.below, k, "each new row counts below");
            assert!(!app.space.following);
        }
    }

    #[test]
    fn a_pick_at_the_end_holds_until_the_reader_scrolls_to_new_rows() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.pick(app.space.rows[n - 1].id);
        app.space.seen(n - 20..n);
        assert!(!app.space.following, "staying at the end keeps the pause");
        app.look();
        app.refresh();
        app.space.seen(n - 20..n);
        assert_eq!(app.space.below, 1, "the new row waits below");
        assert!(!app.space.following);
        app.space.seen(n - 19..n + 1);
        assert!(app.space.following, "scrolling down to it follows again");
    }

    #[test]
    fn end_jumps_to_the_newest_row_and_follows() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.pick(app.space.rows[n - 10].id);
        assert!(press(&mut app, Key::End));
        assert!(app.space.following && app.space.to_end);
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(app.space.rows[n - 10].id),
            "the jump leaves the picked row picked"
        );
    }

    #[test]
    fn arrow_keys_step_from_the_picked_row_or_the_rows_on_screen() {
        let mut app = at_end();
        let n = app.space.rows.len();
        assert!(press(&mut app, Key::Up));
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(app.space.rows[n - 1].id),
            "Up with nothing picked picks the last row on screen"
        );
        assert!(!app.space.following, "and pauses");
        press(&mut app, Key::Up);
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(app.space.rows[n - 2].id)
        );
        app.space.selected = None;
        press(&mut app, Key::Down);
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(app.space.rows[n - 20].id),
            "Down with nothing picked picks the first row on screen"
        );
        press(&mut app, Key::Home);
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(app.space.rows[0].id),
            "Home picks the first row"
        );
    }

    #[test]
    fn a_filter_that_brings_the_end_into_view_leaves_the_list_paused() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.space.seen(n - 25..n - 5);
        app.show_log(Some("Stop".into()), &mut Tx::default());
        let m = app.space.rows.len();
        app.space.seen(0..m);
        assert!(
            !app.space.following,
            "only the reader's way down resumes it"
        );
        assert!(!app.space.to_end, "and nothing jumps");
    }

    #[test]
    fn a_filter_that_changes_no_rows_keeps_the_count_below() {
        let mut app = at_end();
        let n = app.space.rows.len();
        app.space.seen(n - 25..n - 5);
        app.show_log(None, &mut Tx::default());
        assert_eq!(app.space.below, 5, "the same screen again keeps the count");
        app.space.search.text = " ".into();
        app.searched(&mut Tx::default());
        assert_eq!(app.space.below, 5, "so does a search of blanks");
    }

    #[test]
    fn a_filter_that_hides_the_picked_row_keeps_it_picked() {
        let mut app = app(canvas_scene);
        let stop = app
            .space
            .rows
            .iter()
            .find(|r| r.event == "Stop")
            .unwrap()
            .id;
        app.pick(stop);
        let mut tx = Tx::default();
        app.show_log(Some("PreToolUse".into()), &mut tx);
        assert_eq!(
            app.space.selected.as_ref().map(|s| s.id),
            Some(stop),
            "the pick stays"
        );
        assert!(app.space.hidden(), "and is marked hidden");
        app.space.search.text = "git".into();
        app.searched(&mut tx);
        assert_eq!(app.space.selected.as_ref().map(|s| s.id), Some(stop));
        app.space.search.text.clear();
        app.show_log(None, &mut tx);
        assert!(!app.space.hidden(), "clearing the filter shows it again");
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
        let n = app.space.rows.len();
        app.space.seen(n - 25..n - 5);
        let id = app.space.rows[n - 10].id;
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
        assert_eq!(app.space.screen, Screen::Log);
        assert_eq!(app.space.selected.as_ref().map(|s| s.id), Some(id));
        assert!(
            !app.space.following && !app.space.to_end,
            "it comes back paused"
        );
    }

    #[test]
    fn show_events_lists_what_the_issue_counts_until_the_sidebar_clears_it() {
        let mut app = app(health_scene);
        assert_eq!(app.space.screen, Screen::Health);
        let issue = app.space.health.issues[0].clone();
        app.space.search.text = "git".into();
        let mut tx = Tx::default();
        app.show_issue(issue.key.clone(), &mut tx);
        assert_eq!(app.space.screen, Screen::Log);
        assert_eq!(
            app.space.rows.len(),
            issue.events,
            "exactly the rows it counts"
        );
        assert_eq!(app.space.search.text, "", "a search would hide some");
        app.clear_issue(&mut tx);
        assert!(app.space.issue.is_none());
        assert_eq!(
            app.space.event.as_deref(),
            Some("PreToolUse"),
            "the hook event stays"
        );
        assert!(app.space.rows.len() > issue.events);
        app.show_issue(issue.key.clone(), &mut tx);
        app.show_log(Some("Stop".into()), &mut tx);
        assert!(app.space.issue.is_none(), "the sidebar clears it");
    }

    #[test]
    fn rebuilding_the_index_finds_the_picked_row_again() {
        let dir =
            std::env::temp_dir().join(format!("hooky-console-rebuild-{}", std::process::id()));
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
        let row = app.space.rows[3].clone();
        app.pick(row.id);
        let line = app.space.selected.as_ref().unwrap().line.clone();
        app.rebuild(&mut Tx::default());
        let picked = app.space.selected.as_ref().expect("still picked");
        assert_ne!(picked.id, row.id, "every event has a new id");
        assert_eq!(
            app.index.line(picked.id),
            Some(line),
            "the same line is picked"
        );
        assert_eq!(app.space.health.issues.len(), 4);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hook_event_opens_its_own_page_from_any_screen() {
        let mut app = app(handlers_scene);
        assert_eq!(app.space.page(), Page::Handlers);
        assert!(
            !press_window(&mut app, Key::Up),
            "the list takes no keys while Handlers shows"
        );
        let mut tx = Tx::default();
        app.show_log(Some("Stop".into()), &mut tx);
        assert_eq!(
            app.space.page(),
            Page::Event("Stop"),
            "not Handlers narrowed"
        );
        assert!(app.space.rows.iter().all(|r| r.event == "Stop"));
        assert!(app.space.shows_switches(), "its handlers' switches show");
        app.show_health(&mut tx);
        assert_eq!(app.space.page(), Page::Health);
        app.show_log(Some("PreToolUse".into()), &mut tx);
        assert_eq!(app.space.page(), Page::Event("PreToolUse"));
        app.show_handlers(&mut tx);
        assert_eq!(app.space.page(), Page::Handlers, "every event's handlers");
        app.show_log(None, &mut tx);
        assert_eq!(app.space.page(), Page::Log);
        assert!(!app.space.shows_switches());
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
        assert!(app.space.toggles.is_off(&id));
        assert_eq!(app.space.toggles.off_in(&app.space.hooks), 1);
        assert!(!app.paths.state.exists(), "no state.json is written");
        app.enable_all(&mut Tx::default());
        assert_eq!(app.space.toggles.off_in(&app.space.hooks), 0);
    }

    #[test]
    fn a_live_toggle_round_trips_through_state_json() {
        let dir = std::env::temp_dir().join(format!("hooky-console-toggle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths {
            state: dir.join("hooky/state.json"),
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
            "hooky's shape and key"
        );
        // Another window switches a second handler off; this one keeps it.
        let other = HandlerId::new("Stop", "", "bash ~/.claude/hooks/stop-verify.sh");
        Toggles::update(&app.paths.state, |t| t.set(&other, false));
        app.toggle(&id, true, &mut tx);
        assert!(app.space.toggles.is_off(&other) && !app.space.toggles.is_off(&id));
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
            .space
            .rows
            .iter()
            .find(|r| r.tool.as_deref() == Some("Bash"))
            .unwrap()
            .id;
        app.pick(bash);
        app.replay(&mut Tx::default());
        let rp = app.space.replay.as_ref().expect("a replay");
        assert_eq!(rp.id, bash);
        let err = rp.result.as_ref().unwrap_err();
        assert!(err.contains("/nonexistent"), "no hooky here: {err}");
        let other = app.space.rows.iter().find(|r| r.id != bash).unwrap().id;
        app.pick(other);
        assert!(app.space.replay.is_none(), "a new pick drops it");
    }

    #[test]
    fn log_limits_come_from_the_hooks_file_else_hooky_s_defaults() {
        let set = serde_json::json!({"hooky": {"log": {"retention_days": 7}}});
        let l = Limits::of(Some(&set));
        assert_eq!(
            (l.retention_days, l.max_input_chars, l.max_output_chars),
            (7, 500, 2000)
        );
        assert_eq!(Limits::of(None).retention_days, 30);
    }

    #[test]
    fn a_trip_to_codex_leaves_claude_s_log_as_it_was() {
        let mut app = app(spaces_scene);
        let n = app.space.rows.len();
        assert_eq!(n, 40, "Claude Code's space lists only its own rows");
        app.space.seen(n - 25..n - 5);
        let id = app.space.rows[n - 10].id;
        app.pick(id);
        let mut tx = Tx::default();
        app.switch(Harness::Codex, &mut tx);
        assert_eq!(app.space.harness, Harness::Codex);
        assert_eq!(app.space.rows.len(), sample::codex_lines().len());
        assert!(app.space.selected.is_none() && app.space.following);
        assert_eq!(
            app.space.events.last().map(String::as_str),
            Some("Interrupt")
        );
        let codex_row = app.space.rows[0].id;
        app.pick(codex_row);
        assert!(
            app.look(),
            "rows keep loading while Claude Code's space is parked"
        );
        app.refresh_all();
        app.switch(Harness::Claude, &mut tx);
        assert_eq!(app.space.screen, Screen::Log);
        assert_eq!(app.space.selected.as_ref().map(|s| s.id), Some(id));
        assert!(
            !app.space.following && !app.space.to_end,
            "it comes back paused"
        );
        assert_eq!(app.space.rows.len(), n + 1, "with what arrived meanwhile");
        assert_eq!(
            app.parked.selected.as_ref().map(|s| s.id),
            Some(codex_row),
            "and Codex's pick waits in its own space"
        );
    }

    #[test]
    fn a_parked_space_s_issues_are_counted_for_its_icon() {
        let mut app = app(spaces_scene);
        let names = |issues: &[Issue]| issues.iter().map(|i| i.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&app.space.health.issues), ["no-secrets.sh"]);
        let codex = &app.space_of(Harness::Codex).health.issues;
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].name, "direnv-env.py");
        app.switch(Harness::Codex, &mut Tx::default());
        assert_eq!(app.space.health.issues.len(), 1, "Health shows Codex's");
    }

    #[test]
    fn each_space_comes_back_on_the_screen_it_was_left_on() {
        let mut app = app(spaces_scene);
        let mut tx = Tx::default();
        app.show_health(&mut tx);
        app.switch(Harness::Codex, &mut tx);
        assert_eq!(app.space.screen, Screen::Log, "Codex opens on its own Log");
        app.show_log(Some("Stop".into()), &mut tx);
        app.switch(Harness::Claude, &mut tx);
        assert_eq!(app.space.page(), Page::Health, "Claude Code's Health waits");
        app.show_log(None, &mut tx);
        app.switch(Harness::Codex, &mut tx);
        assert_eq!(app.space.page(), Page::Event("Stop"), "and Codex's Stop");
        app.show_handlers(&mut tx);
        app.switch(Harness::Claude, &mut tx);
        assert_eq!(app.space.page(), Page::Log);
        app.switch(Harness::Codex, &mut tx);
        assert_eq!(app.space.page(), Page::Handlers);
    }

    #[test]
    fn control_1_and_2_switch_spaces_from_any_screen() {
        let mut app = app(health_scene);
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        let key = |key| KeyEvent { key, mods: ctrl };
        assert!(on_key(
            &mut app,
            &key(Key::Text("2".into())),
            &mut Tx::default()
        ));
        assert_eq!(app.space.harness, Harness::Codex);
        assert!(on_key(
            &mut app,
            &key(Key::Command('1')),
            &mut Tx::default()
        ));
        assert_eq!(app.space.harness, Harness::Claude);
        let plain = KeyEvent {
            key: Key::Text("2".into()),
            mods: Mods::default(),
        };
        assert!(space_key(&plain).is_none(), "a 2 typed alone is text");
    }

    #[test]
    fn a_switch_lands_the_rest_at_once_for_its_own_commit_only() {
        let mut app = app(spaces_scene);
        app.switch(Harness::Codex, &mut Tx::default());
        assert!(app.switching, "the switch's commit lands all but the slide");
        // Within a look of the last, so only the switch asks for a commit.
        app.last_look = 1.0;
        assert!(poll(&mut app, 1.0, &mut Tx::default()));
        assert!(
            !app.switching,
            "the next poll clears it, so the sidebar's own slide keeps its spring"
        );
        assert!(!poll(&mut app, 1.0, &mut Tx::default()));
        app.switch(Harness::Codex, &mut Tx::default());
        assert!(!app.switching, "a switch to the space shown is none");
    }

    #[test]
    fn each_space_switches_its_own_handlers() {
        let dir = std::env::temp_dir().join(format!("hooky-console-spaces-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let paths = Paths {
            state: dir.join("hooky/state.json"),
            ..nowhere()
        };
        let mut app = App::new(paths, Index::memory(), None);
        let claude = HandlerId::new("PreToolUse", "Bash", "bash ~/.claude/hooks/no-secrets.sh");
        let codex = HandlerId::new("Stop", "", "~/.local/bin/trinket-codex-stop");
        let mut tx = Tx::default();
        app.toggle(&claude, false, &mut tx);
        app.switch(Harness::Codex, &mut tx);
        assert!(
            !app.space.toggles.is_off(&claude),
            "Codex has its own switches"
        );
        app.toggle(&codex, false, &mut tx);
        let codex_state = dir.join("hooky/codex/state.json");
        assert!(Toggles::load(&codex_state).unwrap().is_off(&codex));
        app.enable_all(&mut tx);
        assert!(Toggles::load(&codex_state).unwrap().disabled().is_empty());
        let claude_state = Toggles::load(&app.paths.state).unwrap();
        assert!(
            claude_state.is_off(&claude) && !claude_state.is_off(&codex),
            "Enable all clears only the space shown"
        );
        app.switch(Harness::Claude, &mut tx);
        assert!(app.space.toggles.is_off(&claude));
        assert!(app.error.is_none(), "{:?}", app.error);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
