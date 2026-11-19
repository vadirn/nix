//! The Handlers screen, laid out as the design canvas's Handlers artboard:
//! the hooks file's handlers, grouped by hook event and matcher, each with its
//! name, timeout, an async badge and a switch, and a status bar while any is
//! off. A hook event's page lists that event's groups beside its rows, as
//! the canvas's Event page does, each handler with what it did for the
//! picked row in place of its timeout.
//!
//! A switch writes `state.json` (`hooks.rs`), which route reads on every
//! event; the hooks file stays as written. Two parts differ from the
//! artboard: an off row's name is greyed but not struck through, since Rune's
//! text has no strikethrough, and the "Export to settings.json" button is
//! left out (decided 2026-11-17: the README's `route settings` recipe does
//! that, and this app writes only `state.json`).

use rune::{El, Icon, ScrollSpec, Transition, col, el, row, text};
use rune_kit::shell::Toolbar;
use rune_kit::{Button, ControlSize, IconButton, IconButtonVariant, Kit, Switch};

use crate::App;
use crate::hooks::{Group, HandlerId, seconds};
use crate::record::{Handler, Record, short_name};
use crate::theme::{Tint, Tokens, ty};
use crate::view::{badge, badge_in, group, leading, quiet_row, rule, time_label};

static FILE: Icon = Icon {
    name: "rc-file",
    view: 16.0,
    body: r#"<path d="M9 2.25H4.5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.75M9 2.25l3.5 3.5M9 2.25v3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>"#,
};

/// The widest the content runs, as the artboard sets it.
const CONTENT_W: f32 = 920.0;

pub fn toolbar(s: &App, k: &Kit, t: &Tokens) -> Toolbar {
    Toolbar::new()
        .leading(leading(s, t, "Handlers".to_string()))
        .trailing(open_hooks(k))
}

/// Opens the shown space's hooks file. It comes and goes at once: the
/// toolbar is not keyed by its space, as the screen is, and an exit keeps
/// the transition of its last render, before a switch.
pub fn open_hooks(k: &Kit) -> El {
    IconButton::new(&FILE)
        .variant(IconButtonVariant::GhostMuted)
        .label("Open hooks.json")
        .help("Open hooks.json")
        .on_press_tx(|s: &mut App, tx| s.open_hooks(tx))
        .build(k)
        .key("open-hooks")
        .transition(Transition::none())
}

/// The kit switches draw with: an off track as the artboard draws it,
/// tok.rs's `control_off`, since rune-kit's own sinks into the group's fill.
fn switch_kit(k: &Kit, t: &Tokens) -> Kit {
    let mut k = k.clone();
    k.c.layer_04 = t.control_off;
    k
}

