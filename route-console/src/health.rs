//! The Health screen, laid out as the design canvas's Health artboard: today's
//! issues, the time a Bash call waits on its hooks, and how much the log keeps.
//!
//! Every number comes from the log or the hooks file, so three parts differ
//! from the artboard, whose numbers came from a memo's hyperfine runs. The
//! times are today's middle values, and route's own share is what each call
//! took beyond its slowest handler, not route run alone; the shell baseline,
//! which the log never sees, is left out. The log limits are shown, not set:
//! this app never writes `hooks.json`.

use rune::{El, Icon, ScrollSpec, col, el, icon, row, text, tok};
use rune_kit::shell::Toolbar;
use rune_kit::{IconButton, IconButtonVariant, Kit};

use crate::index::{Issue, Timing};
use crate::record::Trouble;
use crate::theme::{Tint, Tokens, ty};
use crate::view::{block, group, leading, ms_label, quiet_row};
use crate::{App, Limits};

static REBUILD: Icon = Icon {
    name: "rc-rebuild",
    view: 16.0,
    body: r#"<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};
static CHEVRON: Icon = Icon {
    name: "rc-chevron",
    view: 16.0,
    body: r#"<path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#,
};
static SIGN: Icon = Icon {
    name: "rc-sign",
    view: 16.0,
    body: r#"<path d="M8 2 14.5 13.5h-13z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><path d="M8 6.5v3M8 11.5h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>"#,
};

/// The widest the content runs, as the artboard sets it.
const CONTENT_W: f32 = 820.0;
/// How many lines of an issue's stderr show.
const DETAIL_LINES: usize = 3;

fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

/// `2000` reads `2,000`.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// What an issue says happened, in the numbers the Log lists for it.
pub fn issue_title(i: &Issue) -> String {
    let n = i.events;
    let on = |event: &str| plural(n, &format!("{event} event"));
    match i.key.kind {
        Trouble::Failed if i.key.event == "PreToolUse" => {
            let calls = plural(n, "call");
            match i.let_through {
                k if k == n => format!("{} fails open: {calls} let through", i.name),
                0 => format!("{} failed on {calls}, none let through", i.name),
                k => format!("{} failed on {calls}, {k} let through", i.name),
            }
        }
        Trouble::Failed => format!("{} failed on {}", i.name, on(&i.key.event)),
        Trouble::Stderr => format!("{} wrote to stderr on {}", i.name, on(&i.key.event)),
    }
}

/// The last time's stderr, cut to its first few lines.
fn detail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= DETAIL_LINES {
        return text.to_string();
    }
    format!("{}\n…", lines[..DETAIL_LINES].join("\n"))
}

pub fn toolbar(s: &App, k: &Kit, t: &Tokens) -> Toolbar {
    let rebuild = IconButton::new(&REBUILD)
        .variant(IconButtonVariant::GhostMuted)
        .label("Rebuild index")
        .help("Rebuild index")
        .on_press_tx(|s: &mut App, tx| s.rebuild(tx))
        .build(k)
        .key("rebuild");
    Toolbar::new()
        .leading(leading(s, t, "Health".to_string()))
        .trailing(rebuild)
}

pub fn screen(s: &App, k: &Kit, t: &Tokens) -> El {
    let content = col()
        .w_full()
        .max_w(CONTENT_W)
        .pt(20.0)
        .px(24.0)
        .pb(24.0)
        .gap(24.0)
        .child(issues(&s.space.health.issues, k, t))
        .child(timing(&s.space.health.timing, t))
        .child(limits(&s.space.limits, t));
    col()
        .key("health")
        .w_full()
        .h_full()
        .child(el().w_full().h(1.0).fill(t.separator).a11y_hidden())
        .child(
            col()
                .key("health-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content),
        )
}

fn section_title(t: &Tokens, title: &str) -> El {
    row().px(4.0).child(
        text(title.to_string())
            .font(ty::SECTION)
            .color(t.text_secondary)
            .role("heading"),
    )
}

fn issues(issues: &[Issue], k: &Kit, t: &Tokens) -> El {
    if issues.is_empty() {
        return group(t, "Issues", [quiet_row(t, "No issues today.")]).key("issues");
    }
    let rows = issues.iter().enumerate().map(|(n, i)| {
        let tint = match i.key.kind {
            Trouble::Failed => Tint::Pink,
            Trouble::Stderr => Tint::Orange,
        };
        let key = i.key.clone();
        let show = IconButton::new(&CHEVRON)
            .variant(IconButtonVariant::GhostMuted)
            .label("Show events")
            .help("Show events")
            .on_press_tx(move |s: &mut App, tx| s.show_issue(key.clone(), tx))
            .build(k)
            .key(format!("show-issue-{n}"));
        row()
            .key(format!("issue-{n}"))
            .w_full()
            .pt(6.0)
            .pb(6.0)
            .pl(14.0)
            .pr(8.0)
            .gap(12.0)
            .child(icon(&SIGN, 18.0).color(t.sign(tint)).mt(5.0).a11y_hidden())
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .pt(6.0)
                    .gap(8.0)
                    .child(
                        text(issue_title(i))
                            .font(ty::TITLE)
                            .color(t.text)
                            .wrap_anywhere()
                            .role("heading"),
                    )
                    .child(block(detail(&i.detail), t.warn_bg, t.warn_border, t)),
            )
            .child(show)
    });
    group(t, "Issues", rows).key("issues")
}

