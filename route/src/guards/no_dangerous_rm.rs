//! Port of `no-dangerous-rm.py`: denies a recursive `rm` whose target lies
//! outside the project (the event's `cwd`).
//!
//! Fail-safe as the script was: where the true target is unknowable (an
//! expansion in the path, or a `cd` earlier in the command), it denies.
//! Differences that come from the shared parse: `rm` is any word whose last
//! path component is `rm` (`/bin/rm` counts), commands inside `$(...)` are
//! checked, and a `cd` inside a `( )` group counts.

use super::{Ctx, Verdict, first_deny};
use crate::shell::{Script, Word};

pub fn check(ctx: &Ctx) -> Verdict {
    if ctx.cwd.is_empty() {
        return Verdict::None;
    }
    let cwd = normpath(ctx.cwd);
    first_deny(&ctx.scripts(), |s| scan(s, &cwd, &ctx.home))
}

fn scan(s: &Script, cwd: &str, home: &str) -> Option<String> {
    let mut seen_cd = false;
    for seg in &s.segments {
        if matches!(
            seg.words.first().map(|w| w.value.as_str()),
            Some("cd" | "pushd")
        ) {
            seen_cd = true;
        }
        let Some(k) = seg.words.iter().position(|w| w.base() == "rm") else {
            continue;
        };
        if let Some(reason) = check_rm(&seg.words[k + 1..], seen_cd, cwd, home) {
            return Some(reason);
        }
    }
    None
}

fn check_rm(args: &[Word], seen_cd: bool, cwd: &str, home: &str) -> Option<String> {
    let mut flags = Vec::new();
    let mut paths = Vec::new();
    let mut end_opts = false;
    for a in args {
        let t = a.value.as_str();
        if !end_opts && t == "--" {
            end_opts = true;
            continue;
        }
        if !end_opts && t.len() > 1 && t.starts_with('-') {
            flags.push(t);
        } else {
            paths.push(a);
        }
    }
    // Recursive is --recursive, or a short cluster holding r or R: rm has no
    // other short flag with either letter.
    let recursive = flags
        .iter()
        .any(|f| *f == "--recursive" || (!f.starts_with("--") && f.contains(['r', 'R'])));
    if !recursive {
        return None;
    }
    if seen_cd {
        return Some(
            "Blocked: recursive rm after a `cd` — the effective directory can't be verified. Run it manually if intended."
                .into(),
        );
    }
    for p in paths {
        let v = p.value.as_str();
        if v.contains('$') || p.expands {
            return Some(format!(
                "Blocked: recursive rm with an unexpanded variable in the path ({v}). Target can't be verified; run it manually if intended."
            ));
        }
        let mut ep = expanduser(v, home);
        if !ep.starts_with('/') {
            ep = join(cwd, &ep);
        }
        let ep = normpath(&ep);
        // The trailing slash keeps /nix from matching /nix_evil.
        if !format!("{ep}/").starts_with(&format!("{cwd}/")) {
            return Some(format!(
                "rm -rf outside project directory is blocked. Target: {ep}"
            ));
        }
    }
    None
}

/// `posixpath.join` for two parts.
pub(super) fn join(a: &str, b: &str) -> String {
    if b.starts_with('/') {
        b.to_string()
    } else if a.is_empty() || a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a}/{b}")
    }
}

/// `posixpath.normpath`: lexical, never touching the disk. Exactly two
/// leading slashes survive, as POSIX leaves them implementation-defined.
pub fn normpath(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let initial = if path.starts_with("//") && !path.starts_with("///") {
        2
    } else if path.starts_with('/') {
        1
    } else {
        0
    };
    let mut comps: Vec<&str> = Vec::new();
    for comp in path.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp != ".." || (initial == 0 && comps.is_empty()) || comps.last() == Some(&"..") {
            comps.push(comp);
        } else if !comps.is_empty() {
            comps.pop();
        }
    }
    let joined = format!("{}{}", "/".repeat(initial), comps.join("/"));
    if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

/// `posixpath.expanduser`: `~` and `~/…` from `$HOME`, `~user` from the
/// password database, anything else unchanged.
pub(super) fn expanduser(path: &str, home: &str) -> String {
    let Some(rest) = path.strip_prefix('~') else {
        return path.to_string();
    };
    let cut = rest.find('/').unwrap_or(rest.len());
    let (user, tail) = rest.split_at(cut);
    let dir = if user.is_empty() {
        home.to_string()
    } else {
        match user_home(user) {
            Some(d) => d,
            None => return path.to_string(),
        }
    };
    let dir = dir.trim_end_matches('/');
    let out = format!("{dir}{tail}");
    if out.is_empty() { "/".into() } else { out }
}

fn user_home(user: &str) -> Option<String> {
    let name = std::ffi::CString::new(user).ok()?;
    // SAFETY: getpwnam(3) reads a NUL-terminated name and returns a pointer
    // into static storage or null; pw_dir is copied out before any other
    // passwd call can overwrite it.
    unsafe {
        let pw = libc::getpwnam(name.as_ptr());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr((*pw).pw_dir)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normpath_matches_python() {
        for (input, want) in [
            ("", "."),
            ("/", "/"),
            ("//", "//"),
            ("///", "/"),
            ("//a/../b", "//b"),
            ("/a/./b/../../..", "/"),
            ("a/../..", ".."),
            ("../../x", "../../x"),
            ("/Users/vadim/nix/", "/Users/vadim/nix"),
            ("a//b/", "a/b"),
        ] {
            assert_eq!(normpath(input), want, "{input}");
        }
    }

    #[test]
    fn expanduser_matches_python() {
        assert_eq!(expanduser("~", "/h/"), "/h");
        assert_eq!(expanduser("~/x", "/h"), "/h/x");
        assert_eq!(expanduser("x/~", "/h"), "x/~");
        assert_eq!(
            expanduser("~no-such-user-route/x", "/h"),
            "~no-such-user-route/x"
        );
        assert_eq!(expanduser("~", "/"), "/");
    }
}
