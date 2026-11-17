//! The window, laid out as the design canvas's Log artboard: rune-kit's shell
//! with a sidebar of screens and hook events, a toolbar band, and a framed
//! card holding the event list beside the inspector, or the Health screen
//! (`health.rs`), or the Handlers screen (`handlers.rs`).
//!
//! The canvas reaches Handlers through the sidebar's hook events; here they
//! narrow the Log, as Health's "Show events" needs, so Handlers has a row of
//! its own and the hook events act on the screen shown (decided 2026-11-17).
//!
//! The list is built on Rune's virtual rows, not rune-kit's Table: the Table's
//! viewport never sticks to its end and reports nothing about what it shows,
//! and following a tail needs both.

use std::borrow::Cow;

use rune::{
    Align, Anim, Cx, El, GrowthSpec, Icon, KeyEvent, ScrollPos, ScrollSpec, Transition, Tx, col,
    el, row, text,
};
use rune_kit::shell::{SidebarRow, SidebarToggle, SplitView, Toolbar};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Sidebar, TableStyle,
    TextInput,
};

use crate::index::Row;
use crate::record::{Handler, Record, Trouble, short_name};
use crate::replay::{Comparison, Replay};
use crate::theme::{Tint, Tokens, tint_of, ty};
use crate::{App, LIST, ROWS, Screen, Selected, VIEWPORT};

