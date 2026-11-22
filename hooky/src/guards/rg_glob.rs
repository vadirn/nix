//! Port of `rg-glob-guard.sh`: denies an `rg` call with a negated glob.
//!
//! The Claude Code Bash tool escapes every `!` as `\!`, even inside single
//! quotes, so rg reads a negated glob as a literal-`!` match: the exclusion
//! silently does nothing, and a glob set with no working positive glob
//! matches nothing. Verified 2026-06-11.
//!
//! The script found `rg` and the `-g` arguments with regexes over the whole
//! text. Here they are words of one simple command: the globs must belong to
//! the `rg` call, a quoted mention of rg no longer counts, and `--iglob` and
//! a cluster such as `-ig` are read too.

use super::{Ctx, Verdict, first_deny};
use crate::shell::{Script, Word};

const REASON: &str = "Blocked: the Bash tool escapes ! as \\! even inside quotes, so a negated rg glob reaches rg as a literal-! match. The exclusion silently no-ops; with no positive glob the search returns empty. Drop the glob (rg already skips .git and gitignored files by default), or construct the ! at runtime: -g \"$(printf '\\x21%s' \"*.lock\")\".";

pub fn check(ctx: &Ctx) -> Verdict {
    first_deny(&ctx.scripts(), |s| negated(s).then(|| REASON.to_string()))
}

fn negated(s: &Script) -> bool {
    s.segments.iter().any(|seg| {
        let Some(k) = seg.words.iter().position(|w| w.base() == "rg") else {
            return false;
        };
        let args = &seg.words[k + 1..];
        (0..args.len())
            .any(|j| glob_at(args, j).is_some_and(|g| g.starts_with('!') || g.starts_with("\\!")))
    })
}

/// The glob that the argument at `j` sets, if it sets one.
fn glob_at(args: &[Word], j: usize) -> Option<&str> {
    let v = args[j].value.as_str();
    let next = || args.get(j + 1).map(|w| w.value.as_str());
    if v == "--glob" || v == "--iglob" {
        return next();
    }
    if let Some(g) = v
        .strip_prefix("--glob=")
        .or_else(|| v.strip_prefix("--iglob="))
    {
        return Some(g);
    }
    if v.len() > 1 && v.starts_with('-') && !v.starts_with("--") {
        let at = v[1..].find('g')? + 1;
        let rest = &v[at + 1..];
        return if rest.is_empty() { next() } else { Some(rest) };
    }
    None
}