/// One bar of the timing list: a label, its share of the longest, the value.
fn bar(
    t: &Tokens,
    label: String,
    help: Option<&str>,
    ms: u64,
    longest: u64,
    fill: rune::Color,
) -> El {
    let share = (ms as f32 / longest.max(1) as f32).clamp(0.02, 1.0);
    let name = text(label.clone()).font(ty::BODY).color(t.text).truncate();
    let name = match help {
        Some(h) => name.help(h.to_string()),
        None => name.help_when_truncated(label.clone()),
    };
    row()
        .w_full()
        .min_h(36.0)
        .px(14.0)
        .gap(12.0)
        .center_y()
        .label(format!("{label}: {}", ms_label(ms)))
        .child(row().w(220.0).shrink().min_w(0.0).child(name))
        .child(
            row()
                .h(6.0)
                .radius(3.0)
                .fill(t.fill)
                .grow(1.0)
                .min_w(24.0)
                .child(el().h(6.0).radius(3.0).fill(fill).grow(share))
                .child(el().h(6.0).grow(1.0 - share))
                .a11y_hidden(),
        )
        .child(
            text(ms_label(ms))
                .font(ty::MONO)
                .color(t.text)
                .align(rune::Align::End)
                .w(64.0)
                .a11y_hidden(),
        )
}

fn timing(timing: &Timing, t: &Tokens) -> El {
    let title = section_title(t, "Median time per Bash event");
    if timing.events == 0 {
        let none = group(t, "Bash timings", [quiet_row(t, "No Bash events today.")]);
        return col()
            .key("timing")
            .w_full()
            .gap(6.0)
            .child(title)
            .child(none);
    }
    let route = tok::accent(0, t.dark);
    let handler = t.bar(Tint::Gray);
    let longest = timing
        .handlers
        .iter()
        .map(|h| h.1)
        .chain([timing.total, timing.overhead])
        .max()
        .unwrap_or(1);
    let mut rows = vec![bar(
        t,
        "route overhead".into(),
        Some(
            "Each call's time less its slowest handler's: what route adds, its handlers running side by side",
        ),
        timing.overhead,
        longest,
        route,
    )];
    rows.extend(
        timing
            .handlers
            .iter()
            .map(|(name, ms)| bar(t, name.clone(), None, *ms, longest, handler)),
    );
    rows.push(bar(
        t,
        format!("route + {}", plural(timing.handlers.len(), "handler")),
        Some("route's whole run: what each Bash call waited"),
        timing.total,
        longest,
        route,
    ));
    col()
        .key("timing")
        .w_full()
        .gap(6.0)
        .child(title)
        .child(group(t, "Bash timings", rows))
}

fn limits(l: &Limits, t: &Tokens) -> El {
    let keep = match l.retention_days {
        0 => "Forever".to_string(),
        d => plural(d as usize, "day"),
    };
    let setting = |label: &str, value: String| {
        row()
            .w_full()
            .min_h(44.0)
            .px(14.0)
            .gap(12.0)
            .center_y()
            .label(format!("{label}: {value}"))
            .child(
                text(label.to_string())
                    .font(ty::BODY)
                    .color(t.text)
                    .grow(1.0)
                    .a11y_hidden(),
            )
            .child(
                text(value)
                    .font(ty::BODY)
                    .color(t.text_secondary)
                    .help("Set in hooks.json, under route.log")
                    .a11y_hidden(),
            )
    };
    group(
        t,
        "Log limits",
        [
            setting("Keep logs for", keep),
            setting(
                "Keep tool input up to",
                format!("{} characters", thousands(l.max_input_chars)),
            ),
            setting(
                "Keep handler output up to",
                format!("{} characters", thousands(l.max_output_chars)),
            ),
        ],
    )
    .key("limits")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IssueKey;

    fn issue(kind: Trouble, event: &str, events: usize, let_through: usize) -> Issue {
        Issue {
            key: IssueKey {
                kind,
                command: "bash ~/.claude/hooks/no-secrets.sh".into(),
                event: event.into(),
            },
            name: "no-secrets.sh".into(),
            events,
            let_through,
            detail: String::new(),
        }
    }

    #[test]
    fn titles_name_the_rows_the_log_lists() {
        let f = Trouble::Failed;
        assert_eq!(
            issue_title(&issue(f, "PreToolUse", 209, 209)),
            "no-secrets.sh fails open: 209 calls let through"
        );
        assert_eq!(
            issue_title(&issue(f, "PreToolUse", 3, 2)),
            "no-secrets.sh failed on 3 calls, 2 let through"
        );
        assert_eq!(
            issue_title(&issue(f, "PreToolUse", 1, 0)),
            "no-secrets.sh failed on 1 call, none let through"
        );
        assert_eq!(
            issue_title(&issue(f, "Stop", 1, 0)),
            "no-secrets.sh failed on 1 Stop event"
        );
        assert_eq!(
            issue_title(&issue(Trouble::Stderr, "Stop", 2, 0)),
            "no-secrets.sh wrote to stderr on 2 Stop events"
        );
    }

    #[test]
    fn numbers_and_details_read_short() {
        assert_eq!(thousands(2000), "2,000");
        assert_eq!(thousands(500), "500");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(detail("a\nb"), "a\nb");
        assert_eq!(detail("a\nb\nc\nd"), "a\nb\nc\n…");
    }
}