static LOG_ICON: Icon = Icon {
    name: "rc-list",
    view: 16.0,
    body: r#"<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>"#,
};
static PULSE: Icon = Icon {
    name: "rc-pulse",
    view: 16.0,
    body: r#"<path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};
static CLOSE: Icon = Icon {
    name: "rc-close",
    view: 16.0,
    body: r#"<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>"#,
};
static BOLT: Icon = Icon {
    name: "rc-bolt",
    view: 16.0,
    body: r#"<path d="M9 1.75 3.5 9H8l-1 5.25L12.5 7H8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>"#,
};
static SEARCH: Icon = Icon {
    name: "rc-search",
    view: 16.0,
    body: r#"<circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="m10.5 10.5 3.25 3.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>"#,
};
static SWITCHES: Icon = Icon {
    name: "rc-switches",
    view: 16.0,
    body: r#"<rect x="1.75" y="4.25" width="12.5" height="7.5" rx="3.75" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="10.25" cy="8" r="1.75" stroke="currentColor" stroke-width="1.5" fill="none"/>"#,
};
static REPLAY: Icon = Icon {
    name: "rc-replay",
    view: 16.0,
    body: r#"<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};
static COPY: Icon = Icon {
    name: "rc-copy",
    view: 16.0,
    body: r#"<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" fill="none"/>"#,
};

/// The inspector's width, as the canvas lays it out at 1280 points.
const INSPECTOR_W: f32 = 340.0;

/// A built-in guard's microseconds, else milliseconds.
pub fn time_label(h: &Handler) -> String {
    match (h.us, h.ms) {
        (Some(us), _) if us < 1000 => format!("{us} µs"),
        (Some(us), _) => format!("{:.1} ms", us as f64 / 1000.0),
        (None, Some(ms)) => ms_label(ms),
        (None, None) => "—".into(),
    }
}

pub fn ms_label(ms: u64) -> String {
    if ms >= 1000 {
        format!("{:.2} s", ms as f64 / 1000.0)
    } else {
        format!("{ms} ms")
    }
}

/// A tinted word: a verdict, a handler's result, or `stderr`.
pub fn badge(t: &Tokens, word: &str) -> El {
    badge_in(t, word, tint_of(word))
}

pub fn badge_in(t: &Tokens, word: &str, tint: Tint) -> El {
    let (bg, fg) = t.badge(tint);
    row()
        .role("status")
        .label(word.to_string())
        .h(20.0)
        .px(7.0)
        .radius(6.0)
        .fill(bg)
        .center()
        .child(
            text(word.to_string())
                .font(ty::LABEL)
                .color(fg)
                .a11y_hidden(),
        )
}

pub fn rule(t: &Tokens) -> El {
    el().w_full().h(1.0).fill(t.separator).a11y_hidden()
}

/// A grouped list: rounded, filled, its rows parted by rules. Health's
/// issues, timings and limits, and Handlers' matcher groups.
pub fn group(t: &Tokens, label: &str, rows: impl IntoIterator<Item = El>) -> El {
    rows.into_iter().enumerate().fold(
        col()
            .role("list")
            .label(label.to_string())
            .w_full()
            .radius(10.0)
            .fill(t.group)
            .border(1.0, t.card_border)
            .clip_rounded(10.0),
        |g, (i, r)| {
            let r = r.role("listitem");
            if i == 0 {
                g.child(r)
            } else {
                g.child(rule(t)).child(r)
            }
        },
    )
}

pub fn quiet_row(t: &Tokens, words: &str) -> El {
    row().w_full().min_h(36.0).px(14.0).center_y().child(
        text(words.to_string())
            .font(ty::BODY)
            .color(t.text_secondary),
    )
}

/// The toolbar's title, with the error badge when the index or the log
/// could not be read.
pub fn leading(s: &App, t: &Tokens, title: String) -> El {
    let mut leading = row()
        .gap(8.0)
        .center_y()
        .child(text(title).font(ty::TITLE).color(t.text));
    if let Some(e) = &s.error {
        leading = leading.child(badge(t, "error").help(e.clone()));
    }
    leading
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let t = Tokens::new(cx.system_dark());
    let k = t.kit();
    let (toolbar, main) = match s.screen {
        Screen::Log => (log_toolbar(s, &k, &t), log(s, &k, &t)),
        Screen::Health => (
            crate::health::toolbar(s, &k, &t),
            crate::health::screen(s, &k, &t),
        ),
        Screen::Handlers => (
            crate::handlers::toolbar(s, &k, &t),
            crate::handlers::screen(s, &k, &t),
        ),
    };
    SplitView::new(main)
        .sidebar(
            &s.sidebar,
            |s: &mut App| &mut s.sidebar,
            sidebar(s, &t, &t.sidebar_kit(&k)),
        )
        .toolbar(toolbar)
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .sidebar_padding(10.0, 10.0)
        .sidebar_toggle(SidebarToggle::new().in_header())
        .reduced_motion(cx.is_reduced_motion())
        .build(&k)
        // Hover comes and goes at once, as every change the reader makes does
        // (`App::click`); Rune would fade it out over 0.1 s. Hover tracks only,
        // so the sidebar's slide keeps its spring.
        .hover_motion_within(Anim::INSTANT, Anim::INSTANT)
}

fn log_toolbar(s: &App, k: &Kit, t: &Tokens) -> Toolbar {
    let title = s.event.clone().unwrap_or_else(|| "Log".to_string());
    let mut toolbar = Toolbar::new().leading(leading(s, t, title));
    if let Some(chip) = issue_filter(s, k, t) {
        toolbar = toolbar.trailing(chip);
    }
    toolbar.trailing(search(s, k, t))
}

fn log(s: &App, k: &Kit, t: &Tokens) -> El {
    // The pill floats over the list's foot, beside the grid rather than in
    // it, so a screen reader meets a button, not a cell.
    let events = col()
        .key("events-stack")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .child(list(s, k, t).w_full().grow(1.0).min_h(0.0))
        .children(pill(s, k));
    col().key("log").w_full().h_full().child(rule(t)).child(
        row()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(events)
            .child(el().w(1.0).h_full().fill(t.separator).a11y_hidden())
            .child(inspector(s, k, t)),
    )
}

fn sidebar(s: &App, t: &Tokens, k: &Kit) -> El {
    let on_log = s.screen == Screen::Log;
    let log = SidebarRow::new("Log")
        .icon(&LOG_ICON)
        .height(30.0)
        .selected(on_log && s.event.is_none())
        .on_select(|s: &mut App, tx| s.show_log(None, tx))
        .build(k)
        .key("screen-log");
    let n = s.health.issues.len();
    let mut health = SidebarRow::new("Health")
        .icon(&PULSE)
        .height(30.0)
        .selected(s.screen == Screen::Health)
        .on_select(|s: &mut App, tx| s.show_health(tx));
    if n > 0 {
        health = health.trailing(badge_in(t, &n.to_string(), Tint::Orange).label(if n == 1 {
            "1 issue".into()
        } else {
            format!("{n} issues")
        }));
    }
    let on_handlers = s.screen == Screen::Handlers;
    let handlers = SidebarRow::new("Handlers")
        .icon(&SWITCHES)
        .height(30.0)
        .selected(on_handlers && s.handlers_event.is_none())
        .on_select(|s: &mut App, tx| s.show_handlers(None, tx))
        .build(k)
        .key("screen-handlers");
    let screens = col()
        .w_full()
        .child(log)
        .child(health.build(k).key("screen-health"))
        .child(handlers);
    // A hook event narrows the screen shown: the Log's rows, or the
    // handlers listed. From Health it opens the Log.
    let events = s.events.iter().map(|e| {
        let event = e.clone();
        let picked = (on_log && s.event.as_deref() == Some(e))
            || (on_handlers && s.handlers_event.as_deref() == Some(e));
        SidebarRow::new(e.clone())
            .icon(&BOLT)
            .height(30.0)
            .selected(picked)
            .on_select(move |s: &mut App, tx| {
                if s.screen == Screen::Handlers {
                    s.show_handlers(Some(event.clone()), tx)
                } else {
                    s.show_log(Some(event.clone()), tx)
                }
            })
            .build(k)
            .key(format!("event-{e}"))
    });
    events
        .fold(
            Sidebar::new()
                .label("Sidebar")
                .inset(0.0)
                .header_padding(6.0, 16.0)
                .row_gap(0.0)
                .header(screens),
            |sb, r| sb.child(r),
        )
        .build(k)
}

fn search(s: &App, k: &Kit, t: &Tokens) -> El {
    let field = TextInput::new(&s.search)
        .plain()
        .leading_icon(&SEARCH)
        .leading_icon_size(14.0)
        .placeholder("Search")
        .label("Search events")
        .width(None)
        .height(28.0)
        .on_edit(|s: &mut App| &mut s.search)
        .on_change(|s: &mut App, tx| s.searched(tx))
        .build(k);
    row()
        .key("search")
        .w(200.0)
        .h(28.0)
        .radius(8.0)
        .fill(t.fill)
        .center_y()
        .child(field)
}

/// The Log narrowed to one issue from Health: the handler and its trouble,
/// with a button that clears it.
fn issue_filter(s: &App, k: &Kit, t: &Tokens) -> Option<El> {
    let issue = s.issue.as_ref()?;
    let what = match issue.kind {
        Trouble::Failed => "failures",
        Trouble::Stderr => "stderr",
    };
    let words = format!("{} {what}", short_name(&issue.command));
    let clear = IconButton::new(&CLOSE)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label("Clear the issue filter")
        .help("Clear the issue filter")
        .on_press_tx(|s: &mut App, tx| s.clear_issue(tx))
        .build(k)
        .key("clear-issue");
    Some(
        row()
            .key("issue-filter")
            .role("group")
            .label(format!("Only {words}"))
            .h(28.0)
            .pl(10.0)
            .pr(2.0)
            .gap(4.0)
            .radius(8.0)
            .fill(t.fill)
            .center_y()
            .child(
                text(words)
                    .font(ty::BODY)
                    .color(t.text)
                    .truncate()
                    .max_w(220.0)
                    .a11y_hidden(),
            )
            .child(clear),
    )
}

/// "↓ Latest", while rows lie below the viewport, floating centred 16 points
/// above the list's foot. Pressing it jumps to the newest row and follows from
/// there, as End does. It names where it goes, not how far: the rows below
/// are not all new, since scrolling up puts old rows there too. It comes and
/// goes at once, as everything but the sidebar does.
fn pill(s: &App, k: &Kit) -> Option<El> {
    (s.below > 0).then(|| {
        let button = Button::new("↓ Latest")
            .variant(ButtonVariant::Contrast)
            .help("Jump to the newest event (End)")
            .on_press_tx(|s: &mut App, tx| s.jump_to_end(tx))
            .build(k)
            .key("to-end")
            .radius(999.0)
            .pin(None, None, None, Some(16.0))
            .self_center()
            .transition(Transition::none());
        k.elevate(button, &k.elevation.floating)
    })
}

/// A list column: its id, title, width (`None` takes what the others leave),
/// and alignment.
struct Column {
    id: &'static str,
    title: &'static str,
    width: Option<f32>,
    align: Align,
}

/// The canvas's columns. Time is 10 points wider than its text needs, for the
/// 16-point inset the design gives the first column.
const COLUMNS: [Column; 6] = [
    Column {
        id: "time",
        title: "Time",
        width: Some(86.0),
        align: Align::Start,
    },
    Column {
        id: "event",
        title: "Event",
        width: Some(136.0),
        align: Align::Start,
    },
    Column {
        id: "tool",
        title: "Tool",
        width: Some(152.0),
        align: Align::Start,
    },
    Column {
        id: "input",
        title: "Input",
        width: None,
        align: Align::Start,
    },
    Column {
        id: "decision",
        title: "Decision",
        width: Some(136.0),
        align: Align::Start,
    },
    Column {
        id: "took",
        title: "Took",
        width: Some(72.0),
        align: Align::End,
    },
];

/// A header or row cell, sized to its column.
fn cell(c: &Column, first: bool, pad: f32) -> El {
    let e = row()
        .h_full()
        .pl(if first { 16.0 } else { pad })
        .pr(pad)
        .center_y()
        .clip_soft(0.0);
    let e = match c.width {
        Some(w) => e.w(w),
        None => e.w(0.0).grow(1.0).shrink().min_w(120.0),
    };
    if matches!(c.align, Align::End) {
        e.justify_end()
    } else {
        e
    }
}

fn header(style: &TableStyle) -> El {
    let rule = el()
        .pin(Some(0.0), None, Some(0.0), Some(0.0))
        .h(1.0)
        .fill(style.rule)
        .a11y_hidden();
    let last = COLUMNS.len() - 1;
    COLUMNS.iter().enumerate().fold(
        row()
            .key("header")
            .role("row")
            .w_full()
            .h(style.header_height)
            .child(rule),
        |h, (j, c)| {
            let mut cell = cell(c, j == 0, style.cell_pad)
                .key(c.id)
                .role("columnheader")
                .label(c.title)
                .child(
                    text(c.title)
                        .font(style.header_font)
                        .color(style.header_text)
                        .truncate()
                        .shrink()
                        .min_w(0.0)
                        .a11y_hidden(),
                );
            if j != last {
                cell = cell.child(
                    el().pin(None, Some(8.0), Some(0.0), Some(8.0))
                        .w(1.0)
                        .fill(style.rule)
                        .a11y_hidden(),
                );
            }
            h.child(cell)
        },
    )
}

fn content(r: &Row, column: &str, style: &TableStyle, t: &Tokens) -> El {
    let plain = |s: String, mono: bool, muted: bool| {
        text(s.clone())
            .font(if mono { style.mono } else { style.font })
            .color(if muted { style.muted } else { style.text })
            .truncate()
            .shrink()
            .min_w(0.0)
            .help_when_truncated(s)
    };
    match column {
        "time" => plain(r.time.clone(), true, true),
        "event" => plain(r.event.clone(), false, false),
        "tool" => plain(r.tool.clone().unwrap_or_else(|| "—".into()), false, false),
        // One line per row: a multi-line command reads as its words, the
        // inspector keeps the line breaks.
        "input" => plain(
            r.input
                .as_deref()
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            true,
            false,
        ),
        "decision" => row()
            .gap(4.0)
            .center_y()
            .children(r.verdict.as_deref().map(|v| badge(t, v)))
            .children(r.stderr.then(|| badge(t, "stderr"))),
        _ => plain(r.ms.map(ms_label).unwrap_or_default(), true, true).align(Align::End),
    }
}

/// Row `i`. Stripes go by position, so rows appended below keep theirs; its
/// press finds the row by id, never by `i`.
fn event_row(s: &App, i: usize, style: &TableStyle, t: &Tokens) -> El {
    let r = &s.rows[i];
    let id = r.id;
    let picked = s.selected.as_ref().is_some_and(|x| x.id == id);
    let hover = style.stripe.mix(style.selected, 0.5);
    let e = row()
        .role("row")
        .focus_selected(picked)
        .w_full()
        .h(style.row_height)
        .center_y();
    let e = if picked {
        e.fill(style.selected)
    } else if i % 2 == 1 {
        e.fill(style.stripe).hover(hover)
    } else {
        e.hover(hover)
    };
    COLUMNS
        .iter()
        .enumerate()
        .fold(e, |e, (j, c)| {
            e.child(
                cell(c, j == 0, style.cell_pad)
                    .role("gridcell")
                    .child(content(r, c.id, style, t)),
            )
        })
        .on_press_tx(move |s: &mut App, tx| s.click(id, tx))
}

/// The event list: Rune's virtual rows in a viewport that sticks to its end
/// while the list follows. The rows report what the viewport shows, which is
/// how scrolling pauses and resumes the following and shows the pill.
fn list(s: &App, k: &Kit, t: &Tokens) -> El {
    let style = t.table(k);
    let tk = *t;
    let scroll_y = s.scroll_y.clone();
    let rows = col()
        .key(ROWS)
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            s.rows.len(),
            style.row_height,
            |s: &App, i| Cow::Owned(s.rows[i].id.to_string()),
            move |s: &App, i| event_row(s, i, &style, &tk),
        )
        .on_visible_rows(|s: &mut App, r| s.seen(r));
    let viewport = col()
        .key(VIEWPORT)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: s.following,
        })
        // Where the picked row shows, for a filter to hold it there, and
        // where to come back to from Health, which mounts the list afresh.
        .on_scroll_offset(move |at: ScrollPos| {
            scroll_y.set(at.offset[1]);
        })
        .child(rows);
    let list = col()
        .key(LIST)
        .role("grid")
        .label("Events")
        .focusable(true)
        .w_full()
        .clip_soft(0.0)
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| s.key(ev, tx))
        .child(header(&style))
        .child(viewport);
    match s.selected.as_ref().filter(|_| !s.hidden()) {
        Some(sel) => list.active_descendant(sel.id.to_string()),
        None => list,
    }
}