pub fn screen(s: &App, k: &Kit, t: &Tokens) -> El {
    let k = &switch_kit(k, t);
    // Every event's groups under its name, as the Log lists every event.
    let blocks = s.space.events.iter().map(|e| event_block(s, k, t, e));
    let content = col()
        .w_full()
        .max_w(CONTENT_W)
        .pt(20.0)
        .px(24.0)
        .pb(24.0)
        .gap(28.0)
        .children(blocks);
    col()
        .key("handlers")
        .w_full()
        .h_full()
        .child(rule(t))
        .child(
            col()
                .key("handlers-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content),
        )
        .children(status(s, k, t))
}

fn event_block(s: &App, k: &Kit, t: &Tokens, event: &str) -> El {
    let title = row().px(4.0).child(
        text(event.to_string())
            .font(ty::TITLE)
            .color(t.text)
            .role("heading"),
    );
    col()
        .w_full()
        .gap(18.0)
        .child(title)
        .child(groups(s, k, t, event, None).gap(18.0))
}

/// One event's matcher groups, under its key, so a check finds them on
/// either screen.
fn groups(s: &App, k: &Kit, t: &Tokens, event: &str, ran: Option<&Record>) -> El {
    let groups = s.space.hooks.groups(event);
    let block = col()
        .key(format!("handlers-{event}"))
        .role("group")
        .label(format!("{event} handlers"))
        .w_full();
    if groups.is_empty() {
        return block.child(group(t, event, [quiet_row(t, "No handlers.")]));
    }
    groups.iter().enumerate().fold(block, |b, (gi, g)| {
        b.child(matcher_group(s, k, t, event, gi, g, ran))
    })
}

/// A hook event's handlers, beside its rows on its page: each with what it
/// did for `ran`, the picked row, and then whatever the row ran that the
/// hooks file no longer lists, which has no switch.
pub fn page_handlers(s: &App, k: &Kit, t: &Tokens, event: &str, ran: Option<&Record>) -> El {
    let k = &switch_kit(k, t);
    let listed =
        |h: &Handler| {
            s.space.hooks.groups(event).iter().any(|g| {
                g.matcher == h.matcher && g.handlers.iter().any(|e| e.command == h.command)
            })
        };
    let gone: Vec<&Handler> = ran
        .map(|r| r.handlers.iter().filter(|h| !listed(h)).collect())
        .unwrap_or_default();
    let gone = (!gone.is_empty()).then(|| {
        let rows = gone.into_iter().map(|h| {
            handler_row(t, &h.command, false)
                .children(did(t, h).into_iter().flatten())
                .child(text(time_label(h)).font(ty::MONO).color(t.text_secondary))
        });
        col()
            .key("handlers-gone")
            .w_full()
            .gap(6.0)
            .child(heading(t, "Not in hooks.json"))
            .child(group(t, "Not in hooks.json", rows))
    });
    col()
        .w_full()
        .gap(10.0)
        .child(heading(t, "Handlers"))
        .child(groups(s, k, t, event, ran).gap(14.0))
        .children(gone)
}

fn heading(t: &Tokens, words: &str) -> El {
    row().px(4.0).child(
        text(words.to_string())
            .font(ty::LABEL)
            .color(t.text_secondary)
            .role("heading"),
    )
}

/// A handler's row up to its trailing parts: its name, greyed while off.
fn handler_row(t: &Tokens, command: &str, off: bool) -> El {
    row()
        .w_full()
        .min_h(40.0)
        .pl(14.0)
        .pr(12.0)
        .gap(12.0)
        .center_y()
        .child(
            text(short_name(command))
                .font(ty::MONO_NAME)
                .color(if off { t.text_secondary } else { t.text })
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .help(command.to_string()),
        )
}

/// What a handler did for a row, as the Log's inspector badges it: stderr,
/// and its result unless it allowed.
fn did(t: &Tokens, h: &Handler) -> [Option<El>; 2] {
    let stderr = h.stderr.as_deref().is_some_and(|e| !e.trim().is_empty());
    [
        stderr.then(|| badge(t, "stderr")),
        h.result().filter(|r| *r != "allow").map(|r| badge(t, r)),
    ]
}

/// A matcher's handlers: the matcher as written above them, or nothing for a
/// group that sets none. A handler `ran` ran shows what it did and how long
/// it took, in place of its timeout.
fn matcher_group(
    s: &App,
    k: &Kit,
    t: &Tokens,
    event: &str,
    gi: usize,
    g: &Group,
    ran: Option<&Record>,
) -> El {
    let label = if g.matcher.is_empty() {
        "All handlers".to_string()
    } else {
        format!("Matcher {}", g.matcher)
    };
    let rows = g.handlers.iter().enumerate().map(|(hi, h)| {
        let id = HandlerId::new(event, &g.matcher, &h.command);
        let on = !s.space.toggles.is_off(&id);
        let verb = if on { "Disable" } else { "Enable" };
        let switch = Switch::new(on)
            .label(format!("{verb} {}", h.command))
            .hide_label()
            .control_size(ControlSize::Small)
            .on_toggle_tx(move |s: &mut App, tx| s.toggle(&id, !on, tx))
            .build(k)
            .key(format!("switch-{event}-{gi}-{hi}"));
        let logged = ran.and_then(|r| {
            r.handlers
                .iter()
                .find(|x| x.matcher == g.matcher && x.command == h.command)
        });
        let mono = |words: String, help: &str| {
            text(words)
                .font(ty::MONO)
                .color(t.text_secondary)
                .help(help.to_string())
        };
        let trailing = match logged {
            Some(x) => Some(mono(time_label(x), "Took, for the picked event")),
            None => h.timeout.map(|secs| mono(seconds(secs), "Timeout")),
        };
        // A logged async handler's result reads `async` already.
        let async_badge =
            (h.is_async && logged.is_none()).then(|| badge_in(t, "async", Tint::Orange));
        handler_row(t, &h.command, !on)
            .key(format!("handler-{event}-{gi}-{hi}"))
            .children(logged.map(|x| did(t, x)).into_iter().flatten().flatten())
            .children(async_badge)
            .children(trailing)
            .child(switch)
    });
    col()
        .w_full()
        .gap(6.0)
        .children((!g.matcher.is_empty()).then(|| {
            row().px(4.0).child(
                text(g.matcher.clone())
                    .font(ty::MONO_LABEL)
                    .color(t.text_secondary)
                    .wrap_anywhere()
                    .role("heading"),
            )
        }))
        .child(group(t, &label, rows))
}

/// "N disabled" and "Enable all", while any handler the hooks file lists is
/// off.
pub fn status(s: &App, k: &Kit, t: &Tokens) -> Option<El> {
    let off = s.space.toggles.off_in(&s.space.hooks);
    (off > 0).then(|| {
        let enable = Button::new("Enable all")
            .on_press_tx(|s: &mut App, tx| s.enable_all(tx))
            .build(k)
            .key("enable-all");
        col().key("status").w_full().child(rule(t)).child(
            row()
                .role("status")
                .w_full()
                .min_h(44.0)
                .pl(16.0)
                .pr(10.0)
                .py(6.0)
                .gap(12.0)
                .center_y()
                .fill(t.group)
                .child(
                    text(format!("{off} disabled"))
                        .font(ty::SMALL)
                        .color(t.text_secondary),
                )
                .child(el().grow(1.0))
                .child(enable),
        )
    })
}
