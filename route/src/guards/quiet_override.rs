//! Port of `quiet-override.sh`: rewrites a verbose command to its quiet form
//! (`git commit` → `git commit -q`) through `updatedInput`, to save tokens.
//!
//! As in the script, only a command that starts on the first line is
//! rewritten, the first rule that applies wins, and it rewrites the first
//! command it matches. The script tested regexes on the raw line; here the
//! command and subcommand are whole words, so `git commit-tree` and
//! `docker buildx` no longer match, a quiet flag counts only as a word of the
//! matched command, and the flag goes in right after the subcommand word.

use super::{Ctx, Verdict};
use crate::shell::{Op, Segment, Word};

pub fn check(ctx: &Ctx) -> Verdict {
    let Some(cmd) = ctx.command else {
        return Verdict::None;
    };
    let script = ctx.script();
    if script.incomplete {
        return Verdict::None;
    }
    let line1 = cmd.find('\n').unwrap_or(cmd.len());
    // Commands starting on the first line, in source order, with spans.
    let mut first_line: Vec<&Segment> = script
        .segments
        .iter()
        .filter(|s| s.start.is_some_and(|p| p < line1))
        .collect();
    first_line.sort_by_key(|s| s.start);
    // The script's `^` rules: the command the whole input opens with.
    let head = script
        .segments
        .iter()
        .find(|s| s.depth == 0)
        .filter(|s| !s.grouped && s.start.is_some_and(|p| p < line1));
    // The script skipped the `^` rules when the line held a pipe, an `&`, or
    // a `>` anywhere.
    let busy = first_line.iter().any(|s| {
        matches!(
            s.op,
            Some(Op::Pipe | Op::PipeAll | Op::Or | Op::And | Op::Amp)
        ) || s.redirects.iter().any(|r| r.op.contains(['>', '&']))
    });
    let piped = first_line
        .iter()
        .any(|s| matches!(s.op, Some(Op::Pipe | Op::PipeAll | Op::Or)));

    let insert = |w: &Word, text: &str| -> Verdict {
        let at = w.span.as_ref().map_or(0, |r| r.end);
        let out = format!("{}{text}{}", &cmd[..at], &cmd[at..]);
        Verdict::Rewrite(out.trim_end_matches('\n').to_string())
    };

    // git commit|clone|fetch|pull, at any command position on the line.
    if let Some(s) = first_line
        .iter()
        .find(|s| name(s, 0) == "git" && ["commit", "clone", "fetch", "pull"].contains(&name(s, 1)))
        && !quiet(s, 'q', &["--quiet"])
    {
        return insert(&s.words[1], " -q");
    }

    if let Some(s) = head {
        let w0 = name(s, 0);
        let w1 = name(s, 1);
        if w0 == "npm"
            && ["install", "i", "ci"].contains(&w1)
            && !busy
            && !quiet(s, '\0', &["--silent", "--quiet"])
        {
            return insert(&s.words[1], " --silent");
        }
        if w0 == "cargo" && w1 == "build" && !busy && !quiet(s, 'q', &["--quiet"]) {
            return insert(&s.words[1], " -q");
        }
        if w0 == "make" && !busy && !quiet(s, 's', &["--silent", "--quiet"]) {
            return insert(&s.words[0], " -s");
        }
    }

    // pip install|download: opening the line, or after `python -m`.
    let pip = |s: &Segment| -> Option<usize> {
        let w = &s.words;
        let is_pip = |k: usize| matches!(name(s, k), "pip" | "pip3");
        let is_verb = |k: usize| matches!(name(s, k), "install" | "download");
        if head.is_some_and(|h| std::ptr::eq(h, s)) && is_pip(0) && is_verb(1) {
            return Some(1);
        }
        (0..w.len().saturating_sub(3)).find_map(|k| {
            (matches!(w[k].base(), "python" | "python3")
                && name(s, k + 1) == "-m"
                && is_pip(k + 2)
                && is_verb(k + 3))
            .then_some(k + 3)
        })
    };
    if let Some((s, k)) = first_line.iter().find_map(|s| pip(s).map(|k| (s, k)))
        && !quiet(s, 'q', &["--quiet"])
    {
        return insert(&s.words[k], " -q");
    }

    if let Some(s) = head {
        if name(s, 0) == "wget"
            && s.words.len() >= 2
            && !quiet(s, 'q', &["--quiet"])
            && !quiet(s, 'O', &[])
        {
            return insert(&s.words[0], " -q");
        }
        if name(s, 0) == "docker"
            && ["build", "pull"].contains(&name(s, 1))
            && !piped
            && !quiet(s, 'q', &["--quiet"])
        {
            return insert(&s.words[1], " -q");
        }
    }

    // ffmpeg at any command position on the line.
    if let Some(s) = first_line
        .iter()
        .find(|s| name(s, 0) == "ffmpeg" && s.words.len() >= 2)
        && !s.words.iter().any(|w| w.value == "-nostats")
    {
        return insert(&s.words[0], " -nostats -loglevel error");
    }
    Verdict::None
}

/// The command already carries a quiet flag: one of `longs`, or a short
/// cluster (`-q`, `-sq`) holding `letter`.
fn quiet(s: &Segment, letter: char, longs: &[&str]) -> bool {
    s.words.iter().skip(1).any(|w| {
        let v = w.value.as_str();
        longs.contains(&v)
            || (letter != '\0'
                && v.len() > 1
                && v.starts_with('-')
                && !v.starts_with("--")
                && v[1..].contains(letter))
    })
}

/// The value of word `k`, or "" past the end.
fn name(s: &Segment, k: usize) -> &str {
    s.words.get(k).map_or("", |w| w.value.as_str())
}