fn inspector(s: &App, k: &Kit, t: &Tokens) -> El {
    let body = match &s.selected {
        Some(sel) => col()
            .w_full()
            .children(s.hidden().then(|| hidden_note(s, t)))
            .child(details(
                sel,
                s.replay.as_ref().filter(|r| r.id == sel.id),
                k,
                t,
            )),
        None => col().w_full().px(16.0).py(14.0).child(
            text("Pick an event to see its handlers.")
                .font(ty::NOTE)
                .color(t.text_secondary),
        ),
    };
    col()
        .key("inspector")
        .role("complementary")
        .label("Inspector")
        .w(INSPECTOR_W)
        .h_full()
        .fill(t.inspector)
        .child(
            col()
                .key("inspector-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(body),
        )
}

/// Marks a picked row the list no longer shows. The inspector keeps it rather
/// than jumping to another row.
fn hidden_note(s: &App, t: &Tokens) -> El {
    let why = if s.narrowed() {
        "Hidden by the filter"
    } else {
        "No longer in today's list"
    };
    row().key("hidden").w_full().px(16.0).pt(12.0).child(
        row()
            .h(22.0)
            .px(8.0)
            .radius(6.0)
            .fill(t.fill)
            .center_y()
            .child(text(why).font(ty::NOTE).color(t.text_secondary)),
    )
}

/// A boxed block of text: the input, or stderr. Like all inspector text it
/// wraps anywhere: JSON and paths carry tokens wider than the panel.
pub fn block(content: String, fill: rune::Color, border: rune::Color, t: &Tokens) -> El {
    col()
        .w_full()
        .px(12.0)
        .py(10.0)
        .radius(8.0)
        .fill(fill)
        .border(1.0, border)
        .child(
            text(content)
                .font(ty::MONO_BLOCK)
                .color(t.text)
                .wrap_anywhere()
                .selectable(true),
        )
}

fn details(sel: &Selected, replay: Option<&Replay>, k: &Kit, t: &Tokens) -> El {
    let r: &Record = &sel.record;
    let why_not = crate::replay::payload(r).err();
    let replay_button = IconButton::new(&REPLAY)
        .variant(IconButtonVariant::GhostMuted)
        .label("Replay through route")
        .help(
            why_not
                .clone()
                .unwrap_or_else(|| "Replay through route, built-in guards only".to_string()),
        )
        .disabled(why_not.is_some())
        .on_press_tx(|s: &mut App, tx| s.replay(tx))
        .build(k)
        .key("replay");
    let copy = IconButton::new(&COPY)
        .variant(IconButtonVariant::GhostMuted)
        .label("Copy JSONL line")
        .help("Copy JSONL line")
        .on_press_tx(|s: &mut App, tx| {
            if let Some(sel) = &s.selected {
                tx.copy(sel.line.clone());
            }
        })
        .build(k)
        .key("copy-line");
    let header = row()
        .w_full()
        .min_h(28.0)
        .gap(8.0)
        .center_y()
        // Keyed, so an event with no verdict never draws its title in the
        // element the last event's badge was, with the badge's fill.
        .children(r.verdict().map(|v| badge(t, v).key("verdict")))
        .child(
            text(r.title().to_string())
                .key("title")
                .font(ty::TITLE)
                .color(t.text)
                .wrap_anywhere()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .child(copy)
        .child(replay_button);
    let mut c = col()
        .w_full()
        .pt(10.0)
        .pr(16.0)
        .pb(16.0)
        .pl(16.0)
        .gap(14.0)
        .child(header)
        .children(replay.map(|rp| replay_card(rp, r, t)));
    if let Some(input) = &r.input {
        c = c.child(block(input.clone(), t.card, t.card_border, t));
    }
    if let Some(to) = r.rewrite() {
        c = c.child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(
                    text("→")
                        .font(ty::MONO)
                        .color(t.text_secondary)
                        .label("becomes"),
                )
                .child(
                    text(to.to_string())
                        .font(ty::MONO)
                        .color(t.rewrite_text())
                        .wrap_anywhere()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0),
                ),
        );
    }
    let verdict = r.verdict();
    let notes: Vec<(&str, &str)> = r
        .handlers
        .iter()
        .filter(|h| {
            h.outcome.as_deref().is_some()
                && h.outcome.as_deref() == verdict
                && h.outcome.as_deref() != Some("rewrite")
        })
        .filter_map(|h| Some((h.name.as_str(), h.note.as_deref()?)))
        .collect();
    if !notes.is_empty() {
        let mut list = col()
            .w_full()
            .radius(8.0)
            .fill(t.card)
            .border(1.0, t.card_border)
            .clip_rounded(8.0);
        for (i, (name, note)) in notes.into_iter().enumerate() {
            if i > 0 {
                list = list.child(rule(t));
            }
            list = list.child(
                col()
                    .w_full()
                    .px(12.0)
                    .py(8.0)
                    .gap(2.0)
                    .child(
                        text(name.to_string())
                            .font(ty::MONO_LABEL)
                            .color(t.text_secondary),
                    )
                    .child(
                        text(note.to_string())
                            .font(ty::NOTE)
                            .color(t.text)
                            .wrap_anywhere()
                            .selectable(true),
                    ),
            );
        }
        c = c.child(list);
    }
    let errs: Vec<String> = r
        .handlers
        .iter()
        .filter_map(|h| {
            Some(format!(
                "{}: {}",
                h.name,
                h.stderr
                    .as_deref()
                    .filter(|e| !e.trim().is_empty())?
                    .trim_end()
            ))
        })
        .collect();
    if !errs.is_empty() {
        c = c.child(block(errs.join("\n"), t.warn_bg, t.warn_border, t));
    }
    let longest = r
        .handlers
        .iter()
        .filter_map(|h| h.ms)
        .max()
        .unwrap_or(1)
        .max(1);
    let handlers = r.handlers.iter().enumerate().map(|(i, h)| {
        let result = h.result();
        let tint = result.map_or(Tint::Gray, tint_of);
        let share = if h.is_async {
            0.0
        } else {
            (h.ms.unwrap_or(0) as f32 / longest as f32).max(0.03)
        };
        let bar = row()
            .h(6.0)
            .radius(3.0)
            .fill(t.fill)
            .grow(1.0)
            .min_w(24.0)
            .child(el().h(6.0).radius(3.0).fill(t.bar(tint)).grow(share))
            .child(el().h(6.0).grow(1.0 - share))
            .a11y_hidden();
        row()
            .key(format!("handler-{i}"))
            .w_full()
            .min_h(24.0)
            .gap(10.0)
            .center_y()
            .child(
                text(h.name.clone())
                    .font(ty::MONO)
                    .color(t.text)
                    .truncate()
                    .w(132.0)
                    .help(h.command.clone()),
            )
            .child(bar)
            .child(
                text(time_label(h))
                    .font(ty::MONO)
                    .color(t.text_secondary)
                    .align(Align::End)
                    .w(56.0),
            )
            .child(
                row()
                    .w(64.0)
                    .children(result.filter(|r| *r != "allow").map(|r| badge(t, r))),
            )
    });
    c.child(col().w_full().children(handlers))
}

