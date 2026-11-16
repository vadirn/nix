//! Port of `pipe-allow.py`: allows a piped or chained Bash command when every
//! simple command in it matches a `Bash(...)` prefix in settings.json's
//! `permissions.allow`. Claude Code's own prefix matching handles one plain
//! command; this covers pipes, chains, leading comments and env prefixes
//! (anthropics/claude-code#29967).
//!
//! It never denies, so refusing only means Claude Code asks as usual. It
//! refuses whatever it cannot model: an env var that changes code loading, a
//! redirect other than a descriptor copy (`2>&1`), any substitution, a group
//! or compound command, and a quote or substitution left open.
//!
//! Differences that come from the shared parse, each one refusing more: a
//! prefix matches whole words of source text, so `"git" log` and `gitk` no
//! longer match `git`; a newline separates commands, so a second line is
//! checked rather than riding on the first; a substitution inside double
//! quotes refuses; and a single plain command is left to Claude Code even
//! when it ends in a newline.

use super::{Ctx, Verdict};
use crate::shell::{Origin, Segment, Word};

const SENSITIVE_VAR_PREFIXES: &[&str] = &[
    "PATH=",
    "LD_",
    "DYLD_",
    "PYTHONPATH=",
    "PYTHONHOME=",
    "NODE_PATH=",
    "GEM_PATH=",
    "GEM_HOME=",
    "RUBYLIB=",
    "PERL5LIB=",
    "CLASSPATH=",
    "GOPATH=",
];

pub fn check(ctx: &Ctx) -> Verdict {
    let Some(cmd) = ctx.command.filter(|c| !c.is_empty()) else {
        return Verdict::None;
    };
    let prefixes = allowed_prefixes(&ctx.settings);
    if prefixes.is_empty() {
        return Verdict::None;
    }
    let script = ctx.script();
    let segs = &script.segments;
    if script.incomplete || segs.is_empty() {
        return Verdict::None;
    }
    // One plain command: Claude Code's own matching handles it.
    if segs.len() == 1 && segs[0].assigns.is_empty() && !script.comments {
        return Verdict::None;
    }
    if segs.iter().all(|s| stage_allowed(s, cmd, &prefixes)) {
        return Verdict::Allow("All pipeline stages match allowed Bash prefixes".into());
    }
    Verdict::None
}

fn stage_allowed(s: &Segment, cmd: &str, prefixes: &[Vec<String>]) -> bool {
    if !s.keywords.is_empty() || s.grouped || s.depth > 0 || s.origin == Origin::Reparsed {
        return false;
    }
    if s.words.is_empty() {
        return false;
    }
    if s.assigns.iter().any(|a| {
        SENSITIVE_VAR_PREFIXES
            .iter()
            .any(|p| a.value.starts_with(p))
    }) {
        return false;
    }
    let targets = s.redirects.iter().filter_map(|r| r.target.as_ref());
    if s.words
        .iter()
        .chain(&s.assigns)
        .chain(targets)
        .any(|w| w.subst)
    {
        return false;
    }
    if !s.redirects.iter().all(|r| {
        r.op == ">&"
            && r.fd
                .as_deref()
                .is_none_or(|f| f.bytes().all(|b| b.is_ascii_digit()))
            && r.target.as_ref().is_some_and(|t| {
                !t.quoted
                    && (t.value == "-"
                        || (!t.value.is_empty() && t.value.bytes().all(|b| b.is_ascii_digit())))
            })
    }) {
        return false;
    }
    let src = |w: &Word| w.span.clone().and_then(|r| cmd.get(r)).unwrap_or("");
    prefixes
        .iter()
        .any(|p| p.len() <= s.words.len() && p.iter().zip(&s.words).all(|(pw, w)| src(w) == pw))
}

/// Each `Bash(...)` entry of `permissions.allow`, with a trailing `:*` or ` *`
/// cut, split into words.
fn allowed_prefixes(path: &std::path::Path) -> Vec<Vec<String>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(allow) = v
        .get("permissions")
        .and_then(|p| p.get("allow"))
        .and_then(|a| a.as_array())
    else {
        return Vec::new();
    };
    allow
        .iter()
        .filter_map(|e| e.as_str())
        .filter_map(|e| e.strip_prefix("Bash(")?.strip_suffix(')'))
        .filter(|p| !p.is_empty() && !p.contains('\n'))
        .map(|p| {
            let p = p
                .strip_suffix(":*")
                .or_else(|| p.strip_suffix(" *"))
                .unwrap_or(p);
            p.split_whitespace().map(String::from).collect::<Vec<_>>()
        })
        .filter(|words| !words.is_empty())
        .collect()
}
