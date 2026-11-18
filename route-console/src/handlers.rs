//! The Handlers screen, laid out as the design canvas's Handlers artboard:
//! the hooks file's handlers, grouped by hook event and matcher, each with its
//! name, timeout, an async badge and a switch, and a status bar while any is
//! off.
//!
//! A switch writes `state.json` (`hooks.rs`), which route reads on every
//! event; the hooks file stays as written. Two parts differ from the
//! artboard: an off row's name is greyed but not struck through, since Rune's
//! text has no strikethrough, and the "Export to settings.json" button is
//! left out (decided 2026-11-17: the README's `route settings` recipe does
//! that, and this app writes only `state.json`).

use rune::{El, Icon, ScrollSpec, col, el, row, text};
use rune_kit::shell::Toolbar;
use rune_kit::{Button, ControlSize, IconButton, IconButtonVariant, Kit, Switch};

use crate::App;
use crate::hooks::{Group, HandlerId, seconds};
use crate::record::short_name;
use crate::theme::{Tint, Tokens, ty};
use crate::view::{badge_in, group, leading, quiet_row, rule};

static FILE: Icon = Icon {
    name: "rc-file",
    view: 16.0,
    body: r#"<path d="M9 2.25H4.5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.75M9 2.25l3.5 3.5M9 2.25v3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>"#,
};

/// The widest the content runs, as the artboard sets it.
const CONTENT_W: f32 = 920.0;

pub fn toolbar(s: &App, k: &Kit, t: &Tokens) -> Toolbar {
    let title = s
        .space
        .handlers_event
        .clone()
        .unwrap_or_else(|| "Handlers".to_string());
    let open = IconButton::new(&FILE)
        .variant(IconButtonVariant::GhostMuted)
        .label("Open hooks.json")
        .help("Open hooks.json")
        .on_press_tx(|s: &mut App, tx| s.open_hooks(tx))
        .build(k)
        .key("open-hooks");
    Toolbar::new().leading(leading(s, t, title)).trailing(open)
}

pub fn screen(s: &App, k: &Kit, t: &Tokens) -> El {
    // An off switch's track as the artboard draws it, tok.rs's `control_off`:
    // rune-kit's own sinks into the group's fill.
    let mut k = k.clone();
    k.c.layer_04 = t.control_off;
    let k = &k;
    // One hook event lists its groups; none lists every event's under its
    // name, as the Log with no event lists every event.
    let blocks: Vec<El> = match &s.space.handlers_event {
        Some(e) => vec![event_block(s, k, t, e, false)],
        None => s
            .space
            .events
            .iter()
            .map(|e| event_block(s, k, t, e, true))
            .collect(),
    };
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

fn event_block(s: &App, k: &Kit, t: &Tokens, event: &str, titled: bool) -> El {
    let groups = s.space.hooks.groups(event);
    let mut block = col()
        .key(format!("handlers-{event}"))
        .role("group")
        .label(event.to_string())
        .w_full()
        .gap(18.0);
    if titled {
        block = block.child(
            row().px(4.0).child(
                text(event.to_string())
                    .font(ty::TITLE)
                    .color(t.text)
                    .role("heading"),
            ),
        );
    }
    if groups.is_empty() {
        return block.child(group(t, event, [quiet_row(t, "No handlers.")]));
    }
    groups.iter().enumerate().fold(block, |b, (gi, g)| {
        b.child(matcher_group(s, k, t, event, gi, g))
    })
}

/// A matcher's handlers: the matcher as written above them, or nothing for a
/// group that sets none.
fn matcher_group(s: &App, k: &Kit, t: &Tokens, event: &str, gi: usize, g: &Group) -> El {
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
        let name = short_name(&h.command);
        row()
            .key(format!("handler-{event}-{gi}-{hi}"))
            .w_full()
            .min_h(40.0)
            .pl(14.0)
            .pr(12.0)
            .gap(12.0)
            .center_y()
            .child(
                text(name)
                    .font(ty::MONO_NAME)
                    .color(if on { t.text } else { t.text_secondary })
                    .truncate()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .help(h.command.clone()),
            )
            .children(h.timeout.map(|secs| {
                text(seconds(secs))
                    .font(ty::MONO)
                    .color(t.text_secondary)
                    .help("Timeout")
            }))
            .children(h.is_async.then(|| badge_in(t, "async", Tint::Orange)))
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
fn status(s: &App, k: &Kit, t: &Tokens) -> Option<El> {
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