/// A guard's result now, or, when it differs, its logged result and then its
/// result now: most guards say nothing either way, and one column keeps room
/// for their names.
fn change_cell(t: &Tokens, was: Option<&str>, is: Option<&str>) -> El {
    if was == is {
        return result_cell(t, is);
    }
    row()
        .gap(6.0)
        .center_y()
        .child(result_cell(t, was).label("logged"))
        .child(
            text("→")
                .font(ty::MONO)
                .color(t.text_secondary)
                .label("now"),
        )
        .child(result_cell(t, is))
}

/// A result word as a badge, or a dash when the handler said nothing.
fn result_cell(t: &Tokens, word: Option<&str>) -> El {
    row().children(Some(match word {
        Some(w) => badge(t, w),
        None => text("—")
            .font(ty::MONO)
            .color(t.text_secondary)
            .label("nothing"),
    }))
}

/// The replay beside the logged answer (`replay::Comparison`): the verdict
/// either way, then each built-in guard with its result now, or its logged
/// result and its result now when they differ, `off` for one you switched
/// off, and how long it took now; then the handlers that did not run.
fn replay_card(rp: &Replay, logged: &Record, t: &Tokens) -> El {
    let card = col()
        .key("replay-result")
        .role("group")
        .label("Replay")
        .w_full()
        .radius(8.0)
        .fill(t.card)
        .border(1.0, t.card_border)
        .clip_rounded(8.0);
    let now = match &rp.result {
        Ok(now) => now,
        Err(e) => {
            return card.child(
                col()
                    .w_full()
                    .px(12.0)
                    .py(10.0)
                    .gap(4.0)
                    .child(text("Replay failed").font(ty::LABEL).color(t.text))
                    .child(
                        text(e.clone())
                            .font(ty::NOTE)
                            .color(t.text_secondary)
                            .wrap_anywhere()
                            .selectable(true),
                    ),
            );
        }
    };
    let c = Comparison::of(logged, now, &rp.off);
    let head = row()
        .w_full()
        .min_h(32.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .child(
            text(c.summary())
                .font(ty::LABEL)
                .color(t.text)
                .wrap_anywhere()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .child(change_cell(t, c.was, c.is));
    let rows = c.lines.iter().enumerate().map(|(i, l)| {
        let name = short_name(l.command);
        let was = l.was.and_then(Handler::result);
        let is = match l.now {
            Some(h) => h.result(),
            None => Some("off"),
        };
        let line = row()
            .w_full()
            .min_h(24.0)
            .gap(8.0)
            .center_y()
            .child(
                text(name)
                    .font(ty::MONO)
                    .color(if l.now.is_some() {
                        t.text
                    } else {
                        t.text_secondary
                    })
                    .truncate()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .help(l.command.to_string()),
            )
            .child(change_cell(t, was, is))
            .child(
                text(l.now.map(time_label).unwrap_or_default())
                    .font(ty::MONO)
                    .color(t.text_secondary)
                    .align(Align::End)
                    .w(56.0),
            );
        let new_note = l
            .now
            .and_then(|h| h.note.as_deref())
            .filter(|n| l.was.and_then(|w| w.note.as_deref()) != Some(*n));
        col()
            .key(format!("replayed-{i}"))
            .w_full()
            .child(line)
            .children(new_note.map(|n| {
                text(n.to_string())
                    .font(ty::NOTE)
                    .color(t.text_secondary)
                    .wrap_anywhere()
                    .selectable(true)
                    .pb(4.0)
            }))
    });
    let names = |cs: &[&str]| {
        cs.iter()
            .map(|c| short_name(c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let off: Vec<&str> = rp.off.iter().map(String::as_str).collect();
    let foot = [
        (
            "Switched off: ",
            names(&off),
            "Off in state.json: shown, not run",
        ),
        (
            "Not replayed: ",
            names(&c.not_replayed),
            "Replay runs only the built-in guards",
        ),
    ]
    .into_iter()
    .filter(|(_, names, _)| !names.is_empty())
    .map(|(label, names, help)| {
        text(format!("{label}{names}"))
            .font(ty::NOTE)
            .color(t.text_secondary)
            .wrap_anywhere()
            .help(help)
    });
    let body = col()
        .w_full()
        .px(12.0)
        .pt(6.0)
        .pb(10.0)
        .gap(2.0)
        .children(rows)
        .child(el().h(2.0))
        .children(foot);
    card.child(head).child(rule(t)).child(body)
}
